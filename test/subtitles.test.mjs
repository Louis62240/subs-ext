// Tests du parsing / décodage : `node test/subtitles.test.mjs`
import { readFileSync } from 'node:fs';
import { decodeBytes, parseSubtitles, parseSubtitleBytes, sanitizeCueText } from '../lib/subtitles.js';
import { test, eq, ok, done } from './mini-test.mjs';

const here = new URL('.', import.meta.url);

test('décodage UTF-8 avec BOM', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('été')]);
  eq(decodeBytes(bytes), 'été');
});

test('repli Windows-1252 (é è à ç œ)', () => {
  // "é è à ç œ €" en cp1252
  const bytes = new Uint8Array([0xe9, 0x20, 0xe8, 0x20, 0xe0, 0x20, 0xe7, 0x20, 0x9c, 0x20, 0x80]);
  eq(decodeBytes(bytes), 'é è à ç œ €');
});

test('SRT basique \\r\\n + virgules', () => {
  const c = parseSubtitles('1\r\n00:00:01,000 --> 00:00:02,500\r\nBonjour\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nLigne 1\r\nLigne 2\r\n');
  eq(c.length, 2);
  eq(c[0], { start: 1, end: 2.5, text: 'Bonjour' });
  eq(c[1].text, 'Ligne 1\nLigne 2');
});

test('SRT : numéros manquants, lignes vides multiples, point dans le timestamp', () => {
  const c = parseSubtitles('\n\n00:00:01.000 --> 00:00:02.000\nA\n\n\n\n00:00:05,1 --> 00:00:06,25\nB\n3\n00:00:07,000 --> 00:00:08,000\nC');
  eq(c.map((x) => x.text), ['A', 'B', 'C']);
  eq(c[1].start, 5.1);
  eq(c[1].end, 6.25);
});

test('SRT non trié → trié', () => {
  const c = parseSubtitles('2\n00:00:10,000 --> 00:00:11,000\nB\n\n1\n00:00:01,000 --> 00:00:02,000\nA\n');
  eq(c.map((x) => x.text), ['A', 'B']);
});

test('VTT avec en-tête, NOTE, identifiants, réglages et heures omises', () => {
  const c = parseSubtitles('WEBVTT\nKind: captions\n\nNOTE commentaire\n\nintro\n00:01.000 --> 00:02.000 align:start line:90%\n<c.yellow>Salut</c> <i>toi</i>\n\n01:00:00.000 --> 01:00:01.000\nFin');
  eq(c.length, 2);
  eq(c[0].text, 'Salut <i>toi</i>');
  eq(c[1].start, 3600);
});

test('Balises : garde i/b/u, supprime font, échappe le reste', () => {
  eq(sanitizeCueText('<font color="#ff0">Jaune</font> <i>italique</i>'), 'Jaune <i>italique</i>');
  eq(sanitizeCueText('<script>alert(1)</script>x'), 'alert(1)x');
  eq(sanitizeCueText('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  eq(sanitizeCueText('<img src=x onerror=alert(1)>ok'), 'ok');
  eq(sanitizeCueText('<i>non fermé'), '<i>non fermé</i>');
  eq(sanitizeCueText('<I>Maj</I>'), '<i>Maj</i>');
  eq(sanitizeCueText('{\\an8}<i>Haut</i>'), '<i>Haut</i>');
});

test('ASS : Dialogue, virgules dans le texte, balises {\\...}, \\N', () => {
  const ass = `[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\pos(10,10)}Bonjour, {\\i1}monde{\\i0}\\Nligne 2\nComment: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,ignoré\n`;
  const c = parseSubtitles(ass, 'x.ass');
  eq(c.length, 1);
  eq(c[0], { start: 1.5, end: 3, text: 'Bonjour, <i>monde</i>\nligne 2' });
});

test('Fixture réelle addic7ed (ISO-8859-1, CRLF)', () => {
  const bytes = readFileSync(new URL('sample-addic7ed-iso8859.srt', here));
  const c = parseSubtitleBytes(bytes, 'a.srt');
  ok(c.length > 400, `cues: ${c.length}`);
  eq(c[0].text, 'Ramène-moi chez moi.');
  ok(c.every((x) => !x.text.includes('�')), 'pas de caractère de remplacement');
});

test('Fichier de test cp1252 (accents + <i>)', () => {
  const bytes = readFileSync(new URL('media/test-cp1252.srt', here));
  const c = parseSubtitleBytes(bytes);
  ok(c.some((x) => x.text.includes('œ')), 'œ présent');
  ok(c.some((x) => x.text.includes('<i>')), '<i> présent');
});

done();
