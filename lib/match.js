// Classement des résultats de recherche. Module pur (testé sous Node).

const ARTICLES = new Set(['the', 'a', 'an', 'le', 'la', 'les', 'l', 'un', 'une', 'des', 'de', 'du', 'd', 'el', 'los', 'die', 'der', 'das']);

/** Normalise un titre : minuscules, sans accents ni ponctuation, "&" → "and". */
export function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Mots significatifs (sans articles). */
export function tokens(s) {
  const t = normalize(s).split(' ').filter(Boolean);
  const sig = t.filter((w) => !ARTICLES.has(w));
  return sig.length ? sig : t;
}

/** Similarité de titres dans [0, 1]. */
export function titleSimilarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  if (ta.join(' ') === tb.join(' ')) return 1;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const jaccard = inter / (sa.size + sb.size - inter);
  // Le titre cherché entièrement contenu dans l'autre (« The Office » ⊂ « The Office (US) ») : bonne correspondance
  const containment = inter / sa.size;
  return Math.max(jaccard, containment * 0.85);
}

/** Clé de cache / mémoire d'un contenu. */
export function contentKey({ title, season, episode }) {
  return [normalize(title), season ?? '', episode ?? ''].join('|');
}

/**
 * Lit saison/épisode(s) dans un nom de fichier/release.
 * Retourne { season, episodes: [..] | null (pack de saison complet) } ou null.
 */
export function parseReleaseEpisode(name) {
  const s = String(name || '');
  let m;
  // Plages : "S01E01-E03", "S01E01E02"
  if ((m = /S(\d{1,2})E(\d{1,3})(?:[-_ ]?E?(\d{1,3}))?(?![\d])/i.exec(s))) {
    const a = +m[2];
    const b = m[3] ? +m[3] : a;
    return { season: +m[1], episodes: range(a, b) };
  }
  // "1x02", "1x01-02"
  if ((m = /(?:^|[^\dx])(\d{1,2})x(\d{1,3})(?:-(\d{1,3}))?(?![\dp])/i.exec(s))) {
    return { season: +m[1], episodes: range(+m[2], m[3] ? +m[3] : +m[2]) };
  }
  // "601@603" (sous-titres.eu : épisodes 1 à 3 de la saison 6)
  if ((m = /(?:^|\D)(\d{1,2})(\d{2})@(\d{1,2})(\d{2})(?!\d)/.exec(s)) && m[1] === m[3]) {
    return { season: +m[1], episodes: range(+m[2], +m[4]) };
  }
  // Pack de saison "S04", "Season 4", "Saison 4"
  if ((m = /(?:^|[^a-z0-9])(?:S|Season[ ._-]?|Saison[ ._-]?)(\d{1,2})(?![\dE])/i.exec(s))) {
    return { season: +m[1], episodes: null };
  }
  // "Breaking.Bad.516" : 3 chiffres isolés après le titre (SEE), en évitant les années et 720/1080
  if ((m = /[ ._-](\d)(\d{2})[ ._-]/.exec(s)) && !/^(720|480|264|265|576)$/.test(m[1] + m[2])) {
    return { season: +m[1], episodes: [+m[2]] };
  }
  return null;
}

function range(a, b) {
  const out = [];
  for (let i = a; i <= Math.max(a, b) && out.length < 60; i++) out.push(i);
  return out;
}

/** Le fichier/release correspond-il à l'épisode demandé ? 'exact' | 'pack' | 'wrong' | 'unknown' */
export function episodeMatch(name, season, episode) {
  if (season == null || episode == null) return 'unknown';
  const p = parseReleaseEpisode(name);
  if (!p) return 'unknown';
  if (p.season !== season) return 'wrong';
  if (!p.episodes) return 'pack';
  if (!p.episodes.includes(episode)) return 'wrong';
  return p.episodes.length === 1 ? 'exact' : 'pack';
}

// Mots-clés de release qui permettent de rapprocher le nom du sous-titre de la page regardée.
const RELEASE_TAGS = ['web-dl', 'webdl', 'webrip', 'web', 'bluray', 'bdrip', 'brrip', 'hdtv', 'dvdrip', 'hdrip', 'amzn', 'nf', 'dsnp', 'hmax', 'atvp', 'proper', 'repack', '720p', '1080p', '2160p', 'x264', 'x265', 'hevc'];
const PENALTY = /\b(making[ .-]?of|trailer|bande[ .-]?annonce|commentary|commentaire|featurette|extras?|bonus|forced|sdh)\b/i;

function releaseTokens(s) {
  return normalize(String(s).replace(/web[ .-]?dl/gi, 'webdl')).split(' ').filter((w) => w.length > 1);
}

/**
 * Score d'un résultat. `query` = { title, year, season, episode, lang }, `pageContext` = titre + URL de la page.
 * Les résultats « mauvais épisode » reçoivent -Infinity (filtrés).
 */
export function scoreResult(r, query, pageContext = '') {
  let score = 0;
  const why = [];
  const sim = titleSimilarity(query.title, r.title || r.release || '');
  score += sim * 40;

  if (query.year && r.year) {
    if (Math.abs(query.year - r.year) <= 1) score += 10;
    else score -= 15;
  }

  if (query.season != null && query.episode != null) {
    const em = r.episodeMatch || episodeMatch(r.release, query.season, query.episode);
    if (em === 'wrong') return { score: -Infinity, why: ['mauvais épisode'] };
    if (em === 'exact') score += 30;
    else if (em === 'pack') score += 18;
  }

  if (r.lang && query.lang) score += r.lang === query.lang ? 20 : -40;
  if (r.downloads) score += Math.min(12, Math.log10(r.downloads + 1) * 3);
  if (r.rating) score += Math.min(6, r.rating);
  if (r.hearingImpaired) score -= 2;
  if (PENALTY.test(r.release || '') && !PENALTY.test(query.title)) score -= 30;

  // Correspondance de release : le nom du sous-titre partage des tags avec la page (titre/URL)
  const ctxTokens = new Set(releaseTokens(pageContext));
  const tagHits = releaseTokens(r.release || '').filter((w) => RELEASE_TAGS.map((t) => t.replace('-', '')).includes(w) && ctxTokens.has(w));
  const releaseMatch = tagHits.length > 0;
  if (releaseMatch) {
    score += Math.min(15, tagHits.length * 5);
    why.push(`release : ${tagHits.join(', ')}`);
  }
  return { score: Math.round(score * 10) / 10, releaseMatch, why };
}

/** Fusionne, dédoublonne et trie les résultats de toutes les sources. */
export function rankResults(all, query, pageContext = '') {
  const seen = new Map();
  for (const r of all) {
    const { score, releaseMatch, why } = scoreResult(r, query, pageContext);
    if (score === -Infinity) continue;
    const item = { ...r, score, releaseMatch, why };
    // Même fichier exposé deux fois (même source + même URL) ou même release sur la même source
    const k = `${r.provider}|${r.url}`;
    const k2 = `${r.provider}|${normalize(r.release)}`;
    const prev = seen.get(k) || seen.get(k2);
    if (prev && prev.score >= score) continue;
    seen.set(k, item);
    seen.set(k2, item);
  }
  return [...new Set(seen.values())].sort((a, b) => b.score - a.score);
}
