// Tests de la détection : `node test/detect.test.mjs`
import { detectContent } from '../lib/detect.js';
import { test, eq, done } from './mini-test.mjs';

const cases = [
  // [entrée, attendu]
  [{ title: 'Breaking Bad S05E16 - Felina | MonSiteStreaming' }, { title: 'Breaking Bad', type: 'episode', season: 5, episode: 16 }],
  [{ title: 'Regarder The Office s2e1 en streaming VF' }, { title: 'The Office', type: 'episode', season: 2, episode: 1 }],
  [{ title: 'Lupin 1x02 VOSTFR - Streaming HD' }, { title: 'Lupin', type: 'episode', season: 1, episode: 2 }],
  [{ title: 'Dark Saison 1 Épisode 2 en streaming' }, { title: 'Dark', type: 'episode', season: 1, episode: 2 }],
  [{ title: 'Stranger Things Season 4 Episode 9 - Watch online' }, { title: 'Stranger Things', type: 'episode', season: 4, episode: 9 }],
  [{ title: 'One Piece Ep 1071 VOSTFR' }, { title: 'One Piece', type: 'episode', season: 1, episode: 1071 }],
  [{ title: 'Inception (2010) - Film complet en streaming VF HD' }, { title: 'Inception', type: 'movie', year: 2010 }],
  [{ title: 'Regarder Le Fabuleux Destin d\'Amélie Poulain (2001) en streaming' }, { title: 'Le Fabuleux Destin d\'Amélie Poulain', type: 'movie', year: 2001 }],
  [{ title: 'Dune: Part Two (2024) | Streaming' }, { title: 'Dune: Part Two', type: 'movie', year: 2024 }],
  [{ title: '1917 - Streaming VF' }, { title: '1917', type: 'movie' }],
  [{ title: 'Player', url: 'https://exemple.cc/serie/breaking-bad/saison-5/episode-16' }, { title: 'breaking bad', type: 'episode', season: 5, episode: 16 }],
  [{ title: 'Lecteur vidéo', url: 'https://site.to/film/12345-interstellar-2014.html' }, { title: 'interstellar', type: 'movie', year: 2014 }],
  [{ title: 'Breaking.Bad.S01E01.720p.BluRay.x264' }, { title: 'Breaking Bad', type: 'episode', season: 1, episode: 1 }],
  [{ title: 'Netflix', ogTitle: 'La Casa de Papel - Saison 3 - Épisode 4' }, { title: 'La Casa de Papel', type: 'episode', season: 3, episode: 4 }],
  [{ title: '(3) Severance S02 E05 – Apple TV+' }, { title: 'Severance', type: 'episode', season: 2, episode: 5 }],
  [{ title: 'The Bear (2022) S03E01 VOSTFR' }, { title: 'The Bear', type: 'episode', season: 3, episode: 1, year: 2022 }],
  [{ title: 'Watch', url: 'https://x.lol/watch/the-last-of-us-s01e03' }, { title: 'the last of us', type: 'episode', season: 1, episode: 3 }],
  [{ title: 'Oppenheimer 2023 1080p - Voir film' }, { title: 'Oppenheimer', type: 'movie', year: 2023 }],
  [{ title: 'Le Bureau des légendes – Saison 2 – Ép. 7 – myCANAL' }, { title: 'Le Bureau des légendes', type: 'episode', season: 2, episode: 7 }],
  [{ title: 'Video 1920x1080 test' }, { title: 'Video 1920x1080 test', type: 'movie' }],
];

for (const [input, expected] of cases) {
  test(`${input.ogTitle || input.title}${input.url ? ' + ' + input.url : ''}`, () => {
    eq(detectContent(input), expected);
  });
}

done();
