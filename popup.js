// Popup : détection modifiable, recherche, choix d'un résultat, fichier local, contrôles.
import { decodeBytes } from './lib/subtitles.js';
import { extractSubtitle } from './lib/archive.js';
import { getStyle, saveStyle } from './lib/store.js';

const $ = (id) => document.getElementById(id);
let tabId = null;
let detected = null; // détection d'origine (pour mémoriser le choix sous cette clé aussi)
let pageContext = '';
let lastResults = [];

const send = (msg) => chrome.runtime.sendMessage(msg);

function formatOffset(o = 0) {
  return `${o >= 0 ? '+' : '−'}${Math.abs(o).toFixed(1).replace('.', ',')} s`;
}

function showMessage(text, kind = '') {
  const m = $('message');
  m.hidden = !text;
  m.textContent = text || '';
  m.className = `message ${kind}`;
}

function currentQuery() {
  return {
    title: $('title').value.trim(),
    year: $('year').value || null,
    season: $('season').value || null,
    episode: $('episode').value || null,
    lang: $('lang').value,
  };
}

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

function renderStatus(init) {
  const vs = $('videoStatus');
  const live = init.live;
  if (!init.frame) {
    vs.textContent = 'Aucune vidéo détectée dans cet onglet';
    vs.className = 'pill none';
  } else {
    const where = init.frame.top ? 'page' : 'iframe';
    vs.textContent = `Vidéo détectée (${init.frame.width}×${init.frame.height}, ${where}${init.frameCount > 1 ? `, ${init.frameCount} frames` : ''})`;
    vs.className = 'pill ok';
  }
  const hasSubs = live?.hasSubs;
  $('subStatus').textContent = hasSubs
    ? `Sous-titre actif : ${live.release || init.tabSub?.release || '?'}${live.visible === false ? ' (masqué)' : ''}`
    : 'Aucun sous-titre actif';
  $('offsetValue').textContent = formatOffset(live?.offset || 0);
  $('toggleBtn').textContent = live?.visible === false ? 'Afficher' : 'Masquer';
  for (const b of document.querySelectorAll('#controls button')) b.disabled = !hasSubs;
}

async function refreshStatus() {
  const init = await send({ type: 'popup-init', tabId });
  if (init?.ok === false) return;
  renderStatus(init);
}

// ---------------------------------------------------------------------------
// Résultats
// ---------------------------------------------------------------------------

function renderErrors(errors = []) {
  const box = $('errors');
  box.textContent = '';
  for (const e of errors) {
    const div = document.createElement('div');
    div.className = `err ${e.kind}`;
    div.textContent = e.message;
    if (e.kind === 'challenge' || e.kind === 'changed') {
      const actions = document.createElement('div');
      actions.className = 'actions';
      const open = document.createElement('button');
      open.textContent = 'Ouvrir le site';
      open.onclick = () => send({ type: 'open-site', url: e.url });
      const retry = document.createElement('button');
      retry.textContent = 'Réessayer';
      retry.onclick = () => doSearch(true);
      actions.append(open, retry);
      div.appendChild(actions);
    }
    box.appendChild(div);
  }
}

function renderResults(results) {
  const ol = $('results');
  ol.textContent = '';
  lastResults = results;
  results.forEach((r, i) => {
    const li = document.createElement('li');
    li.tabIndex = 0;
    const rel = document.createElement('div');
    rel.className = 'rel';
    rel.textContent = r.release;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const parts = [r.providerName];
    if (r.downloads) parts.push(`${r.downloads.toLocaleString('fr-FR')} téléch.`);
    if (r.rating) parts.push(`note ${r.rating}`);
    if (r.episodeMatch === 'pack') parts.push('pack de saison');
    if (r.hearingImpaired) parts.push('malentendants');
    if (r.multiLang) parts.push('multi-langues');
    for (const p of parts) {
      const s = document.createElement('span');
      s.textContent = p;
      meta.appendChild(s);
    }
    if (r.releaseMatch) {
      const s = document.createElement('span');
      s.className = 'match';
      s.textContent = '✓ correspond à la release';
      s.title = r.why?.join(' · ') || '';
      meta.appendChild(s);
    }
    li.append(rel, meta);
    li.onclick = () => pick(i, li);
    li.onkeydown = (e) => e.key === 'Enter' && pick(i, li);
    ol.appendChild(li);
  });
}

