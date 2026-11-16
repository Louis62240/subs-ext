// Service worker : orchestration (frames vidéo, recherche, téléchargement, dézip, cache, raccourcis).
import { PROVIDERS } from './lib/providers/index.js';
import { httpGet, ProviderError } from './lib/providers/_base.js';
import { detectContent } from './lib/detect.js';
import { rankResults, contentKey, normalize } from './lib/match.js';
import { parseSubtitles, decodeBytes } from './lib/subtitles.js';
import { extractSubtitle } from './lib/archive.js';
import * as store from './lib/store.js';

// ============================================================================
// Document offscreen (DOMParser)
// ============================================================================

let offscreenPromise = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  // Évite deux créations simultanées (erreur « Only a single offscreen document may be created »)
  offscreenPromise ??= chrome.offscreen
    .createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'Analyser les pages HTML des sites de sous-titres' })
    .finally(() => (offscreenPromise = null));
  await offscreenPromise;
}

async function parseHtml(provider, parser, html, url) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'parse', provider, parser, html, url });
  if (!res?.ok) throw new ProviderError('changed', `erreur d'analyse (${parser}) : ${res?.error || 'pas de réponse'}`, { provider, url });
  return res.data;
}

/** Contexte passé aux providers : réseau + parsing, sans qu'ils dépendent de chrome.* */
function makeCtx(providerId) {
  return {
    get: (url, opts = {}) => httpGet(url, { ...opts, provider: providerId }),
    parse: (parser, html, url) => parseHtml(providerId, parser, html, url),
  };
}

// ============================================================================
// Registre des frames qui contiennent une vidéo (persisté en storage.session : le SW peut s'endormir)
// ============================================================================

let framesCache = null; // { [tabId]: { [frameId]: info } }
let tabSubsCache = null; // { [tabId]: { key, frameId, release, provider, resultId } }

async function loadSession() {
  if (!framesCache) {
    const s = await chrome.storage.session.get(['frames', 'tabSubs']);
    framesCache = s.frames || {};
    tabSubsCache = s.tabSubs || {};
  }
}
function persistSession() {
  chrome.storage.session.set({ frames: framesCache, tabSubs: tabSubsCache });
}

async function setFrameInfo(tabId, frameId, info) {
  await loadSession();
  const t = (framesCache[tabId] ||= {});
  if (info?.hasVideo) t[frameId] = { ...info, at: Date.now() };
  else delete t[frameId];
  if (!Object.keys(t).length) delete framesCache[tabId];
  persistSession();
}

/** Frame vidéo à cibler : celle qui a déjà des sous-titres, sinon celle en lecture, sinon la plus grande. */
async function bestFrame(tabId) {
  await loadSession();
  const frames = Object.entries(framesCache[tabId] || {}).map(([id, info]) => ({ frameId: Number(id), ...info }));
  if (!frames.length) return null;
  frames.sort((a, b) => Number(b.hasSubs) - Number(a.hasSubs) || Number(b.playing) - Number(a.playing) || b.width * b.height - a.width * a.height);
  return frames[0];
}

async function setTabSub(tabId, value) {
  await loadSession();
  if (value) tabSubsCache[tabId] = value;
  else delete tabSubsCache[tabId];
  persistSession();
}

async function getTabSub(tabId) {
  await loadSession();
  return tabSubsCache[tabId] || null;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadSession();
  delete framesCache[tabId];
  delete tabSubsCache[tabId];
  persistSession();
});

chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId }) => {
  await loadSession();
  if (frameId === 0) {
    delete framesCache[tabId];
    delete tabSubsCache[tabId];
  } else if (framesCache[tabId]) {
    delete framesCache[tabId][frameId];
  }
  persistSession();
});

function sendToFrame(tabId, frameId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId });
}

/** Prévient toutes les frames de l'onglet (relais des touches G/H/V depuis une autre frame). */
function broadcastTabHasSubs(tabId, value) {
  chrome.tabs.sendMessage(tabId, { type: 'tab-has-subs', value }).catch(() => {});
}

// ============================================================================
// Détection du contenu de l'onglet
// ============================================================================

async function detectForTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let ogTitle = '';
  try {
    const info = await sendToFrame(tabId, 0, { type: 'get-page-info' });
    ogTitle = info?.ogTitle || '';
  } catch {
    // pas de content script (page chrome://, PDF…)
  }
  return { detection: detectContent({ title: tab.title, url: tab.url, ogTitle }), pageContext: `${tab.title} ${tab.url}` };
}

// ============================================================================
// Recherche multi-sources
// ============================================================================

