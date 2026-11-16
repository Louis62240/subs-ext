// Document offscreen : le service worker MV3 n'a pas DOMParser.
// Il nous envoie le HTML brut + le nom du parser ; on renvoie des données structurées (sérialisables).
import { PROVIDERS } from './lib/providers/index.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'parse') return false;
  try {
    const fn = PROVIDERS[msg.provider]?.parsers?.[msg.parser];
    if (!fn) throw new Error(`parser inconnu : ${msg.provider}.${msg.parser}`);
    // DOMParser n'exécute aucun script et ne charge aucune ressource : sûr pour du HTML distant
    const doc = new DOMParser().parseFromString(msg.html, 'text/html');
    sendResponse({ ok: true, data: fn(doc, msg.url) });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
  return false;
});
