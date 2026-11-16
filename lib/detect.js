// Détection du contenu regardé à partir du titre d'onglet, de l'URL et de og:title.
// Module pur (aucune API Chrome) : testé sous Node.
//
// detectContent({ title, url, ogTitle }) → { title, year?, season?, episode?, type: 'movie'|'episode' }

// Mots « de remplissage » des sites de streaming, retirés du titre.
const NOISE_WORDS = [
  'en streaming', 'en vf', 'en vostfr', 'regarder', 'voir', 'streaming', 'stream', 'gratuit', 'gratuitement', 'complet', 'en ligne', 'en francais', 'en français',
  'film complet', 'serie complete', 'série complète', 'vf', 'vostfr', 'vost', 'vo', 'vff', 'vfq', 'truefrench', 'french', 'multi',
  'hd', 'full hd', 'uhd', '4k', '720p', '1080p', '2160p', 'hdrip', 'webrip', 'web-dl', 'bluray', 'online', 'watch', 'free',
  'full movie', 'episode complet', 'épisode complet', 'film', 'serie', 'série', 'tv series', 'tv show', 'replay', 'direct',
];
// Segments qui ressemblent à un nom de site (retirés quand on découpe sur " - ", " | "…)
const SITE_HINT = /(\.(com|net|org|fr|tv|io|co|cc|to|me|ws|lol|top|xyz|site|online|app|watch|stream)\b)|\b(netflix|prime video|amazon|disney\+?|canal\+?|youtube|dailymotion|vimeo|crunchyroll|molotov|france\.tv|arte|mycanal|hbo|max|apple tv\+?|streaming|stream)\b/i;

const SEP_RE = /\s+[-|–—·•:]{1,2}\s+|\s*\|\s*|\s+::\s+/;

/** Extrait saison / épisode d'un texte libre. Retourne { season, episode, index, length } ou null. */
export function extractSeasonEpisode(text) {
  if (!text) return null;
  const patterns = [
    // S01E02, s1e2, S01 E02, S01.E02, S01xE02
    [/\bS(\d{1,2})[\s._-]*x?E[\s._-]*(\d{1,4})\b/i, 1, 2],
    // Saison 1 Épisode 2 / Saison 1 - Ép. 2 / saison-1/episode-2 (URL)
    [/(?<![\p{L}\d])saisons?[\s._/-]*(\d{1,2})(?!\d)[^\d]{0,25}?(?<![\p{L}\d])(?:[ée]pisodes?|[ée]p)\.?[\s._/-]*(\d{1,4})(?!\d)/iu, 1, 2],
    // Season 1 Episode 2 / season-1-episode-2
    [/\bseasons?[\s._/-]*(\d{1,2})\b[^\d]{0,25}?\b(?:episodes?|ep)\.?[\s._/-]*(\d{1,4})\b/i, 1, 2],
    // 1x02 (pas 1920x1080 : 1–2 chiffres puis 1–3 chiffres, bornés)
    [/(?:^|[^\dx])(\d{1,2})x(\d{1,3})(?![\dp])/i, 1, 2],
  ];
  for (const [re, si, ei] of patterns) {
    const m = re.exec(text);
    if (m) return { season: Number(m[si]), episode: Number(m[ei]), index: m.index, length: m[0].length };
  }
  // Épisode seul : "Ep 2", "Episode 12", "Épisode 3" (+ éventuellement saison ailleurs : "Saison 2", "S2")
  const em = /(?<![\p{L}\d])(?:[ée]pisodes?|ep|eps)\.?[\s._/-]*(\d{1,4})(?!\d)/iu.exec(text);
  if (em) {
    const sm = /\b(?:saison|season)[\s._/-]*(\d{1,2})\b|\bS(\d{1,2})\b/i.exec(text);
    return {
      season: sm ? Number(sm[1] || sm[2]) : 1,
      episode: Number(em[1]),
      index: sm && sm.index < em.index ? sm.index : em.index,
      length: em[0].length,
    };
  }
  return null;
}

/** Extrait une année plausible (entre parenthèses de préférence). */
export function extractYear(text) {
  const max = new Date().getFullYear() + 2;
  const valid = (y) => y >= 1900 && y <= max;
  const p = /[([](\d{4})[)\]]/.exec(text);
  if (p && valid(+p[1])) return { year: +p[1], match: p[0] };
  // Année « nue » : seulement si ce n'est pas tout le titre (ex. le film "1917")
  const re = /(?:^|[\s._-])((?:19|20)\d{2})(?=$|[\s._-])/g;
  let m;
  let found = null;
  while ((m = re.exec(text))) if (valid(+m[1]) && text.trim() !== m[1]) found = { year: +m[1], match: m[1] };
  return found;
}