async function doSearch(force = false) {
  const query = currentQuery();
  if (!query.title) return showMessage('Indiquez un titre.', 'error');
  showMessage('Recherche en cours…');
  renderErrors([]);
  renderResults([]);
  $('searchBtn').disabled = true;
  try {
    const res = await send({ type: 'search', query, pageContext, force });
    if (res?.ok === false) throw new Error(res.error);
    renderErrors(res.errors);
    renderResults(res.results);
    showMessage(res.results.length ? `${res.results.length} résultat(s)${res.cached ? ' (cache)' : ''}` : 'Aucun sous-titre trouvé.', res.results.length ? '' : 'error');
  } catch (e) {
    showMessage(`Erreur : ${e.message}`, 'error');
  } finally {
    $('searchBtn').disabled = false;
  }
}

async function pick(i, li) {
  const r = lastResults[i];
  li.classList.add('loading');
  showMessage(`Téléchargement de « ${r.release} »…`);
  try {
    const res = await send({ type: 'pick', tabId, result: r, query: currentQuery(), detected });
    if (res?.ok === false) throw new Error(res.error);
    showMessage(`Appliqué : ${res.cues} répliques, décalage ${formatOffset(res.offset)}.`, 'ok');
  } catch (e) {
    showMessage(`Erreur : ${e.message}`, 'error');
  } finally {
    li.classList.remove('loading');
    refreshStatus();
  }
}

async function doAuto() {
  const query = currentQuery();
  if (!query.title) return showMessage('Indiquez un titre.', 'error');
  showMessage('Recherche et application du meilleur résultat…');
  renderErrors([]);
  $('autoBtn').disabled = true;
  try {
    const res = await send({ type: 'auto', tabId, query, pageContext, detected });
    renderErrors(res.errors);
    if (res?.ok === false) throw new Error(res.error || res.message);
    showMessage(`Appliqué : ${res.release} (${res.result.providerName}), ${res.cues} répliques.`, 'ok');
  } catch (e) {
    showMessage(`Erreur : ${e.message}`, 'error');
  } finally {
    $('autoBtn').disabled = false;
    refreshStatus();
  }
}

async function loadFile(file) {
  showMessage(`Lecture de ${file.name}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const q = currentQuery();
    const sub = extractSubtitle(bytes, file.name, { season: q.season ? +q.season : null, episode: q.episode ? +q.episode : null, lang: q.lang });
    const text = decodeBytes(sub.bytes);
    const res = await send({ type: 'apply-local', tabId, text, filename: sub.filename, query: q, detected });
    if (res?.ok === false) throw new Error(res.error);
    showMessage(`Appliqué : ${sub.filename} (${res.cues} répliques).`, 'ok');
  } catch (e) {
    showMessage(`Erreur : ${e.message}`, 'error');
  } finally {
    $('file').value = '';
    refreshStatus();
  }
}

// ---------------------------------------------------------------------------
// Contrôles
// ---------------------------------------------------------------------------

async function ctl(msg) {
  const res = await send({ ...msg, tabId });
  if (res?.ok === false) showMessage(`Erreur : ${res.error}`, 'error');
  refreshStatus();
}

async function changeSize(delta) {
  const style = await getStyle();
  style.size = Math.min(15, Math.max(2, Math.round((style.size + delta) * 10) / 10));
  await saveStyle(style); // le content script suit chrome.storage.onChanged
  showMessage(`Taille du texte : ${style.size.toString().replace('.', ',')} % de la hauteur de la vidéo`);
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

async function init() {
  // ?tabId= permet d'ouvrir le popup dans un onglet pour les tests
  const param = new URLSearchParams(location.search).get('tabId');
  tabId = param ? Number(param) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;

  $('form').onsubmit = (e) => {
    e.preventDefault();
    doSearch();
  };
  $('autoBtn').onclick = doAuto;
  $('file').onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);
  $('openOptions').onclick = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };
  for (const b of document.querySelectorAll('[data-delta]')) b.onclick = () => ctl({ type: 'offset', delta: Number(b.dataset.delta) });
  $('resetOffset').onclick = () => ctl({ type: 'offset', value: 0 });
  $('toggleBtn').onclick = () => ctl({ type: 'toggle' });
  $('clearBtn').onclick = () => ctl({ type: 'clear' });
  $('sizeMinus').onclick = () => changeSize(-0.5);
  $('sizePlus').onclick = () => changeSize(0.5);

  const res = await send({ type: 'popup-init', tabId });
  if (res?.ok === false) return showMessage(`Erreur : ${res.error}`, 'error');
  detected = res.detection;
  pageContext = res.pageContext;
  $('title').value = res.detection.title || '';
  $('year').value = res.detection.year || '';
  $('season').value = res.detection.season ?? '';
  $('episode').value = res.detection.episode ?? '';
  $('lang').value = res.settings.lang || 'fr';
  renderStatus(res);
}

init();