function queryOf(q, lang) {
  const isEp = q.season != null && q.season !== '' && q.episode != null && q.episode !== '';
  return {
    title: String(q.title || '').trim(),
    year: q.year ? Number(q.year) : null,
    season: isEp ? Number(q.season) : null,
    episode: isEp ? Number(q.episode) : null,
    lang: q.lang || lang || 'fr',
  };
}

async function searchAll(rawQuery, pageContext = '', { force = false, only = null } = {}) {
  const settings = await store.getSettings();
  const query = queryOf(rawQuery, settings.lang);
  if (!query.title) throw new Error('titre vide');
  const enabled = settings.providers.filter((p) => p.enabled && (!only || only.includes(p.id))).map((p) => p.id);
  const type = query.season != null ? 'episode' : 'movie';
  const active = enabled.filter((id) => PROVIDERS[id].supports[type]);
  const cacheKey = `${contentKey(query)}|${query.year || ''}|${query.lang}|${active.join(',')}`;

  if (!force) {
    const cached = await store.getCachedSearch(cacheKey);
    if (cached) return { ...cached, cached: true, query };
  }

  const errors = [];
  const all = [];
  await Promise.all(
    active.map(async (id) => {
      const p = PROVIDERS[id];
      try {
        const res = await p.search(query, makeCtx(id));
        // Petit bonus selon l'ordre choisi dans les options
        const bonus = (active.length - active.indexOf(id)) * 0.5;
        all.push(...res.map((r) => ({ ...r, orderBonus: bonus })));
      } catch (e) {
        errors.push(describeError(id, e));
      }
    }),
  );
  const ranked = rankResults(all, query, pageContext)
    .map((r) => ({ ...r, score: Math.round((r.score + (r.orderBonus || 0)) * 10) / 10 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
  const out = { results: ranked, errors };
  // On ne met en cache qu'une recherche « propre » (sinon on garderait 24 h un échec temporaire)
  if (ranked.length && !errors.length) await store.setCachedSearch(cacheKey, out);
  return { ...out, cached: false, query };
}

function describeError(id, e) {
  const p = PROVIDERS[id];
  const kind = e instanceof ProviderError ? e.kind : 'error';
  const messages = {
    challenge: `${p.name} demande une vérification anti-robot. Ouvrez le site, validez-la, puis réessayez.`,
    changed: `${p.name} : ${e.message}`,
    network: `${p.name} : ${e.message}`,
  };
  return { provider: id, name: p.name, kind, message: messages[kind] || `${p.name} : ${e.message}`, url: kind === 'challenge' ? e.url || p.home : p.home };
}

// ============================================================================
// Téléchargement + application sur la vidéo
// ============================================================================

/** Récupère le texte du sous-titre (cache local, sinon téléchargement + dézip + décodage). */
async function fetchSubtitleText(result, query) {
  const cached = await store.getCachedSub(result.id);
  if (cached) return cached;
  const p = PROVIDERS[result.provider];
  if (!p) throw new Error(`source inconnue : ${result.provider}`);
  let file;
  try {
    file = await p.download(result, makeCtx(result.provider));
  } catch (e) {
    throw new Error(describeError(result.provider, e).message);
  }
  const sub = extractSubtitle(file.bytes, file.filename || '', { season: query.season, episode: query.episode, lang: query.lang });
  const text = decodeBytes(sub.bytes);
  const value = { text, filename: sub.filename };
  await store.setCachedSub(result.id, value);
  return value;
}

/** Envoie des cues à la frame vidéo de l'onglet et mémorise le choix. */
async function applyToTab(tabId, { text, filename, cues }, meta, key, frameId = null) {
  cues ||= parseSubtitles(text, filename);
  if (!cues.length) throw new Error('fichier de sous-titres vide ou illisible');
  const frame = frameId != null ? { frameId } : await bestFrame(tabId);
  if (!frame) throw new Error('aucune vidéo détectée dans cet onglet');
  const offset = key ? await store.getOffset(key) : 0;
  const res = await sendToFrame(tabId, frame.frameId, { type: 'load-cues', cues, offset, meta: { ...meta, key } });
  if (!res?.ok) throw new Error("la vidéo n'est plus disponible dans la frame");
  await setTabSub(tabId, { key, frameId: frame.frameId, release: meta.release, provider: meta.provider, resultId: meta.resultId });
  await setFrameInfo(tabId, frame.frameId, res.info);
  broadcastTabHasSubs(tabId, true);
  return { ok: true, cues: cues.length, offset, release: meta.release, filename };
}

async function pickResult(tabId, result, rawQuery, detected = null) {
  const settings = await store.getSettings();
  const query = queryOf(rawQuery, settings.lang);
  const key = contentKey(query);
  const sub = await fetchSubtitleText(result, query);
  const out = await applyToTab(tabId, sub, { release: result.release, provider: result.providerName || result.provider, resultId: result.id }, key);
  await rememberChoice(key, detected, { result: slimResult(result), query });
  return out;
}

/**
 * Mémorise le choix sous la clé de la recherche ET sous celle de la détection automatique
 * (si j'ai corrigé le titre dans le popup, la réouverture de la page doit quand même retrouver le choix).
 */
async function rememberChoice(key, detected, value) {
  await store.setLastChoice(key, value);
  const dk = detected?.title ? contentKey(detected) : null;
  if (dk && dk !== key) await store.setLastChoice(dk, value);
}

function slimResult(r) {
  const { id, provider, providerName, release, url, subId, pageUrl, title, year } = r;
  return { id, provider, providerName, release, url, subId, pageUrl, title, year };
}

async function autoPick(tabId, rawQuery, pageContext, detected = null) {
  const search = await searchAll(rawQuery, pageContext);
  if (!search.results.length) return { ok: false, errors: search.errors, message: 'aucun sous-titre trouvé' };
  // On essaie les meilleurs résultats dans l'ordre jusqu'à ce qu'un téléchargement réussisse
  const tried = [];
  for (const r of search.results.slice(0, 3)) {
    try {
      const out = await pickResult(tabId, r, rawQuery, detected);
      return { ...out, result: r, errors: search.errors };
    } catch (e) {
      tried.push(`${r.providerName} : ${e.message}`);
    }
  }
  return { ok: false, errors: search.errors, message: `échec des téléchargements (${tried.join(' ; ')})` };
}

/** Fichier local chargé depuis le popup : on le garde en cache comme un résultat. */
async function applyLocal(tabId, { text, filename }, rawQuery, detected = null) {
  const settings = await store.getSettings();
  const query = queryOf(rawQuery, settings.lang);
  const key = query.title ? contentKey(query) : null;
  const id = `local:${normalize(filename)}:${text.length}`;
  await store.setCachedSub(id, { text, filename });
  const out = await applyToTab(tabId, { text, filename }, { release: filename, provider: 'fichier local', resultId: id }, key);
  if (key) await rememberChoice(key, detected, { result: { id, provider: 'local', providerName: 'fichier local', release: filename }, query });
  return out;
}

/** Réapplication automatique quand une vidéo démarre (option « auto »). Aucune requête réseau si le cache suffit. */
async function maybeAutoApply(tabId, frameId) {
  const settings = await store.getSettings();
  if (!settings.auto) return;
  const { detection } = await detectForTab(tabId);
  const last = await store.getLastChoice(contentKey(detection));
  if (!last) return;
  // La clé du sous-titre (décalage mémorisé) est celle de la recherche d'origine
  const key = contentKey(queryOf(last.query, settings.lang));
  const current = await getTabSub(tabId);
  if (current && current.key === key) return; // déjà appliqué
  let sub = await store.getCachedSub(last.result.id);
  if (!sub && last.result.provider !== 'local') sub = await fetchSubtitleText(last.result, queryOf(last.query, settings.lang));
  if (!sub) return;
  await applyToTab(tabId, sub, { release: last.result.release, provider: last.result.providerName, resultId: last.result.id }, key, frameId);
}

// ============================================================================
// Décalage / visibilité
// ============================================================================

async function targetFrameForControls(tabId) {
  const sub = await getTabSub(tabId);
  if (sub) return sub.frameId;
  return (await bestFrame(tabId))?.frameId ?? null;
}

async function control(tabId, msg) {
  const frameId = await targetFrameForControls(tabId);
  if (frameId == null) throw new Error('aucune vidéo détectée dans cet onglet');
  return sendToFrame(tabId, frameId, msg);
}

// ============================================================================
// Messages
// ============================================================================

const handlers = {
  // --- depuis les content scripts
  async 'video-status'(msg, sender) {
    await setFrameInfo(sender.tab.id, sender.frameId, msg.info);
    if (!msg.info?.hasVideo) {
      const sub = await getTabSub(sender.tab.id);
      if (sub?.frameId === sender.frameId) {
        await setTabSub(sender.tab.id, null);
        broadcastTabHasSubs(sender.tab.id, false);
      }
    }
  },
  async 'video-playing'(_msg, sender) {
    await maybeAutoApply(sender.tab.id, sender.frameId).catch((e) => console.warn('auto :', e.message));
  },
  async 'video-changed'(_msg, sender) {
    await setTabSub(sender.tab.id, null);
    broadcastTabHasSubs(sender.tab.id, false);
  },
  async 'offset-changed'(msg, sender) {
    const sub = await getTabSub(sender.tab.id);
    if (sub?.key) await store.setOffset(sub.key, msg.offset);
  },
  async key(msg, sender) {
    // Touche pressée dans une frame sans vidéo : on relaie vers la frame qui affiche les sous-titres
    const tabId = sender.tab.id;
    if (msg.action === 'toggle') return control(tabId, { type: 'toggle' });
    return control(tabId, { type: 'shift-offset', delta: msg.delta });
  },

  // --- depuis le popup
  async 'popup-init'({ tabId }) {
    const [{ detection, pageContext }, frame, settings, tabSub, style] = await Promise.all([
      detectForTab(tabId),
      bestFrame(tabId),
      store.getSettings(),
      getTabSub(tabId),
      store.getStyle(),
    ]);
    let live = null;
    if (frame) live = await sendToFrame(tabId, tabSub?.frameId ?? frame.frameId, { type: 'get-state' }).catch(() => null);
    const frameCount = Object.keys(framesCache[tabId] || {}).length;
    return { detection, pageContext, frame, frameCount, settings, tabSub, live, style };
  },
  async search({ query, pageContext, force }) {
    return searchAll(query, pageContext, { force });
  },
  async pick({ tabId, result, query, detected }) {
    return pickResult(tabId, result, query, detected);
  },
  async auto({ tabId, query, pageContext, detected }) {
    return autoPick(tabId, query, pageContext, detected);
  },
  async 'apply-local'({ tabId, text, filename, query, detected }) {
    return applyLocal(tabId, { text, filename }, query, detected);
  },
  async offset({ tabId, delta, value }) {
    return control(tabId, value != null ? { type: 'set-offset', offset: value } : { type: 'shift-offset', delta });
  },
  async toggle({ tabId }) {
    return control(tabId, { type: 'toggle' });
  },
  async clear({ tabId }) {
    const r = await control(tabId, { type: 'clear' });
    await setTabSub(tabId, null);
    broadcastTabHasSubs(tabId, false);
    return r;
  },
  async 'open-site'({ url }) {
    await chrome.tabs.create({ url, active: true });
    return { ok: true };
  },

  // --- depuis les options
  async 'test-providers'() {
    return testProviders();
  },
  async 'clear-cache'() {
    return { removed: await store.clearCaches() };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // destiné au document offscreen
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg, sender))
    .then((r) => sendResponse(r ?? { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // réponse asynchrone
});

// ============================================================================
// Raccourcis globaux (chrome://extensions/shortcuts)
// ============================================================================

chrome.commands.onCommand.addListener(async (command, tab) => {
  const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId == null) return;
  try {
    if (command === 'offset-minus') await control(tabId, { type: 'shift-offset', delta: -0.1 });
    else if (command === 'offset-plus') await control(tabId, { type: 'shift-offset', delta: 0.1 });
    else if (command === 'toggle-subs') await control(tabId, { type: 'toggle' });
    else if (command === 'auto-subs') {
      const { detection, pageContext } = await detectForTab(tabId);
      await autoPick(tabId, detection, pageContext, detection);
    }
  } catch (e) {
    console.warn(`commande ${command} :`, e.message);
  }
});

// ============================================================================
// « Tester les sources » (page d'options)
// ============================================================================

const TEST_QUERIES = {
  movie: { title: 'Inception', year: 2010, lang: 'fr' },
  episode: { title: 'Breaking Bad', season: 5, episode: 16, lang: 'fr' },
};

async function testProviders() {
  const out = [];
  for (const [id, p] of Object.entries(PROVIDERS)) {
    for (const type of ['movie', 'episode']) {
      if (!p.supports[type]) continue;
      const q = TEST_QUERIES[type];
      const t0 = Date.now();
      try {
        const res = await p.search(queryOf(q), makeCtx(id));
        out.push({ provider: id, name: p.name, type, status: res.length ? 'ok' : 'empty', count: res.length, ms: Date.now() - t0, home: p.home });
      } catch (e) {
        const d = describeError(id, e);
        out.push({ provider: id, name: p.name, type, status: d.kind === 'challenge' ? 'challenge' : 'broken', message: d.message, ms: Date.now() - t0, home: d.url });
      }
    }
  }
  return out;
}
