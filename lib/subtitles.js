// Parsing des sous-titres (SRT, VTT, ASS/SSA basique) et décodage d'encodage.
// Module pur : utilisable dans le service worker, le popup, et sous Node pour les tests.
//
// Sortie commune : [{ start, end, text }] trié, en secondes.
// `text` ne contient que du texte échappé + les balises <i>, <b>, <u> (et \n pour les retours).
// Le rendu (content.js) reconstruit le DOM à partir de ce format restreint : jamais d'innerHTML.

/**
 * Décode les octets d'un fichier de sous-titres.
 * UTF-8 strict d'abord ; en cas d'échec, Windows-1252 (sur-ensemble pratique d'ISO-8859-1,
 * l'encodage de la plupart des vieux .srt français).
 */
export function decodeBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // UTF-16 avec BOM (rare mais existe)
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, '');
  } catch {
    // Certains environnements (Node) décodent « windows-1252 » comme du Latin-1 pur :
    // on corrige la plage 0x80–0x9F (œ, €, …, guillemets typographiques) explicitement.
    return new TextDecoder('windows-1252').decode(u8).replace(/[\u0080-\u009f]/g, (c) => CP1252[c.charCodeAt(0) - 0x80] || c);
  }
}

// Table Windows-1252 pour 0x80–0x9F ('' = non défini)
const CP1252 = [
  '€', '', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '', 'Ž', '',
  '', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '', 'ž', 'Ÿ',
];

