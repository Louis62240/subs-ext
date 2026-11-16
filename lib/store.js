// Réglages (chrome.storage.sync) et caches / mémoire (chrome.storage.local). Service worker + pages.
import { DEFAULT_ORDER } from './providers/index.js';

export const DEFAULT_SETTINGS = {
  lang: 'fr',
  auto: true, // réappliquer automatiquement le dernier sous-titre + décalage d'un contenu déjà vu
  providers: DEFAULT_ORDER.map((id) => ({ id, enabled: true })),
};

export const DEFAULT_STYLE = {
  size: 5.5,
  color: '#ffffff',
  background: false,
  bgOpacity: 0.5,
  position: 8,
  render: 'overlay',
};

export async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  // Providers ajoutés dans une nouvelle version : on les ajoute à la fin
  const known = new Set(s.providers.map((p) => p.id));
  for (const id of DEFAULT_ORDER) if (!known.has(id)) s.providers.push({ id, enabled: true });
  s.providers = s.providers.filter((p) => DEFAULT_ORDER.includes(p.id));
  return s;
}

export async function saveSettings(s) {
  await chrome.storage.sync.set({ settings: s });
}

export async function getStyle() {
  const { style } = await chrome.storage.sync.get('style');
  return { ...DEFAULT_STYLE, ...(style || {}) };
}

export async function saveStyle(style) {
  await chrome.storage.sync.set({ style });
}

// --- Cache local ----------------------------------------------------------------

const SEARCH_TTL = 24 * 3600 * 1000;
const MAX_SUBS = 40; // sous-titres gardés en cache (~50 Ko chacun)

export async function getCachedSearch(key) {
  const k = `search:${key}`;
  const { [k]: v } = await chrome.storage.local.get(k);
  if (!v || Date.now() - v.at > SEARCH_TTL) return null;
  return v;
}

export async function setCachedSearch(key, value) {
  await chrome.storage.local.set({ [`search:${key}`]: { ...value, at: Date.now() } });
}

/** Sous-titre téléchargé (texte décodé) indexé par l'id du résultat. */
export async function getCachedSub(resultId) {
  const k = `sub:${resultId}`;
  const { [k]: v } = await chrome.storage.local.get(k);
  return v || null;
}

export async function setCachedSub(resultId, value) {
  const { subIndex = [] } = await chrome.storage.local.get('subIndex');
  const idx = [resultId, ...subIndex.filter((x) => x !== resultId)];
  const evicted = idx.splice(MAX_SUBS);
  await chrome.storage.local.set({ [`sub:${resultId}`]: { ...value, at: Date.now() }, subIndex: idx });
  if (evicted.length) await chrome.storage.local.remove(evicted.map((x) => `sub:${x}`));
}

/** Décalage mémorisé par contenu. */
export async function getOffset(key) {
  const k = `offset:${key}`;
  const { [k]: v } = await chrome.storage.local.get(k);
  return typeof v === 'number' ? v : 0;
}

export async function setOffset(key, offset) {
  await chrome.storage.local.set({ [`offset:${key}`]: offset });
}

/** Dernier sous-titre choisi pour un contenu. */
export async function getLastChoice(key) {
  const k = `last:${key}`;
  const { [k]: v } = await chrome.storage.local.get(k);
  return v || null;
}

export async function setLastChoice(key, value) {
  await chrome.storage.local.set({ [`last:${key}`]: { ...value, at: Date.now() } });
}

/** Vide les caches (sous-titres + recherches). Les décalages et derniers choix sont conservés. */
export async function clearCaches() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('sub:') || k.startsWith('search:') || k === 'subIndex');
  await chrome.storage.local.remove(keys);
  return keys.length;
}
