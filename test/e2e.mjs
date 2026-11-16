// Test de bout en bout dans un vrai Chromium avec l'extension chargée (Playwright).
//
// Prérequis : deux serveurs statiques à la racine de l'extension
//   python3 -m http.server 8001 & python3 -m http.server 8002 &
// et playwright-core installé quelque part :
//   PW_CORE=/chemin/node_modules/playwright-core CHROME=/chemin/chrome node test/e2e.mjs [--online]
// --online : lance aussi des recherches réelles sur les sites de sous-titres (quelques requêtes).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const { chromium } = await import(process.env.PW_CORE || 'playwright-core');
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'subs-ext-shots');
const ONLINE = process.argv.includes('--online');
fs.mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log(...a);
let failures = 0;
function check(cond, label, extra = '') {
  log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'subs-ext-profile-')), {
  executablePath: process.env.CHROME,
  headless: false, // on passe --headless=new nous-mêmes (les extensions n'existent pas dans l'ancien headless)
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1000, height: 800 },
});
let [sw] = ctx.serviceWorkers();
sw ||= await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
log(`extension ${extId}`);

const tabIdOf = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, url);
const frameState = (tabId, frameId = 0) => sw.evaluate(([t, f]) => chrome.tabs.sendMessage(t, { type: 'get-state' }, { frameId: f }), [tabId, frameId]);
const swCall = (msg) => sw.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)).catch((e) => ({ err: e.message })), msg);


/** Attente par sondage (les pages d'extension interdisent eval : pas de waitForFunction). */
async function waitFor(fn, timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeout) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 150));
  }
}
const msgMatches = (p, re) => async () => re.test(await p.textContent('#message'));

async function openPopup(tabId) {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
  await waitFor(async () => (await p.textContent('#videoStatus')) !== '…');
  return p;
}

async function seek(page, t, sel = '#v1') {
  await page.evaluate(([s, time]) => new Promise((r) => {
    const v = document.querySelector(s);
    v.pause();
    v.addEventListener('seeked', () => setTimeout(r, 150), { once: true });
    v.currentTime = time;
  }), [sel, t]);
}

// ---------------------------------------------------------------------------
log('\n1. Vidéo directe + fichier local Windows-1252');
const page = await ctx.newPage();
await page.goto('http://localhost:8001/test/index.html');
await page.waitForFunction(() => document.getElementById('v1').readyState >= 1);
await page.waitForTimeout(800);
const tabA = await tabIdOf('http://localhost:8001/test/index.html');

let popup = await openPopup(tabA);
check((await popup.textContent('#videoStatus')).startsWith('Vidéo détectée'), 'popup : vidéo détectée', await popup.textContent('#videoStatus'));
check((await popup.inputValue('#title')) === 'Big Buck Bunny' && (await popup.inputValue('#season')) === '1', 'popup : détection pré-remplie', `${await popup.inputValue('#title')} S${await popup.inputValue('#season')}E${await popup.inputValue('#episode')}`);
await popup.setInputFiles('#file', path.join(EXT, 'test/media/test-cp1252.srt'));
await waitFor(msgMatches(popup, /Appliqué|Erreur/));
check(/Appliqué/.test(await popup.textContent('#message')), 'fichier local appliqué', await popup.textContent('#message'));
await popup.screenshot({ path: `${SHOTS}/01-popup.png` });

await page.bringToFront();
await seek(page, 4.5);
let st = await frameState(tabA);
check(st.hasSubs && st.offset === 0, 'content : sous-titres chargés', JSON.stringify(st));
await page.screenshot({ path: `${SHOTS}/02-overlay-italique.png` });
await seek(page, 8);
await page.screenshot({ path: `${SHOTS}/03-overlay-accents.png` });

