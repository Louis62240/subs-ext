// Provider : www.tvsubtitles.net (séries uniquement, .zip)
//
// Constaté (nov. 2026) :
//   recherche GET /search.php → 404 ; le formulaire poste vers /search2.php (POST qs=<titre>)
//             → liens a[href^="/tvshow-<id>.html"] « Breaking Bad (2008-2013) »
//   saison    GET /tvshow-<id>-<saison>.html → table#table5, ligne « 5x16 » + lien episode-<id>.html
//   épisode   GET /episode-<id>.html → a[href^="/subtitle-<id>.html"] > div.subtitlen (h5, rip, release, downloaded)
//   fichier   GET /download-<id>.html → page d'attente dont le JS reconstruit l'URL
//             ("var s1= 'fil'; var s2= 'es/B'; … document.location = s1+s2+s3+s4;") → GET /files/<nom>.zip
//   Protection : aucune constatée.
import { ProviderError, checkParsed, txt, abs, qAll } from './_base.js';
import { titleSimilarity } from '../match.js';

export const id = 'tvsubtitles';
export const name = 'TVsubtitles.net';
export const home = 'https://www.tvsubtitles.net/';
export const supports = { movie: false, episode: true };

// tvsubtitles utilise des codes de drapeaux maison (br = portugais brésilien, ua…), le français est « fr »
const FLAG_FOR_LANG = { fr: 'fr', en: 'en', es: 'es', de: 'de', it: 'it', pt: 'pt' };

// --- Sélecteurs ----------------------------------------------------------------
export const SELECTORS = {
  searchLinks: ['a[href^="/tvshow-"]', 'a[href*="tvshow-"]'],
  seasonRows: ['table#table5 tr', 'table tr'],
  episodeSubs: ['a[href^="/subtitle-"]', 'a[href*="subtitle-"]'],
  subTitle: 'h5',
  subFlag: 'h5 img[src*="flags/"]',
  subRip: 'p[title="rip"]',
  subRelease: 'p[title="release"]',
  subDownloads: 'p[title="downloaded"]',
};

// --- Parsers purs --------------------------------------------------------------
export const parsers = {
  search(doc, url) {
    const items = qAll(doc, SELECTORS.searchLinks).map((a) => {
      const t = txt(a);
      const m = /^(.*?)\s*\((\d{4})(?:-(\d{4}))?\)\s*$/.exec(t);
      return {
        url: abs(a.getAttribute('href'), url),
        id: (/tvshow-(\d+)/.exec(a.getAttribute('href')) || [])[1],
        title: m ? m[1] : t,
        year: m ? +m[2] : null,
      };
    });
    // « Search results » sans aucun lien = aucun résultat (normal) ; on ne peut pas distinguer davantage
    return { items, expected: false };
  },

  season(doc, url) {
    const items = [];
    for (const tr of qAll(doc, SELECTORS.seasonRows)) {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 2) continue;
      const m = /^(\d+)x(\d+)$/.exec(txt(tds[0]));
      const a = tds[1].querySelector('a[href*="episode-"]');
      if (!m || !a) continue;
      items.push({ season: +m[1], episode: +m[2], title: txt(a), url: abs(a.getAttribute('href'), url) });
    }
    return { items, expected: !!doc.querySelector('#table5') };
  },

  episode(doc, url) {
    const items = [];
    for (const a of qAll(doc, SELECTORS.episodeSubs)) {
      const box = a.querySelector('.subtitlen') || a;
      const flag = box.querySelector(SELECTORS.subFlag)?.getAttribute('src') || '';
      const lang = (/flags\/([a-z]+)\.gif/.exec(flag) || [])[1] || null;
      const downloads = Number(txt(box.querySelector(SELECTORS.subDownloads)).replace(/\D/g, '')) || null;
      items.push({
        url: abs(a.getAttribute('href'), url),
        subId: (/subtitle-(\d+)/.exec(a.getAttribute('href')) || [])[1],
        title: txt(box.querySelector(SELECTORS.subTitle)),
        lang,
        rip: txt(box.querySelector(SELECTORS.subRip)),
        release: txt(box.querySelector(SELECTORS.subRelease)),
        downloads,
      });
    }
    return { items, expected: /subtitles/i.test(txt(doc.querySelector('h2, h1'))) && !!doc.querySelector('.subtitlen') };
  },

  /**
   * Page d'attente de téléchargement : le lien est découpé en variables JS.
   * On ne l'exécute pas : on relit les affectations « var sN = '…' » et l'expression de concaténation.
   */
  download(doc, url) {
    const items = [];
    for (const script of doc.querySelectorAll('script')) {
      const code = script.textContent;
      const expr = /document\.location\s*=\s*([\w\s+]+);/.exec(code);
      if (!expr) continue;
      const vars = {};
      for (const m of code.matchAll(/var\s+(\w+)\s*=\s*'([^']*)'/g)) vars[m[1]] = m[2];
      const parts = expr[1].split('+').map((s) => s.trim());
      if (parts.every((p) => p in vars)) items.push({ url: abs(parts.map((p) => vars[p]).join(''), url) });
    }
    return { items, expected: /document\.location/.test(doc.documentElement.innerHTML) };
  },
};

// --- Réseau ----------------------------------------------------------------------

export async function search(query, ctx) {
  if (query.season == null || query.episode == null) return []; // séries uniquement
  const body = new URLSearchParams({ qs: query.title });
  const page = await ctx.get(`${home}search2.php`, {
    method: 'POST',
    body: body.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const shows = checkParsed(await ctx.parse('search', page.text, page.url), id, page.url, 'série')
    .map((s) => ({ ...s, sim: titleSimilarity(query.title, s.title) - (query.year && s.year && Math.abs(query.year - s.year) > 1 ? 0.2 : 0) }))
    .filter((s) => s.sim >= 0.6)
    .sort((a, b) => b.sim - a.sim);
  if (!shows.length) return [];
  const show = shows[0];

  const seasonUrl = `${home}tvshow-${show.id}-${query.season}.html`;
  const seasonPage = await ctx.get(seasonUrl);
  const eps = checkParsed(await ctx.parse('season', seasonPage.text, seasonPage.url), id, seasonUrl, 'épisode');
  const ep = eps.find((e) => e.season === query.season && e.episode === query.episode);
  if (!ep) return [];

  const epPage = await ctx.get(ep.url);
  const subs = checkParsed(await ctx.parse('episode', epPage.text, epPage.url), id, ep.url, 'sous-titre');
  const flag = FLAG_FOR_LANG[query.lang] || query.lang;
  return subs
    .filter((s) => s.lang === flag)
    .map((s) => ({
      id: `${id}:${s.subId}`,
      provider: id,
      providerName: name,
      title: show.title,
      year: show.year,
      release: s.title || `${show.title} ${query.season}x${query.episode} ${s.rip}.${s.release}`,
      url: s.url,
      subId: s.subId,
      lang: query.lang,
      downloads: s.downloads,
      episodeMatch: 'exact',
      pageUrl: ep.url,
    }));
}

export async function download(result, ctx) {
  const dlUrl = `${home}download-${result.subId}.html`;
  const page = await ctx.get(dlUrl);
  const [file] = checkParsed(await ctx.parse('download', page.text, page.url), id, dlUrl, 'lien de fichier');
  if (!file) throw new ProviderError('changed', 'lien de fichier introuvable', { provider: id, url: dlUrl });
  const res = await ctx.get(file.url, { as: 'bytes' });
  return { filename: res.filename, bytes: res.bytes };
}
