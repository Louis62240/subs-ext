// Provider : www.sous-titres.eu (site français, films + séries, fichiers .zip)
//
// Constaté (nov. 2026) :
//   recherche  GET /search.html?q=<titre>  → ul#searchResults > li.serie|li.film, lien h3 > a vers la fiche
//   fiche      GET /series/<slug>.html     → tous les épisodes : #saisons-content a.subList
//              GET /films/<slug>.html      → #film-content a.subList
//   fichier    GET <fiche>/download/<id>/<nom>.zip (lien direct, pas de Referer ni cookie requis)
//   Protection : Cloudflare présent mais pas de challenge sur ces pages lors des essais.
import { ProviderError, checkParsed, txt, qAll, q1, abs, langCode } from './_base.js';
import { titleSimilarity, episodeMatch } from '../match.js';

export const id = 'soustitres';
export const name = 'Sous-titres.eu';
export const home = 'https://www.sous-titres.eu/';
export const supports = { movie: true, episode: true };

// --- Sélecteurs (à corriger ici si le site change) --------------------------
export const SELECTORS = {
  searchItems: ['ul#searchResults > li', '#searchResults li'],
  searchLink: ['h3 > a', 'a.icone'],
  searchCount: '#searchTabsAll', // « Tout (100+) » : sert à savoir si la page contenait des résultats
  subRows: ['#saisons-content a.subList:not(.subListHeader)', '#film-content a.subList:not(.subListHeader)', 'a.subList[href*="download/"]'],
  rowEpisode: '.episodenum',
  rowLangImgs: '.lang img',
  rowTeam: '.team',
  rowDate: '.update',
  pageTitle: ['#serieTitle', '#filmTitle', 'h1'],
};

// --- Parsers purs (Document → données) ---------------------------------------
export const parsers = {
  /** Page de recherche → fiches (séries/films). */
  search(doc, url) {
    const items = [];
    for (const li of qAll(doc, SELECTORS.searchItems)) {
      const a = q1(li, SELECTORS.searchLink);
      if (!a) continue;
      const href = a.getAttribute('href') || '';
      // Le h3 contient « Titre VO (année)<span> - Titre FR</span> »
      const alt = txt(a.querySelector('span')).replace(/^-\s*/, '');
      const full = txt(a);
      const main = alt ? full.slice(0, full.length - txt(a.querySelector('span')).length).trim() : full;
      const ym = /\((\d{4})\)\s*$/.exec(main);
      items.push({
        type: li.classList.contains('serie') || /\/?series\//.test(href) ? 'episode' : 'movie',
        title: main.replace(/\s*\(\d{4}\)\s*$/, ''),
        altTitle: alt || null,
        year: ym ? Number(ym[1]) : null,
        url: abs(href, url),
      });
    }
    const countText = txt(doc.querySelector(SELECTORS.searchCount));
    const expected = /\((\d+)\+?\)/.test(countText) && !/\(0\)/.test(countText);
    return { items, expected };
  },

  /** Fiche série ou film → lignes de sous-titres. */
  show(doc, url) {
    const items = [];
    for (const a of qAll(doc, SELECTORS.subRows)) {
      const href = a.getAttribute('href') || '';
      if (!/download\//.test(href)) continue;
      // Le nom de fichier visible peut être masqué par Cloudflare (« [email protected] » quand il contient « @ ») :
      // on prend le nom dans l'URL, toujours fiable.
      const file = decodeURIComponent(href.split('/').pop() || '');
      const langs = [...a.querySelectorAll(SELECTORS.rowLangImgs)].map((i) => (i.getAttribute('alt') || '').toLowerCase()).filter(Boolean);
      items.push({
        url: abs(href, url),
        release: file.replace(/\.zip$/i, ''),
        filename: file,
        episodeLabel: txt(a.querySelector(SELECTORS.rowEpisode)).replace('×', 'x'),
        langs,
        team: txt(a.querySelector(SELECTORS.rowTeam)) || null,
        date: txt(a.querySelector(SELECTORS.rowDate)) || null,
      });
    }
    // Une fiche existe toujours avec au moins une ligne ; l'en-tête (subListHeader) prouve que c'est bien une fiche
    const expected = !!doc.querySelector('.subListHeader');
    return { items, expected, title: txt(q1(doc, SELECTORS.pageTitle)) };
  },
};

// --- Réseau ---------------------------------------------------------------------

export async function search(query, ctx) {
  const url = `${home}search.html?q=${encodeURIComponent(query.title)}`;
  const page = await ctx.get(url);
  const found = checkParsed(await ctx.parse('search', page.text, page.url), id, url, 'résultat de recherche');

  const wantType = query.season != null ? 'episode' : 'movie';
  const candidates = found
    .filter((f) => f.type === wantType)
    .map((f) => ({ ...f, sim: Math.max(titleSimilarity(query.title, f.title), f.altTitle ? titleSimilarity(query.title, f.altTitle) : 0) }))
    .filter((f) => f.sim >= 0.6)
    .sort((a, b) => b.sim - a.sim || yearDistance(a, query) - yearDistance(b, query));
  if (!candidates.length) return [];
  const best = candidates[0];

  const showPage = await ctx.get(best.url);
  const rows = checkParsed(await ctx.parse('show', showPage.text, showPage.url), id, best.url, 'sous-titre');

  const results = [];
  for (const r of rows) {
    const lang = r.langs.includes(query.lang) ? query.lang : r.langs.length === 1 ? langCode(r.langs[0]) : null;
    if (r.langs.length && !r.langs.includes(query.lang)) continue;
    let em = 'unknown';
    if (wantType === 'episode') {
      // On essaie le nom de fichier (gère « 601@603 », « S04 ») puis l'étiquette « 5x16 »
      em = episodeMatch(r.filename, query.season, query.episode);
      if (em === 'unknown') em = episodeMatch(r.episodeLabel.replace(/^S(\d+)$/, 'S$1'), query.season, query.episode);
      if (em === 'wrong' || em === 'unknown') continue;
    }
    results.push({
      id: `${id}:${r.url}`,
      provider: id,
      providerName: name,
      title: best.title,
      year: best.year,
      release: r.release,
      url: r.url,
      lang,
      // Les zips « ENFR » contiennent les deux langues : on choisira le fichier FR au dézippage
      multiLang: r.langs.length > 1,
      episodeMatch: em,
      team: r.team,
      date: r.date,
      pageUrl: best.url,
    });
  }
  return results;
}

export async function download(result, ctx) {
  const res = await ctx.get(result.url, { as: 'bytes' });
  if (!res.bytes?.length) throw new ProviderError('http', 'fichier vide', { provider: id, url: result.url });
  return { filename: res.filename || result.release + '.zip', bytes: res.bytes };
}

function yearDistance(f, q) {
  return q.year && f.year ? Math.abs(q.year - f.year) : 0;
}