log('\n2. Raccourcis clavier');
await page.click('h1');
await page.keyboard.press('h');
await page.keyboard.press('h');
await page.keyboard.press('Shift+G');
st = await frameState(tabA);
check(st.offset === -0.8, 'H, H, Maj+G → −0,8 s', String(st.offset));
await page.waitForTimeout(100);
await page.screenshot({ path: `${SHOTS}/04-toast-decalage.png` });
await page.click('input');
await page.keyboard.type('gh');
st = await frameState(tabA);
check(st.offset === -0.8 && (await page.inputValue('input')) === 'gh', 'touches ignorées dans un champ de saisie');
await page.click('h1');
await page.keyboard.press('v');
st = await frameState(tabA);
check(st.visible === false, 'V masque');
await page.keyboard.press('v');
const offsetsStored = await sw.evaluate(() => chrome.storage.local.get(null));
check(offsetsStored['offset:big buck bunny|1|1'] === -0.8, 'décalage mémorisé par contenu', JSON.stringify(Object.keys(offsetsStored)));
// Remise à zéro pour que les captures suivantes tombent sur des répliques
const setOffset = (tabId, v, frameId = 0) => sw.evaluate(([t, o, f]) => chrome.tabs.sendMessage(t, { type: 'set-offset', offset: o }, { frameId: f }), [tabId, v, frameId]);
await setOffset(tabA, 0);

log('\n3. Synchro pendant la lecture (boucle rAF)');
await page.evaluate(() => { const v = document.getElementById('v1'); v.currentTime = 12.6; return v.play(); });
await page.waitForTimeout(1200); // ~13.8 s : cue 13 → 15.5 « Cœur, sœur… »
await page.evaluate(() => document.getElementById('v1').pause());
await page.screenshot({ path: `${SHOTS}/05-lecture.png` });
await page.evaluate(() => { document.getElementById('v1').playbackRate = 2; });
await page.evaluate(() => { const v = document.getElementById('v1'); v.currentTime = 15.6; return v.play(); });
await page.waitForTimeout(800); // ~17.2 s à ×2
await page.evaluate(() => { const v = document.getElementById('v1'); v.pause(); v.playbackRate = 1; });
await page.screenshot({ path: `${SHOTS}/06-vitesse-x2.png` });

log('\n4. Plein écran');
await seek(page, 4.5);
await page.click('#fsContainer');
await page.waitForTimeout(600);
check(await page.evaluate(() => document.fullscreenElement?.id === 'player'), 'conteneur en plein écran');
await page.screenshot({ path: `${SHOTS}/07-fullscreen-conteneur.png` });
await page.evaluate(() => document.exitFullscreen());
await page.waitForTimeout(500);
await page.screenshot({ path: `${SHOTS}/08-sortie-fullscreen.png` });
await page.click('#fsVideo');
await page.waitForTimeout(600);
check(await page.evaluate(() => document.fullscreenElement?.id === 'v1'), 'vidéo seule en plein écran');
const trackOk = await page.evaluate(() => {
  const t = [...document.getElementById('v1').textTracks].find((x) => x.label.includes('extension'));
  return t ? `${t.mode}, ${t.cues.length} cues` : 'aucune piste';
});
check(/showing, 9 cues/.test(trackOk), 'vidéo seule en plein écran → bascule sur la piste native', trackOk);
await page.screenshot({ path: `${SHOTS}/09-fullscreen-video-native.png` });
await page.evaluate(() => document.exitFullscreen());
await page.waitForTimeout(500);
const trackAfter = await page.evaluate(() => [...document.getElementById('v1').textTracks].find((x) => x.label.includes('extension'))?.mode);
check(trackAfter === 'disabled', 'retour à l’overlay après la sortie', trackAfter);
await page.screenshot({ path: `${SHOTS}/10-retour-overlay.png` });

log('\n5. Scroll : l’overlay suit la vidéo');
await page.evaluate(() => window.scrollBy(0, 150));
await page.waitForTimeout(200);
await page.screenshot({ path: `${SHOTS}/11-scroll.png` });
await page.evaluate(() => window.scrollTo(0, 0));

