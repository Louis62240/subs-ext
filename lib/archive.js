// Extraction du bon fichier de sous-titres depuis un téléchargement (zip ou fichier brut).
import { unzipSync } from '../vendor/fflate.esm.js';
import { parseReleaseEpisode } from './match.js';

const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;
const EXT_BONUS = { srt: 6, vtt: 5, ass: 2, ssa: 1 };

// Marqueurs de langue dans les noms de fichiers (« .fr. », « VF », « French »…)
const LANG_MARKERS = {
  fr: /(^|[^a-z])(fr|fre|fra|french|francais|vf|vff|vfq)([^a-z]|$)/i,
  en: /(^|[^a-z])(en|eng|english|vo|vost)([^a-z]|$)/i,
};

export function isZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Score d'un fichier de l'archive pour la demande donnée (-Infinity = à exclure). */
export function scoreEntry(name, { season, episode, lang = 'fr' } = {}) {
  const base = name.split('/').pop();
  if (!SUB_EXT.test(base) || /(^|\/)__MACOSX\//.test(name) || base.startsWith('._')) return -Infinity;
  let score = EXT_BONUS[base.split('.').pop().toLowerCase()] || 0;
  if (season != null && episode != null) {
    const p = parseReleaseEpisode(base);
    if (p && p.season === season && p.episodes?.length === 1 && p.episodes[0] === episode) score += 100;
    else if (p && (p.season !== season || (p.episodes && !p.episodes.includes(episode)))) return -Infinity;
  }
  const stem = base.replace(SUB_EXT, '');
  for (const [code, re] of Object.entries(LANG_MARKERS)) {
    if (re.test(stem)) score += code === lang ? 20 : -20;
  }
  // « NoTAG » = sans le générique de l'équipe de traduction : préférable à l'écran
  if (/notag/i.test(stem)) score += 1;
  return score;
}

/**
 * Retourne { filename, bytes } du meilleur sous-titre.
 * `query` : { season, episode, lang } pour choisir dans un pack.
 */
export function extractSubtitle(bytes, filename, query = {}) {
  if (!isZip(bytes)) {
    if (/\.(rar|7z)$/i.test(filename)) throw new Error('archive RAR/7z non prise en charge');
    return { filename, bytes };
  }
  // On ne décompresse que les fichiers qui ressemblent à des sous-titres
  const files = unzipSync(bytes, { filter: (f) => SUB_EXT.test(f.name) && !/__MACOSX/.test(f.name) });
  const ranked = Object.keys(files)
    .map((name) => ({ name, score: scoreEntry(name, query) }))
    .filter((x) => x.score > -Infinity && files[x.name].length > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) {
    const any = Object.keys(files).length;
    throw new Error(any ? "l'épisode demandé n'est pas dans l'archive" : 'aucun fichier de sous-titres dans l’archive');
  }
  const best = ranked[0];
  return { filename: best.name.split('/').pop(), bytes: files[best.name] };
}
