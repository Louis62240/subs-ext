// Provider : www.addic7ed.com (séries surtout, quelques films ; .srt bruts, souvent ISO-8859-1)
//
// Constaté (nov. 2026) :
//   épisode  GET /search.php?search=<titre> <S>x<EE>&Submit=Search → 302 direct vers /serie/<Nom>/<s>/<e>/<titre>
//   film     GET /search.php?search=<titre>&Submit=Search          → 302 vers /movie/<id>
//   ambigu   la même URL renvoie une liste (table.tabel a[href^="serie/"|"movie/"]) : on choisit le meilleur lien
//   page     un bloc par « Version » (td.NewsTitle) ; lignes td.language + lien /original/… ou /updated/…
//            ligne suivante : « N Downloads », icône « Hearing Impaired »
//   fichier  GET /original/<id>/<v> ou /updated/<lang>/<id>/<v> : EXIGE un Referer addic7ed
//            (sans lui : 302 vers la page de l'épisode). Ajouté par rules.json (declarativeNetRequest).
//   Limite   le site limite le nombre de téléchargements quotidiens sans compte.
import { ProviderError, checkParsed, txt, abs, langCode, qAll, q1 } from './_base.js';
import { titleSimilarity } from '../match.js';

export const id = 'addic7ed';
export const name = 'Addic7ed';
export const home = 'https://www.addic7ed.com/';
export const supports = { movie: true, episode: true };

// --- Sélecteurs ----------------------------------------------------------------
export const SELECTORS = {
  pageTitle: ['span.titulo', '.titulo'],
  versionTitle: 'td.NewsTitle',
  languageCell: ['td.language'],
  downloadLinks: 'a[href^="/updated/"], a[href^="/original/"]',
  statsCell: 'td.newsDate',
  listLinks: ['table.tabel a[href*="serie/"], table.tabel a[href*="movie/"]', 'a[href^="serie/"], a[href^="/serie/"], a[href^="movie/"], a[href^="/movie/"]'],
};

// --- Parsers purs --------------------------------------------------------------
export const parsers = {
  /** Page épisode ou film → sous-titres disponibles. */
  page(doc, url) {
    const items = [];
    const pageTitle = txt(q1(doc, SELECTORS.pageTitle)).replace(/\s*Subtitle\s*$/i, '');
    for (const cell of qAll(doc, SELECTORS.languageCell)) {
      const row = cell.closest('tr');
      const table = cell.closest('table');
      if (!row || !table) continue;
      // Version : le td.NewsTitle du même tableau (« Version 720p.1080p.WEB-DL, Duration: 0.00 »)
      const vt = txt(table.querySelector(SELECTORS.versionTitle));
      const version = (/Version\s+([^,]+)/i.exec(vt) || [])[1]?.trim() || '';
      const status = txt(row.querySelector('td b'));
      const links = [...row.querySelectorAll(SELECTORS.downloadLinks)];
      // « Most Updated » si présent, sinon « Original »
      const link = links.find((a) => a.getAttribute('href').startsWith('/updated/')) || links[0];
      if (!link) continue;
      const stats = row.nextElementSibling ? txt(row.nextElementSibling.querySelector(SELECTORS.statsCell)) : '';
      const fav = /saveFavorite\(\d+,\d+,(\d)\)/.exec(cell.innerHTML);
      items.push({
        // Le nom de la langue est le premier nœud texte de la cellule (suivi du lien « favori »)
        language: (cell.firstChild?.textContent || txt(cell)).trim(),
        version,
        completed: /^Completed$/i.test(status),
        status,
        url: abs(link.getAttribute('href'), url),
        downloads: Number((/([\d,]+)\s+Downloads/i.exec(stats) || [])[1]?.replace(/,/g, '') || 0) || null,
        hearingImpaired: !!row.nextElementSibling?.querySelector('img[title="Hearing Impaired"]') || fav?.[1] === '1',
      });
    }
    return { items, expected: !!doc.querySelector(SELECTORS.versionTitle), title: pageTitle };
  },

  /** Liste de résultats (recherche ambiguë). */
  list(doc, url) {
    const items = qAll(doc, SELECTORS.listLinks).map((a) => {
      const text = txt(a);
      const href = a.getAttribute('href');
      const se = /^(.*?)\s+-\s+(\d+)x(\d+)\s+-\s+/.exec(text);
      const ym = /\((\d{4})\)\s*$/.exec(text);
      return {
        url: abs(href, url),
        type: /serie\//.test(href) ? 'episode' : 'movie',
        title: se ? se[1] : text.replace(/\s*\(\d{4}\)\s*$/, ''),
        season: se ? +se[2] : null,
        episode: se ? +se[3] : null,
        year: ym ? +ym[1] : null,
      };
    });
    // Page de résultats : contient le tableau « tabel » ; sans lui c'est « aucun résultat »
    return { items, expected: !!doc.querySelector('table.tabel a') };
  },
};

// --- Réseau ----------------------------------------------------------------------

export async function search(query, ctx) {
  const isEp = query.season != null && query.episode != null;
  const term = isEp ? `${query.title} ${query.season}x${String(query.episode).padStart(2, '0')}` : query.title;
  const url = `${home}search.php?search=${encodeURIComponent(term)}&Submit=Search`;
  let page = await ctx.get(url);

  // Pas de redirection directe : liste de résultats → on choisit le meilleur lien
  if (!/\/(serie|movie)\//.test(page.url)) {
    const list = await ctx.parse('list', page.text, page.url);
    const links = checkParsed(list, id, url, 'lien de résultat')
      .filter((l) => (isEp ? l.type === 'episode' && l.season === query.season && l.episode === query.episode : l.type === 'movie'))
      .map((l) => ({ ...l, sim: titleSimilarity(query.title, l.title) - (query.year && l.year && Math.abs(query.year - l.year) > 1 ? 0.3 : 0) }))
      .filter((l) => l.sim >= 0.6)
      .sort((a, b) => b.sim - a.sim);
    if (!links.length) return [];
    page = await ctx.get(links[0].url);
  }

  const parsed = await ctx.parse('page', page.text, page.url);
  const rows = checkParsed(parsed, id, page.url, 'sous-titre');
  const showTitle = isEp ? (/^(.*?)\s+-\s+\d+x\d+/.exec(parsed.title) || [])[1] || query.title : parsed.title.replace(/\s*\(\d{4}\)$/, '');
  const year = Number((/\((\d{4})\)/.exec(parsed.title) || [])[1]) || null;

  return rows
    .filter((r) => r.completed && langCode(r.language) === query.lang)
    .map((r) => ({
      id: `${id}:${r.url}`,
      provider: id,
      providerName: name,
      title: showTitle,
      year,
      // Nom lisible : « Breaking Bad 5x16 720p.1080p.WEB-DL »
      release: [showTitle, isEp ? `${query.season}x${String(query.episode).padStart(2, '0')}` : year, r.version].filter(Boolean).join(' '),
      url: r.url,
      lang: query.lang,
      downloads: r.downloads,
      hearingImpaired: r.hearingImpaired,
      episodeMatch: isEp ? 'exact' : 'unknown',
      pageUrl: page.url,
    }));
}

export async function download(result, ctx) {
  // Le Referer est injecté par la règle declarativeNetRequest (rules.json)
  const res = await ctx.get(result.url, { as: 'bytes' });
  if (!res.bytes?.length) throw new ProviderError('http', 'fichier vide (quota de téléchargements atteint ?)', { provider: id, url: result.url });
  return { filename: res.filename || `${result.release}.srt`, bytes: res.bytes };
}