log('\n6. Mode natif forcé par les options');
await sw.evaluate(async () => { const { style = {} } = await chrome.storage.sync.get('style'); await chrome.storage.sync.set({ style: { ...style, render: 'native' } }); });
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/12-mode-natif.png` });
await sw.evaluate(async () => { const { style = {} } = await chrome.storage.sync.get('style'); await chrome.storage.sync.set({ style: { ...style, render: 'overlay', background: true } }); });
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/13-fond-semi-transparent.png` });
await sw.evaluate(async () => { const { style = {} } = await chrome.storage.sync.get('style'); await chrome.storage.sync.set({ style: { ...style, background: false } }); });

log('\n7. Mémoire : rechargement → réapplication auto (sous-titre + décalage)');
await setOffset(tabA, 0.5);
await page.waitForTimeout(300);
await page.reload();
await page.waitForFunction(() => document.getElementById('v1').readyState >= 1);
await page.evaluate(() => { const v = document.getElementById('v1'); v.muted = true; v.currentTime = 4.5; return v.play(); });
await page.waitForTimeout(1500);
await page.evaluate(() => document.getElementById('v1').pause());
st = await frameState(tabA);
check(st.hasSubs && st.offset === 0.5, 'sous-titre réappliqué au démarrage, décalage restauré (+0,5 s)', JSON.stringify(st));
await page.screenshot({ path: `${SHOTS}/13b-apres-rechargement.png` });

log('\n8. Iframe cross-origin');
const pageC = await ctx.newPage();
await pageC.goto('http://localhost:8001/test/iframe-only.html');
await pageC.waitForTimeout(1500);
const tabC = await tabIdOf('http://localhost:8001/test/iframe-only.html');
popup = await openPopup(tabC);
check(/iframe/.test(await popup.textContent('#videoStatus')), 'popup : vidéo détectée dans l’iframe', await popup.textContent('#videoStatus'));
await popup.setInputFiles('#file', path.join(EXT, 'test/media/test-cp1252.srt'));
await waitFor(msgMatches(popup, /Appliqué|Erreur/));
check(/Appliqué/.test(await popup.textContent('#message')), 'sous-titre envoyé à la bonne frame', await popup.textContent('#message'));
await pageC.bringToFront();
const frame = pageC.frames().find((f) => f.url().includes('8002'));
await frame.evaluate(() => new Promise((r) => { const v = document.getElementById('v'); v.addEventListener('seeked', () => setTimeout(r, 150), { once: true }); v.currentTime = 4.5; }));
await pageC.screenshot({ path: `${SHOTS}/14-iframe.png` });
// Touche pressée dans la page principale (focus hors de l'iframe) → relayée à la frame de la vidéo
await pageC.click('p');
await pageC.keyboard.press('h');
await pageC.waitForTimeout(300);
const frames = await sw.evaluate((t) => chrome.webNavigation.getAllFrames({ tabId: t }), tabC);
const sub = frames.find((f) => f.url.includes('8002'));
st = await frameState(tabC, sub.frameId);
check(st.offset === 0.1, 'H dans la page principale → relayé à l’iframe', String(st.offset));
await frame.click('#fs');
await pageC.waitForTimeout(600);
await pageC.screenshot({ path: `${SHOTS}/15-iframe-fullscreen.png` });
await frame.evaluate(() => document.exitFullscreen());

log('\n9. Vidéo ajoutée dynamiquement (MutationObserver)');
await page.bringToFront();
await page.click('#addVideo');
await page.waitForTimeout(800);
const count = await sw.evaluate(async (t) => (await chrome.storage.session.get('frames')).frames?.[t], tabA);
check(!!count?.[0]?.hasVideo, 'frame toujours signalée avec vidéo', JSON.stringify(count));

