// Tests de l'extraction d'archives sur de vrais zips téléchargés : `node test/archive.test.mjs`
import { readFileSync } from 'node:fs';
import { extractSubtitle, scoreEntry } from '../lib/archive.js';
import { parseSubtitleBytes } from '../lib/subtitles.js';
import { test, eq, ok, done } from './mini-test.mjs';

const zip = (n) => new Uint8Array(readFileSync(new URL(`fixtures/files/${n}`, import.meta.url)));

test('zip multi-versions : préfère .srt NoTAG à .ass', () => {
  const r = extractSubtitle(zip('sstitres-Breaking.Bad.5x16.FR.FBK.zip'), 'x.zip', { season: 5, episode: 16, lang: 'fr' });
  ok(r.filename.endsWith('.srt') && /notag/i.test(r.filename), r.filename);
  ok(parseSubtitleBytes(r.bytes, r.filename).length > 300);
});

test('zip ENFR : choisit le fichier VF', () => {
  const r = extractSubtitle(zip('sstitres-Breaking.Bad.1x07.ENFR.zip'), 'x.zip', { season: 1, episode: 7, lang: 'fr' });
  ok(/\.VF\.srt$/.test(r.filename), r.filename);
});

test('pack de saison : choisit l’épisode demandé', () => {
  const r = extractSubtitle(zip('sstitres-Breaking.Bad.S04.zip'), 'x.zip', { season: 4, episode: 6, lang: 'fr' });
  eq(r.filename, 'Breaking.Bad.S04E06.1080p.BluRay.AAC.5.1.x265-DDLTV.FR.srt');
});

test('pack de saison : épisode absent → erreur claire', () => {
  let msg = '';
  try { extractSubtitle(zip('sstitres-Breaking.Bad.S04.zip'), 'x.zip', { season: 4, episode: 40, lang: 'fr' }); } catch (e) { msg = e.message; }
  ok(/pas dans l'archive/.test(msg), msg);
});

test('zip tvsubtitles (1 fichier)', () => {
  const r = extractSubtitle(zip('tvsubtitles-bb-5x16.fr.zip'), 'x.zip', { season: 5, episode: 16, lang: 'fr' });
  eq(r.filename, 'Breaking Bad - 5x16 - Felina.HDTV.ASAP-IMMERSE.fr.srt');
  const cues = parseSubtitleBytes(r.bytes, r.filename);
  ok(cues.some((c) => /[éèàç]/.test(c.text)), 'accents décodés');
});

test('fichier brut non zippé', () => {
  const b = new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nx\n');
  eq(extractSubtitle(b, 'a.srt').filename, 'a.srt');
});

test('ignore les non-sous-titres et __MACOSX', () => {
  eq(scoreEntry('readme.txt'), -Infinity);
  eq(scoreEntry('__MACOSX/._a.srt'), -Infinity);
});

done();
