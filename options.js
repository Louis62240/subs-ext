// Page d'options : langue, sources (activation + ordre), mode auto, style, tests des sources, cache.
import { PROVIDERS } from './lib/providers/index.js';
import { getSettings, saveSettings, getStyle, saveStyle } from './lib/store.js';

const $ = (id) => document.getElementById(id);
let settings;
let style;

function flashSaved() {
  $('saved').classList.add('on');
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => $('saved').classList.remove('on'), 1200);
}

// --- Sources -------------------------------------------------------------------

function renderProviders() {
  const ol = $('providers');
  ol.textContent = '';
  settings.providers.forEach((p, i) => {
    const prov = PROVIDERS[p.id];
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.enabled;
    cb.onchange = () => {
      p.enabled = cb.checked;
      persistSettings();
    };
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = prov.name;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = [prov.supports.movie && 'films', prov.supports.episode && 'séries'].filter(Boolean).join(' + ');
    const up = document.createElement('button');
    up.textContent = '↑';
    up.title = 'Monter';
    up.disabled = i === 0;
    up.onclick = () => move(i, -1);
    const down = document.createElement('button');
    down.textContent = '↓';
    down.title = 'Descendre';
    down.disabled = i === settings.providers.length - 1;
    down.onclick = () => move(i, 1);
    li.append(cb, name, kind, up, down);
    ol.appendChild(li);
  });
}

function move(i, dir) {
  const arr = settings.providers;
  [arr[i], arr[i + dir]] = [arr[i + dir], arr[i]];
  renderProviders();
  persistSettings();
}

async function persistSettings() {
  await saveSettings(settings);
  flashSaved();
}

// --- Style ---------------------------------------------------------------------

function renderPreview() {
  const cue = $('previewCue');
  cue.style.bottom = `${style.position}%`;
  cue.style.color = style.color;
  cue.style.fontSize = `${Math.max(12, (140 * style.size) / 100) * 1.6}px`;
  cue.style.textShadow = '0 0 2px #000, 0 0 2px #000, 1px 1px 2px #000, -1px -1px 2px #000';
  cue.firstElementChild.style.background = style.background ? `rgba(0,0,0,${style.bgOpacity})` : 'none';
  $('sizeOut').textContent = `${style.size} %`;
  $('positionOut').textContent = `${style.position} %`;
}

function bindStyle() {
  const fields = ['size', 'color', 'background', 'bgOpacity', 'position', 'render'];
  for (const f of fields) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!style[f];
    else el.value = style[f];
    el.oninput = async () => {
      style[f] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
      renderPreview();
      await saveStyle(style);
      flashSaved();
    };
  }
  renderPreview();
}

// --- Outils ----------------------------------------------------------------------

async function testSources() {
  const btn = $('testBtn');
  btn.disabled = true;
  $('toolMsg').textContent = 'Recherches réelles en cours (un film et un épisode par source)…';
  const tbody = $('testTable').querySelector('tbody');
  tbody.textContent = '';
  $('testTable').hidden = false;
  try {
    const rows = await chrome.runtime.sendMessage({ type: 'test-providers' });
    if (rows?.ok === false) throw new Error(rows.error);
    const label = { ok: 'OK', empty: 'Aucun résultat (cassé ?)', challenge: 'Bloqué par un challenge', broken: 'Cassé' };
    for (const r of rows) {
      const tr = document.createElement('tr');
      const cells = [
        r.name,
        r.type === 'movie' ? 'Film : Inception (2010)' : 'Épisode : Breaking Bad 5x16',
        label[r.status],
        r.status === 'ok' ? `${r.count} résultat(s) en ${(r.ms / 1000).toFixed(1)} s` : r.message || '',
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        td.textContent = c;
        if (i === 2) td.className = `st-${r.status}`;
        tr.appendChild(td);
      });
      if (r.status === 'challenge') {
        const b = document.createElement('button');
        b.textContent = 'Ouvrir le site';
        b.onclick = () => chrome.tabs.create({ url: r.home });
        tr.lastChild.append(' ', b);
      }
      tbody.appendChild(tr);
    }
    $('toolMsg').textContent = '';
  } catch (e) {
    $('toolMsg').textContent = `Erreur : ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function clearCache() {
  const res = await chrome.runtime.sendMessage({ type: 'clear-cache' });
  $('toolMsg').textContent = `Cache vidé (${res.removed} entrée(s)). Les décalages mémorisés sont conservés.`;
}

// --- Démarrage -----------------------------------------------------------------------

async function init() {
  [settings, style] = await Promise.all([getSettings(), getStyle()]);
  $('lang').value = settings.lang;
  $('lang').onchange = () => {
    settings.lang = $('lang').value;
    persistSettings();
  };
  $('auto').checked = settings.auto;
  $('auto').onchange = () => {
    settings.auto = $('auto').checked;
    persistSettings();
  };
  renderProviders();
  bindStyle();
  $('testBtn').onclick = testSources;
  $('clearCacheBtn').onclick = clearCache;
}

init();