if (ONLINE) {
  log('\n10. Recherches réelles');
  popup = await openPopup(tabA);
  await popup.fill('#title', 'Breaking Bad');
  await popup.fill('#year', '');
  await popup.fill('#season', '5');
  await popup.fill('#episode', '16');
  await popup.click('#searchBtn');
  await waitFor(async () => !/en cours/.test(await popup.textContent('#message')), 90000);
  log('   ', await popup.textContent('#message'));
  log('   erreurs :', (await popup.$$eval('#errors .err', (e) => e.map((x) => x.textContent))).join(' | ') || 'aucune');
  const rels = await popup.$$eval('#results li', (lis) => lis.slice(0, 8).map((l) => l.innerText.replace(/\n/g, ' — ')));
  rels.forEach((r) => log('    •', r));
  check(rels.length > 0, 'résultats épisode');
  const providers = new Set(await popup.$$eval('#results li .meta span:first-child', (s) => s.map((x) => x.textContent)));
  check(providers.size >= 2, 'au moins 2 sources répondent', [...providers].join(', '));
  await popup.screenshot({ path: `${SHOTS}/20-popup-resultats.png`, fullPage: true });

  // Un résultat de chaque source : téléchargement + application
  for (const prov of providers) {
    const idx = await popup.$$eval('#results li', (lis, p) => lis.findIndex((l) => l.querySelector('.meta span').textContent === p), prov);
    await popup.click(`#results li:nth-child(${idx + 1})`);
    await waitFor(msgMatches(popup, /Appliqué|Erreur/), 60000);
    const m = await popup.textContent('#message');
    check(/Appliqué/.test(m), `téléchargement ${prov}`, m);
  }

  await popup.fill('#title', 'Inception');
  await popup.fill('#year', '2010');
  await popup.fill('#season', '');
  await popup.fill('#episode', '');
  await popup.click('#searchBtn');
  await waitFor(async () => !/en cours/.test(await popup.textContent('#message')), 90000);
  log('   ', await popup.textContent('#message'));
  const movieRels = await popup.$$eval('#results li', (lis) => lis.slice(0, 6).map((l) => l.innerText.replace(/\n/g, ' — ')));
  movieRels.forEach((r) => log('    •', r));
  const movieProviders = new Set(await popup.$$eval('#results li .meta span:first-child', (s) => s.map((x) => x.textContent)));
  for (const prov of movieProviders) {
    const idx = await popup.$$eval('#results li', (lis, p) => lis.findIndex((l) => l.querySelector('.meta span').textContent === p), prov);
    await popup.click(`#results li:nth-child(${idx + 1})`);
    await waitFor(msgMatches(popup, /Appliqué|Erreur/), 60000);
    const m = await popup.textContent('#message');
    check(/Appliqué/.test(m), `téléchargement film ${prov}`, m);
  }
  await popup.screenshot({ path: `${SHOTS}/21-popup-film.png`, fullPage: true });

  log('\n11. Cache de recherche (24 h)');
  await popup.click('#searchBtn');
  await waitFor(async () => !/en cours/.test(await popup.textContent('#message')));
  check(/cache/.test(await popup.textContent('#message')), 'deuxième recherche servie par le cache', await popup.textContent('#message'));

  log('\n12. Options → Tester les sources');
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.click('#testBtn');
  await opt.waitForTimeout(300);
  await waitFor(async () => !(await opt.isDisabled('#testBtn')), 180000);
  const rows = await opt.$$eval('#testTable tbody tr', (trs) => trs.map((t) => t.innerText.replace(/\t/g, ' | ')));
  rows.forEach((r) => log('    ', r));
  await opt.screenshot({ path: `${SHOTS}/22-options.png`, fullPage: true });
}

log(`\n${failures ? `${failures} échec(s)` : 'Tout est OK'} — captures dans ${SHOTS}`);
await ctx.close();
process.exitCode = failures ? 1 : 0;
