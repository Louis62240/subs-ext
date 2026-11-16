// Tests du classement : `node test/match.test.mjs`
import { normalize, titleSimilarity, episodeMatch, parseReleaseEpisode, rankResults, scoreResult } from '../lib/match.js';
import { test, eq, ok, done } from './mini-test.mjs';

test('normalisation (accents, ponctuation, &)', () => {
  eq(normalize("L'Été & l'Amour !"), 'l ete and l amour');
});

test('similarité : articles ignorés', () => {
  eq(titleSimilarity('The Office', 'office'), 1);
  ok(titleSimilarity('The Office', 'The Office (US)') > 0.8);
  ok(titleSimilarity('Breaking Bad', 'Men Behaving Badly') < 0.3);
});

test('épisodes dans les noms de fichiers', () => {
  eq(parseReleaseEpisode('Breaking.Bad.S04E08.1080p.BluRay'), { season: 4, episodes: [8] });
  eq(parseReleaseEpisode('Breaking.Bad.5x16.FR.FBK.zip'), { season: 5, episodes: [16] });
  eq(parseReleaseEpisode('Breaking.Bad.516.720p.immerse.FR.ass'), { season: 5, episodes: [16] });
  eq(parseReleaseEpisode('The.Chosen.601@603.DVDRip.Z2.AMZN.FR.zip'), { season: 6, episodes: [1, 2, 3] });
  eq(parseReleaseEpisode('Breaking.Bad.S04.DVDRip.Z2.DDLTV.FR.zip'), { season: 4, episodes: null });
  eq(parseReleaseEpisode('Inception.(2010).Z1.ARROW.zip'), null);
  eq(parseReleaseEpisode('Movie.1080p.x264'), null);
});

test('correspondance épisode', () => {
  eq(episodeMatch('Breaking.Bad.5x16.FR.zip', 5, 16), 'exact');
  eq(episodeMatch('Breaking.Bad.S05.FR.zip', 5, 16), 'pack');
  eq(episodeMatch('Breaking.Bad.5x15.FR.zip', 5, 16), 'wrong');
  eq(episodeMatch('Breaking.Bad.S04.FR.zip', 5, 16), 'wrong');
});

test('classement : bon épisode, langue, popularité, release', () => {
  const q = { title: 'Breaking Bad', season: 5, episode: 16, lang: 'fr' };
  const res = rankResults(
    [
      { provider: 'a', url: '1', title: 'Breaking Bad', release: 'Breaking.Bad.5x15.FR', lang: 'fr' },
      { provider: 'a', url: '2', title: 'Breaking Bad', release: 'Breaking.Bad.5x16.HDTV.FR', lang: 'fr', downloads: 10 },
      { provider: 'b', url: '3', title: 'Breaking Bad', release: 'Breaking.Bad.5x16.720p.WEB-DL', lang: 'fr', downloads: 10 },
      { provider: 'b', url: '4', title: 'Breaking Bad', release: 'Breaking.Bad.S05.FR', lang: 'fr' },
    ],
    q,
    'Breaking Bad S05E16 WEB-DL 720p',
  );
  eq(res.map((r) => r.url), ['3', '2', '4']);
  ok(res[0].releaseMatch, 'release reconnue');
});

test('making-of pénalisé', () => {
  const q = { title: 'Inception', year: 2010, lang: 'fr' };
  const a = scoreResult({ title: 'Inception', year: 2010, release: 'Inception.Making.of.2010.BluRay', lang: 'fr' }, q).score;
  const b = scoreResult({ title: 'Inception', year: 2010, release: 'Inception.2010.BluRay.720p', lang: 'fr' }, q).score;
  ok(b > a, `${b} > ${a}`);
});

done();