/** Détecte le format à partir du contenu (le nom de fichier sert d'indice). */
export function detectFormat(text, filename = '') {
  const head = text.slice(0, 2000);
  if (/^\s*WEBVTT/.test(head)) return 'vtt';
  if (/^\s*\[Script Info\]/im.test(head) || /^\s*Dialogue:/m.test(text.slice(0, 20000))) return 'ass';
  const ext = (filename.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (ext === 'vtt') return 'vtt';
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  return 'srt';
}

/** Point d'entrée : texte → cues. */
export function parseSubtitles(text, filename = '') {
  const format = detectFormat(text, filename);
  const cues = format === 'ass' ? parseAss(text) : parseSrtOrVtt(text);
  return cues
    .filter((c) => c.text.trim() && c.end > c.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Octets → cues (décodage + parsing). */
export function parseSubtitleBytes(bytes, filename = '') {
  return parseSubtitles(decodeBytes(bytes), filename);
}

// --- Horodatages -----------------------------------------------------------

// Accepte "01:02:03,456", "01:02:03.456", "02:03.456" (VTT court), "1:02:03:45" (rare), virgule/point.
const TS = String.raw`(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[,.:](\d{1,3}))?`;
const TIMING_RE = new RegExp(String.raw`^\s*${TS}\s*-->\s*${TS}`);

function toSeconds(h, m, s, ms) {
  const frac = ms ? Number(ms.padEnd(3, '0')) / 1000 : 0;
  return Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + frac;
}

// --- SRT / VTT -------------------------------------------------------------

/**
 * Parse SRT et VTT avec la même machine à états : on cherche les lignes de timing,
 * tout ce qui suit jusqu'à une ligne vide (ou la prochaine ligne de timing) est le texte.
 * Robuste aux numéros manquants, lignes vides multiples, \r\n, BOM, en-têtes VTT, NOTE, STYLE.
 */
function parseSrtOrVtt(text) {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      // Retire un éventuel numéro de cue collé à la fin (cas des blocs sans ligne vide)
      while (cur.lines.length && /^\d+$/.test(cur.lines[cur.lines.length - 1].trim())) cur.lines.pop();
      const t = sanitizeCueText(cur.lines.join('\n'));
      if (t) cues.push({ start: cur.start, end: cur.end, text: t });
    }
    cur = null;
  };
  for (const line of lines) {
    const m = TIMING_RE.exec(line);
    if (m) {
      flush();
      cur = { start: toSeconds(m[1], m[2], m[3], m[4]), end: toSeconds(m[5], m[6], m[7], m[8]), lines: [] };
      continue;
    }
    if (!cur) continue; // en-tête, numéro, NOTE, STYLE…
    if (line.trim() === '') {
      if (cur.lines.length) flush();
      continue;
    }
    cur.lines.push(line);
  }
  flush();
  return cues;
}

// --- ASS / SSA -------------------------------------------------------------

/** Extraction basique : lignes Dialogue de la section [Events], selon l'en-tête Format. */
function parseAss(text) {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  const cues = [];
  for (const line of lines) {
    const fm = /^\s*Format:\s*(.*)$/i.exec(line);
    if (fm && /text/i.test(fm[1])) {
      fields = fm[1].split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    const dm = /^\s*Dialogue:\s*(.*)$/i.exec(line);
    if (!dm) continue;
    // Le champ Text est le dernier et peut contenir des virgules.
    const parts = dm[1].split(',');
    const head = parts.slice(0, fields.length - 1);
    const rawText = parts.slice(fields.length - 1).join(',');
    const get = (name) => head[fields.indexOf(name)]?.trim();
    const start = assTime(get('start'));
    const end = assTime(get('end'));
    if (start == null || end == null) continue;
    const t = sanitizeCueText(assToMarkup(rawText));
    if (t) cues.push({ start, end, text: t });
  }
  return cues;
}

function assTime(s) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(s || '');
  if (!m) return null;
  // ASS : centisecondes ("0:00:01.50" = 1,5 s)
  const frac = m[4].length === 2 ? Number(m[4]) / 100 : Number(m[4].padEnd(3, '0')) / 1000;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

/** Convertit les balises ASS utiles ({\i1}, {\b1}, {\u1}) en <i>/<b>/<u>, supprime les autres. */
function assToMarkup(s) {
  return s
    .replace(/\{([^}]*)\}/g, (_, inner) => {
      let out = '';
      for (const m of inner.matchAll(/\\([ibu])([01])(?![0-9])/g)) out += m[2] === '1' ? `<${m[1]}>` : `</${m[1]}>`;
      return out;
    })
    .replace(/\\N/gi, '\n')
    .replace(/\\h/g, ' ');
}

// --- Assainissement --------------------------------------------------------

const ALLOWED = new Set(['i', 'b', 'u']);

/**
 * Ne garde que <i>, <b>, <u> (équilibrées), échappe tout le reste.
 * Résultat : chaîne sûre au format restreint, interprétée par renderMarkup() côté content.
 */
export function sanitizeCueText(raw) {
  // Balises ASS résiduelles dans des SRT ({\an8}, {\i1}…) : on convertit puis on retire.
  let s = raw.includes('{\\') ? assToMarkup(raw) : raw;
  s = s.replace(/<br\s*\/?>/gi, '\n');
  const out = [];
  const open = [];
  // Une balise commence par une lettre collée au "<" (sinon "a < b" serait pris pour une balise).
  const re = /<(\/?)([a-z][a-z0-9]*)(?:[\s.\/][^<>]*)?>/gi;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    out.push(escapeText(s.slice(last, m.index)));
    last = re.lastIndex;
    const tag = m[2].toLowerCase();
    if (!ALLOWED.has(tag)) continue; // <font>, <c.yellow>, etc. : supprimées
    if (m[1]) {
      const idx = open.lastIndexOf(tag);
      if (idx === -1) continue;
      // ferme proprement ce qui a été ouvert après
      for (let k = open.length - 1; k >= idx; k--) out.push(`</${open[k]}>`);
      const reopen = open.splice(idx).slice(1);
      for (const t of reopen) { out.push(`<${t}>`); open.push(t); }
    } else {
      out.push(`<${tag}>`);
      open.push(tag);
    }
  }
  out.push(escapeText(s.slice(last)));
  for (let k = open.length - 1; k >= 0; k--) out.push(`</${open[k]}>`);
  return out
    .join('')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l || (i > 0 && i < arr.length - 1))
    .join('\n')
    .replace(/<([ibu])><\/\1>/g, '')
    .trim();
}

function escapeText(t) {
  // Les entités HTML courantes dans les SRT (&amp; &quot;…) sont d'abord décodées, puis tout est échappé.
  return t
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' })[e])
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