/** Nettoie un titre brut d'onglet : retire le nom du site, les mots de bruit, la ponctuation de décor. */
export function cleanTitle(raw) {
  if (!raw) return '';
  let s = raw.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
  // Compteurs de notifications "(3) Titre"
  s = s.replace(/^\(\d+\)\s*/, '');
  const segments = s.split(SEP_RE).map((x) => x.trim()).filter(Boolean);
  let parts = segments.filter((seg) => !SITE_HINT.test(seg) && !isOnlyNoise(seg));
  if (!parts.length) parts = segments;
  // Le segment qui contient S/E est le meilleur candidat, sinon le premier (le titre vient d'abord en général)
  // … sauf si ce segment ne contient que le marqueur (« Titre - Saison 3 - Épisode 4 ») : on prend alors le premier.
  const seIdx = parts.findIndex((p) => {
    const se = extractSeasonEpisode(p);
    return se && stripNoise(p.slice(0, se.index)).length > 0;
  });
  let best = seIdx >= 0 ? parts[seIdx] : parts[0] || '';
  // Si le premier segment n'est qu'un préfixe (« Regarder »), on a déjà filtré ; on enlève maintenant le bruit interne.
  best = stripNoise(best);
  return best;
}

function isOnlyNoise(seg) {
  return stripNoise(seg).length === 0;
}

function stripNoise(s) {
  let out = ` ${s} `;
  // Les mots composés d'abord (« film complet » avant « film »)
  const words = [...NOISE_WORDS].sort((a, b) => b.length - a.length);
  for (const w of words) {
    const re = new RegExp(`(^|[\\s(\\[._-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s)\\]._,:-])`, 'gi');
    out = out.replace(re, '$1');
  }
  return out
    .replace(/[([]\s*[)\]]/g, '') // parenthèses vidées
    .replace(/\s+[-–:|]+\s*$/g, '')
    .replace(/^\s*[-–:|]+\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Transforme un slug d'URL en titre exploitable. */
export function titleFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const segs = u.pathname
    .split('/')
    .map((x) => decodeURIComponent(x).replace(/\.(html?|php|aspx?)$/i, ''))
    .filter(Boolean);
  // On cherche le segment qui précède "saison-x"/"season-x"/"episode-x", sinon le plus long segment textuel.
  const seIdx = segs.findIndex((x) => /^(saison|season|s\d+|episode|ep)[-_]?\d*/i.test(x));
  const candidates = (seIdx > 0 ? segs.slice(0, seIdx) : segs)
    .map((x) => x.replace(/^\d+[-_]/, '')) // "12345-inception"
    .filter((x) => /[a-z]/i.test(x) && !/^(watch|film|films|movie|movies|serie|series|tv|show|shows|streaming|regarder|voir|player|embed|video|videos|fr|en|vf|vostfr)$/i.test(x));
  let seg = seIdx > 0 ? candidates[candidates.length - 1] : candidates.sort((a, b) => b.length - a.length)[0];
  if (!seg) return '';
  // On coupe ce qui suit un marqueur S/E dans le slug ("breaking-bad-s05e16-felina")
  seg = seg.replace(/[-_.](s\d{1,2}[-_.]?e\d{1,3}|\d{1,2}x\d{1,3}|saison[-_]\d+|season[-_]\d+).*$/i, '');
  return seg.replace(/[-_.+]+/g, ' ').trim();
}

/** Point d'entrée. */
export function detectContent({ title = '', url = '', ogTitle = '' } = {}) {
  const sources = [ogTitle, title].filter((x) => x && x.trim());
  let se = null;
  let year = null;
  let name = '';

  for (const src of sources) {
    const s = extractSeasonEpisode(src);
    if (s && !se) se = s;
    const cleaned = cleanTitle(src);
    if (cleaned && !name) name = cleaned;
    if (!year) year = extractYear(src);
  }
  // L'URL complète les informations manquantes (ex. "saison-1/episode-2")
  const urlText = safeDecode(url);
  if (!se) se = extractSeasonEpisode(urlPath(urlText));
  const slugTitle = titleFromUrl(url);
  if (!name || isGeneric(name)) name = slugTitle || name;
  if (!year) year = extractYear(urlPath(urlText));

  // Retire du titre ce qui suit le marqueur S/E et l'année
  let t = name;
  const seInName = extractSeasonEpisode(t);
  if (seInName) t = t.slice(0, seInName.index);
  if (year) t = t.replace(year.match, ' ');
  t = stripNoise(t.replace(/[._]+/g, ' '))
    .replace(/\s*[-–:,]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) t = stripNoise(name);

  const result = { title: t, type: se ? 'episode' : 'movie' };
  // Le film « 1917 » : l'année détectée est en fait le titre
  if (year && String(year.year) !== t) result.year = year.year;
  if (se) {
    result.season = se.season;
    result.episode = se.episode;
  }
  return result;
}

function isGeneric(name) {
  return name.length < 2 || /^(accueil|home|lecteur|lecteur vid[ée]o|player|video player|video|vidéo|untitled|sans titre|watch)$/i.test(name);
}

function safeDecode(u) {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}

function urlPath(u) {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
}
