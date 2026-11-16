// Interface commune des providers + helpers réseau (service worker).
//
// Chaque provider (un fichier par site) exporte :
//   id, name, home            identité + page d'accueil (bouton « Ouvrir le site »)
//   supports                  { movie: bool, episode: bool }
//   SELECTORS                 sélecteurs CSS centralisés (à corriger quand le site change)
//   parsers                   { nom(doc, url) → { items, expected } }  — fonctions PURES sur un Document,
//                             exécutées dans le document offscreen (DOMParser) et dans test/providers.html
//   search(query, ctx)        → [{ id, provider, title, release, url, lang, downloads?, rating?, ... }]
//   download(result, ctx)     → { filename, bytes }
//
// `ctx` est fourni par background.js : { get(url, opts), parse(parserName, html, url) }.
// Ainsi les modules providers n'utilisent ni chrome.* ni DOMParser et restent testables.

export class ProviderError extends Error {
  /**
   * kind : 'challenge' (Cloudflare/Anubis/captcha), 'changed' (le site a probablement changé),
   *        'network' (timeout, hors ligne), 'http' (statut inattendu), 'notfound'
   */
  constructor(kind, message, { provider, url } = {}) {
    super(message);
    this.kind = kind;
    this.provider = provider;
    this.url = url;
  }
}

const TIMEOUT_MS = 10_000;
const MIN_DELAY_MS = 900; // délai minimal entre deux requêtes vers le même site
const queues = new Map(); // hôte → Promise (une requête à la fois par site)
const lastHit = new Map();

/** Sérialise les requêtes par hôte et impose un petit délai (politesse). */
function enqueue(host, task) {
  const prev = queues.get(host) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const wait = (lastHit.get(host) || 0) + MIN_DELAY_MS - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        lastHit.set(host, Date.now());
      }
    });
  queues.set(host, next);
  return next;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Repère une page de challenge anti-bot (on ne la contourne pas : on la signale). */
export function isChallenge(status, headers, text) {
  if (headers?.get?.('cf-mitigated') === 'challenge') return true;
  if (!text) return false;
  const head = text.slice(0, 6000);
  return (
    /<title>\s*(Just a moment|Attention Required|Un instant|Making sure you(&#39;|')re not a bot)/i.test(head) ||
    /cf_chl_opt|challenges\.cloudflare\.com\/turnstile|\.within\.website|id="anubis_challenge"/i.test(head) ||
    (/captcha/i.test(head) && status >= 400)
  );
}

function filenameFromHeaders(headers, url) {
  const cd = headers.get('content-disposition') || '';
  const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(cd);
  if (star) return safeDecode(star[1]);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (plain) return plain[1].trim();
  try {
    return safeDecode(new URL(url).pathname.split('/').pop() || 'subtitle');
  } catch {
    return 'subtitle';
  }
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * fetch poli et robuste : file par site, timeout 10 s, un seul retry (erreur réseau / 5xx / timeout).
 * opts.as : 'text' (défaut) | 'bytes' | 'json'
 * Les cookies du site (ex. challenge résolu à la main) sont envoyés : credentials 'include'.
 */
export async function httpGet(url, { provider, as = 'text', method = 'GET', body, headers } = {}) {
  const host = new URL(url).host;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await enqueue(host, () => doFetch(url, { provider, as, method, body, headers }));
    } catch (e) {
      const retryable = e.kind === 'network' || (e.kind === 'http' && e.status >= 500);
      if (attempt >= 2 || !retryable) throw e;
      await sleep(1500);
    }
  }
}

async function doFetch(url, { provider, as, method, body, headers }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method, body, headers, credentials: 'include', redirect: 'follow', signal: ctrl.signal, cache: 'no-store' });
  } catch (e) {
    throw new ProviderError('network', e.name === 'AbortError' ? 'délai dépassé (10 s)' : `erreur réseau : ${e.message}`, { provider, url });
  } finally {
    clearTimeout(timer);
  }
  const ctype = res.headers.get('content-type') || '';
  const isHtml = /text\/html/i.test(ctype);

  // Les challenges sont toujours du HTML : on lit le texte pour les détecter
  if (isHtml || as !== 'bytes' || !res.ok) {
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder('utf-8').decode(buf);
    if (isChallenge(res.status, res.headers, text)) {
      throw new ProviderError('challenge', 'page de vérification anti-robot', { provider, url });
    }
    if (!res.ok) {
      const err = new ProviderError(res.status === 404 ? 'notfound' : 'http', `HTTP ${res.status}`, { provider, url });
      err.status = res.status;
      throw err;
    }
    if (as === 'bytes') {
      // On attendait un fichier : du HTML ici signifie redirection vers une page (Referer manquant, quota…)
      if (isHtml) throw new ProviderError('http', 'le site a renvoyé une page au lieu du fichier', { provider, url });
      return { url: res.url, status: res.status, bytes: buf, filename: filenameFromHeaders(res.headers, res.url), contentType: ctype };
    }
    if (as === 'json') {
      try {
        return { url: res.url, status: res.status, json: JSON.parse(text) };
      } catch {
        throw new ProviderError('changed', 'réponse JSON invalide', { provider, url });
      }
    }
    // Pages en ISO-8859-1 / windows-1252 déclarées comme telles
    const charset = /charset=([\w-]+)/i.exec(ctype)?.[1]?.toLowerCase();
    const decoded = charset && charset !== 'utf-8' && charset !== 'utf8' ? new TextDecoder(charset).decode(buf) : text;
    return { url: res.url, status: res.status, text: decoded };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { url: res.url, status: res.status, bytes, filename: filenameFromHeaders(res.headers, res.url), contentType: ctype };
}

/** Vérifie la sortie d'un parser : rien trouvé alors que la page semblait contenir des résultats → site changé. */
export function checkParsed(out, provider, url, what = 'résultats') {
  if (!out || !Array.isArray(out.items)) throw new ProviderError('changed', `parser invalide (${what})`, { provider, url });
  if (!out.items.length && out.expected) {
    throw new ProviderError('changed', `aucun ${what} lu alors que la page en contient : le site ${provider} a probablement changé`, { provider, url });
  }
  return out.items;
}

/** Correspondance des noms de langues des sites → codes ISO. */
export const LANG_NAMES = {
  fr: ['french', 'français', 'francais', 'fr', 'fre', 'fra', 'vf'],
  en: ['english', 'anglais', 'en', 'eng', 'uk', 'vo'],
  es: ['spanish', 'español', 'espagnol', 'es', 'spa'],
  de: ['german', 'deutsch', 'allemand', 'de', 'ger', 'deu'],
  it: ['italian', 'italiano', 'italien', 'it', 'ita'],
  pt: ['portuguese', 'português', 'portugais', 'pt', 'por'],
};

export function langCode(name) {
  const n = String(name || '').trim().toLowerCase();
  for (const [code, names] of Object.entries(LANG_NAMES)) if (names.includes(n)) return code;
  return n.slice(0, 2) || null;
}

/** Texte nettoyé d'un élément (espaces normalisés). */
export function txt(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

/** Premier élément trouvé parmi une liste de sélecteurs (sélecteurs de repli). */
export function q1(root, selectors) {
  for (const s of [].concat(selectors)) {
    const el = root.querySelector(s);
    if (el) return el;
  }
  return null;
}

/** Tous les éléments du premier sélecteur qui trouve quelque chose. */
export function qAll(root, selectors) {
  for (const s of [].concat(selectors)) {
    const els = root.querySelectorAll(s);
    if (els.length) return [...els];
  }
  return [];
}

/** URL absolue à partir d'un href relatif. */
export function abs(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}
