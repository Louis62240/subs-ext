// Provider : yifysubtitles.ch (films uniquement, .zip)
//
// Constaté (nov. 2026) :
//   recherche  la page /search?q= est remplie en JS ; le site interroge GET /ajax/search/?mov=<titre>
//              → JSON [{ movie: "Inception 2010", imdb: "tt1375666" }] (c'est ce que fait le champ de recherche)
//   film       GET /movie-imdb/<imdb> → tr[data-id] : note (.rating-cell .label), langue (.sub-lang),
//              lien a[href^="/subtitles/"] (nom de release), uploader
//   sous-titre GET /subtitles/<slug> → a.download-subtitle → /subtitle/<slug>.zip
//   fichier    EXIGE un Referer yifysubtitles (sans lui : challenge Cloudflare 403). Ajouté par rules.json.
import { ProviderError, checkParsed, txt, abs, langCode, qAll, q1 } from './_base.js';
import { titleSimilarity } from '../match.js';

export const id = 'yify';
export const name = 'YIFY Subtitles';
export const home = 'https://yifysubtitles.ch/';
export const supports = { movie: true, episode: false };

// --- Sélecteurs ----------------------------------------------------------------
export const SELECTORS = {
  rows: ['tr[data-id]', 'table.other-subs tbody tr'],
  rating: '.rating-cell .label, .rating-cell',
  lang: '.sub-lang, .flag-cell',
  link: 'a[href^="/subtitles/"]',
  uploader: '.uploader-cell',
  downloadButton: ['a.download-subtitle', 'a[href^="/subtitle/"][href$=".zip"]'],
  movieTitle: ['.movie-main-title', 'h1', 'title'],
};

// --- Parsers purs --------------------------------------------------------------
export const parsers = {
  movie(doc, url) {
    const items = [];
    for (const tr of qAll(doc, SELECTORS.rows)) {
      const a = tr.querySelector(SELECTORS.link);
      if (!a) continue;
      // Le lien contient « <span class="text-muted">subtitle</span> Nom.De.La.Release »
      const muted = txt(a.querySelector('.text-muted'));
      const release = txt(a).slice(muted.length).trim();
      items.push({
        url: abs(a.getAttribute('href'), url),
        release,
        language: txt(tr.querySelector(SELECTORS.lang)),
        rating: Number(txt(tr.querySelector(SELECTORS.rating))) || 0,
        uploader: txt(tr.querySelector(SELECTORS.uploader)) || null,
      });
    }
    return { items, expected: !!doc.querySelector('.other-subs, table.table') && !!doc.querySelector('.sub-lang'), title: txt(q1(doc, SELECTORS.movieTitle)) };
  },

  subtitle(doc, url) {
    const a = q1(doc, SELECTORS.downloadButton);
    return { items: a ? [{ url: abs(a.getAttribute('href'), url) }] : [], expected: true };
  },
};

// --- Réseau ----------------------------------------------------------------------

export async function search(query, ctx) {
  if (query.season != null) return []; // films uniquement
  const url = `${home}ajax/search/?mov=${encodeURIComponent(query.title)}`;
  const res = await ctx.get(url, { as: 'json' });
  if (!Array.isArray(res.json)) throw new ProviderError('changed', 'format de recherche inattendu : le site yify a probablement changé', { provider: id, url });
  const movies = res.json
    .map((m) => {
      const ym = /\s(\d{4})$/.exec(m.movie || '');
      const title = ym ? m.movie.slice(0, -5) : m.movie;
      const year = ym ? +ym[1] : null;
      let sim = titleSimilarity(query.title, title);
      if (query.year && year) sim += Math.abs(query.year - year) <= 1 ? 0.1 : -0.4;
      return { title, year, imdb: m.imdb, sim };
    })
    .filter((m) => m.imdb && m.sim >= 0.6)
    .sort((a, b) => b.sim - a.sim);
  if (!movies.length) return [];
  const movie = movies[0];

  const pageUrl = `${home}movie-imdb/${movie.imdb}`;
  const page = await ctx.get(pageUrl);
  const rows = checkParsed(await ctx.parse('movie', page.text, page.url), id, pageUrl, 'sous-titre');
  return rows
    .filter((r) => langCode(r.language) === query.lang)
    .map((r) => ({
      id: `${id}:${r.url}`,
      provider: id,
      providerName: name,
      title: movie.title,
      year: movie.year,
      release: r.release,
      url: r.url,
      lang: query.lang,
      rating: r.rating,
      pageUrl,
    }));
}

export async function download(result, ctx) {
  const page = await ctx.get(result.url);
  const [file] = checkParsed(await ctx.parse('subtitle', page.text, page.url), id, result.url, 'lien de téléchargement');
  if (!file) throw new ProviderError('changed', 'bouton de téléchargement introuvable', { provider: id, url: result.url });
  // Referer ajouté par rules.json
  const res = await ctx.get(file.url, { as: 'bytes' });
  return { filename: res.filename, bytes: res.bytes };
}
