# Sous-titres auto (extension Chrome MV3)

Trouve automatiquement des sous-titres **français** pour la vidéo regardée (n'importe quel site, y compris
les lecteurs dans des iframes cross-origin), les télécharge en **scrapant des sites publics** (aucune API,
aucune clé, aucun compte) et les affiche par-dessus la vidéo, synchronisés, avec réglage du décalage au clavier.

## Installation

1. `chrome://extensions` → activer le **mode développeur** (en haut à droite).
2. **« Charger l'extension non empaquetée »** → choisir le dossier `subs-ext/`.
3. Épingler l'icône. Les raccourcis globaux se règlent dans `chrome://extensions/shortcuts`.

Pas de build : JS vanilla, modules ES dans le service worker / popup / options.

## Utilisation

- Ouvrir une page avec une vidéo → cliquer l'icône. Le popup affiche la détection (titre, année, saison,
  épisode) **modifiable**, et l'état (« Vidéo détectée (1280×720, iframe) », sous-titre actif, décalage).
- **Chercher** : liste des résultats triés (release, source, téléchargements, note, « ✓ correspond à la release »).
  Clic → téléchargement + affichage immédiat.
- **Auto** : cherche et applique directement le meilleur résultat (essaie les 3 premiers si un téléchargement échoue).
- **Charger un fichier .srt** : secours manuel (.srt, .vtt, .ass, .ssa ou .zip).
- Contrôles : décalage −1 s / −0,1 / +0,1 / +1 s / 0, taille A−/A+, masquer, retirer.

### Raccourcis (dans la frame de la vidéo, style VLC)

| Touche | Action |
|---|---|
| `G` / `H` | décalage −0,1 s / +0,1 s |
| `Maj+G` / `Maj+H` | −1 s / +1 s |
| `V` | afficher / masquer |

Les touches sont ignorées dans les champs de saisie et ne sont interceptées **que si des sous-titres sont actifs**
dans l'onglet. Si le focus est dans la page principale alors que la vidéo est dans une iframe, la touche est
relayée à la frame de la vidéo. Raccourcis globaux (`chrome://extensions/shortcuts`) : `Alt+Maj+G/H/V`, plus
une commande « chercher et appliquer » sans touche par défaut.

Décalage positif = sous-titres affichés plus tard. Il est **mémorisé par contenu** et réappliqué.

## Sources : ce que j'ai réellement constaté (nov. 2026)

Exploration faite avec `curl` (User-Agent Chrome), puis validée par de vraies recherches **depuis l'extension**
dans Chromium (voir « Tests »). Pages sauvegardées dans `test/fixtures/`.

### Retenues (4)

| Source | Contenu | Format | Protection |
|---|---|---|---|
| **sous-titres.eu** | films + séries, site français | .zip | aucune rencontrée |
| **addic7ed.com** | séries + films | .srt brut (souvent ISO-8859-1) | **Referer obligatoire** |
| **tvsubtitles.net** | séries uniquement | .zip | aucune ; URL du fichier reconstituée depuis un JS |
| **yifysubtitles.ch** | films uniquement | .zip | **Referer obligatoire** (sinon challenge Cloudflare) |

**sous-titres.eu**
- Recherche : `GET /search.html?q=<titre>` → `ul#searchResults > li.serie | li.film`, lien `h3 > a` vers la fiche.
  Le h3 contient « Titre VO (année) - Titre FR ».
- Fiche : `/series/<slug>.html` (tous les épisodes de toutes les saisons, `#saisons-content a.subList`)
  ou `/films/<slug>.html` (`#film-content a.subList`). Chaque ligne : étiquette (« 5×16 », « S4 »), drapeaux de langue
  (`img[alt=fr|en]`), nom de fichier, équipe, date.
- Fichier : lien direct `…/download/<id>/<nom>.zip`, pas de Referer ni cookie.
- Pièges : zips **multi-versions** (9 fichiers .srt/.ass pour un épisode), zips **ENFR** (VF + VO), **packs de saison**
  (`S04`), **plages** `601@603` dont le nom affiché est masqué par la protection e-mail de Cloudflare
  (`[email protected]`) → on lit le nom dans l'URL. Notation `516` (= S05E16) dans les noms de fichiers.

**addic7ed.com**
- Épisode : `GET /search.php?search=<titre> 5x16&Submit=Search` → **302 direct** vers `/serie/<Nom>/5/16/<titre>`.
- Film : `GET /search.php?search=<titre>` → 302 vers `/movie/<id>`.
- Recherche ambiguë (« the office ») : page de liste `table.tabel a[href^="serie/"]` (« The Office (US) - 02x01 - … »).
- Page : un bloc par version (`td.NewsTitle` « Version 720p.1080p.WEB-DL, … »), lignes `td.language`, statut
  « Completed », liens `/original/<id>/<v>` et parfois `/updated/<lang>/<id>/<v>` (préféré), ligne suivante
  « N Downloads », icône « Hearing Impaired ».
- Fichier : **sans Referer → 302 vers la page**. Un Referer générique `https://www.addic7ed.com/` suffit
  (règle `rules.json`). Quota quotidien de téléchargements sans compte (non atteint pendant les tests).

**tvsubtitles.net**
- `GET /search.php` → 404 ; le formulaire poste vers `POST /search2.php` (`qs=<titre>`) → `a[href^="/tvshow-<id>.html"]`.
- Saison : `/tvshow-<id>-<s>.html` → `table#table5`, ligne « 5x16 » → `episode-<id>.html`.
- Épisode : `a[href^="/subtitle-<id>.html"] > div.subtitlen` (titre h5, drapeau, rip, release, téléchargements).
- Téléchargement : `/download-<id>.html` est une page d'attente dont le JS découpe l'URL
  (`var s1='fil'; var s2='es/B'; … document.location = s1+s2+s3+s4`) → on relit ces affectations
  (sans exécuter le JS) → `/files/<nom>.zip`. Pages en ISO-8859-1.

**yifysubtitles.ch**
- `/search?q=` est rempli en JS ; le champ de recherche du site appelle `GET /ajax/search/?mov=<titre>`
  → JSON `[{movie:"Inception 2010", imdb:"tt1375666"}]`.
- Film : `/movie-imdb/<imdb>` → `tr[data-id]` (note, `.sub-lang`, lien `/subtitles/<slug>` avec le nom de release).
- Sous-titre : `/subtitles/<slug>` → `a.download-subtitle` → `/subtitle/<slug>.zip`.
- Fichier : **sans Referer → challenge Cloudflare 403** ; Referer générique OK (règle `rules.json`).
- Beaucoup de résultats parasites (« Making.of ») → pénalisés par le classement.

### Écartées

| Site | Constat | Raison |
|---|---|---|
| **opensubtitles.org** | toute page → redirection `/.within.website/` « Making sure you're not a bot! » (**Anubis**, preuve de travail JS) | Challenge systématique. Je n'ai pas pu obtenir de vraie page de résultats sans passer le challenge par automatisation (ce que le cahier des charges interdit) → pas de parser écrit à l'aveugle. Le challenge est sauvegardé (`challenge-anubis-opensubtitles.html`) et reconnu par la détection. |
| **subdl.com** | 403 `cf-mitigated: challenge` (« Just a moment… ») sur la recherche | Cloudflare managed challenge systématique. Même raison. |
| **podnapisi.net** | aucune réponse (timeout de connexion, www et sans www) | Inaccessible pendant l'exploration. |

Piste V2 : pour opensubtitles.org, le challenge Anubis se résout tout seul dans un vrai onglet et pose un cookie ;
avec ce cookie, le fetch de l'extension (même User-Agent) devrait passer. Il faudra sauvegarder une page de
résultats réelle depuis le navigateur (Ctrl+S) dans `test/fixtures/` et écrire le parser à partir d'elle.

## Architecture

```
manifest.json          MV3 ; content script all_frames + match_about_blank ; commands ; DNR
background.js          service worker : registre des frames vidéo, recherche multi-sources, téléchargement,
                       dézip, cache, mémoire du décalage, réapplication auto, raccourcis globaux
offscreen.html/.js     document offscreen (raison DOM_PARSER) : DOMParser → appelle le parser du provider
content.js/.css        toutes les frames : détection <video>, overlay (Shadow DOM fermé), synchro rAF,
                       plein écran, piste native de secours, raccourcis
popup.*                interface ; options.*  réglages + « Tester les sources » + « Vider le cache »
rules.json             Referer pour addic7ed et yify (fetch ne permet pas de le fixer)
lib/detect.js          titre / année / saison / épisode depuis titre d'onglet, og:title, URL
lib/subtitles.js       SRT / VTT / ASS, décodage UTF-8 → Windows-1252, assainissement (i/b/u seulement)
lib/match.js           normalisation, similarité de titres, épisodes dans les noms de fichiers, score
lib/archive.js         dézip (fflate) + choix du bon fichier (épisode, langue, format)
lib/store.js           storage.sync (réglages, style) / storage.local (caches, décalages, derniers choix)
lib/providers/         _base.js (fetch poli, challenge, erreurs) + un fichier par site + index.js
vendor/fflate.esm.js   fflate 0.8.2 (voir vendor/VERSIONS.txt)
test/                  tests unitaires Node, tests des parsers sur fixtures, page de test, E2E Playwright
```

Flux : le content script de chaque frame se signale (`video-status`) avec son `frameId` → le popup lit le titre/URL
de l'onglet (`chrome.tabs`) et l'og:title de la frame principale → le service worker interroge les sources
**en parallèle** (une requête à la fois **par site**, ≥ 0,9 s entre deux requêtes, timeout 10 s, un seul retry),
envoie le HTML au document offscreen pour le parsing, classe, télécharge, dézippe, décode, parse → envoie les
cues à **la bonne frame** (`chrome.tabs.sendMessage(tabId, msg, { frameId })`).

### Stockage

- `storage.sync` : `settings` (langue, sources activées + ordre, mode auto), `style` (taille, couleur, fond, position, rendu).
- `storage.local` : `sub:<idRésultat>` (texte décodé, 40 max, LRU), `search:<clé>` (24 h), `offset:<contenu>`,
  `last:<contenu>` (dernier choix). Clé de contenu = titre normalisé | saison | épisode.
- `storage.session` : frames vidéo par onglet, sous-titre actif par onglet (le SW MV3 peut s'endormir).

## Réparer un provider quand un site change

1. **Symptôme** : le popup affiche « … le site X a probablement changé » (le parser n'a rien lu alors que la page
   semblait contenir des résultats), ou « Tester les sources » (options) indique « Cassé » / « Aucun résultat ».
2. **Sélecteurs** : en haut de chaque `lib/providers/<site>.js`, objet `SELECTORS` (avec sélecteurs de repli :
   le premier qui trouve quelque chose gagne). Les étapes et URL constatées sont décrites en commentaire d'en-tête.
3. **Regénérer les fixtures** : ouvrir la page dans Chrome, *Enregistrer sous… → Page Web, HTML uniquement*, ou :
   ```sh
   UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
   curl -s -A "$UA" 'https://www.sous-titres.eu/search.html?q=breaking+bad' > test/fixtures/sstitres-search-breaking-bad.html
   curl -s -A "$UA" 'https://www.sous-titres.eu/series/breaking_bad.html'   > test/fixtures/sstitres-serie-breaking-bad.html
   curl -s -A "$UA" -L 'https://www.addic7ed.com/search.php?search=breaking+bad+5x16&Submit=Search' > test/fixtures/addic7ed-episode-bb-5x16.html
   curl -s -A "$UA" --data 'qs=breaking bad' https://www.tvsubtitles.net/search2.php > test/fixtures/tvsubtitles-search-bb.html
   curl -s -A "$UA" https://yifysubtitles.ch/movie-imdb/tt1375666 > test/fixtures/yify-movie-inception.html
   ```
   (liste complète : noms de fichiers dans `test/fixtures/`, URL dans les en-têtes des providers).
4. **Tester les parsers** : servir le dossier (`python3 test/serve.py 8001`) et ouvrir
   `http://localhost:8001/test/providers.html` → chaque parser est exécuté sur les fixtures avec des assertions.
   Corriger `SELECTORS` / `parsers` jusqu'à tout vert, puis recharger l'extension et « Tester les sources ».
5. Si un site exige un nouvel en-tête (Referer…) : ajouter une règle dans `rules.json`.
6. Nouveau site : copier un provider existant, l'ajouter dans `lib/providers/index.js` (il apparaît dans les options).

## Tests

```sh
# Unitaires (Node ≥ 18, aucune dépendance)
node test/subtitles.test.mjs   # SRT/VTT/ASS, BOM, \r\n, Windows-1252, assainissement      (10)
node test/detect.test.mjs      # 20 titres réalistes                                       (20)
node test/match.test.mjs       # normalisation, épisodes, classement                       (6)
node test/archive.test.mjs     # vrais zips téléchargés : multi-versions, ENFR, pack saison (7)

# Parsers sur les pages réelles (navigateur)
python3 test/serve.py 8001 &   # serveur AVEC requêtes Range (http.server ne les gère pas → seek impossible)
python3 test/serve.py 8002 &   # deuxième origine pour l'iframe
# puis http://localhost:8001/test/providers.html                                        (18)

# Page de test manuelle : http://localhost:8001/test/index.html
#   vidéo directe, iframe cross-origin (port 8002), plein écran conteneur / vidéo seule, vidéo dynamique,
#   test/media/test-cp1252.srt (Windows-1252, accents, <i>, <b>, <u>, <font> à supprimer)

# Bout en bout dans Chromium avec l'extension chargée (Playwright, hors projet)
PW_CORE=/chemin/node_modules/playwright-core/index.mjs CHROME=/chemin/chrome node test/e2e.mjs [--online]
```

La vidéo de test `test/media/bbb.webm` (Big Buck Bunny 240p VP9, © Blender Foundation, CC-BY, ~30 Mo) n'est pas
à committer (`.gitignore`) : `curl -o test/media/bbb.webm https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.240p.vp9.webm`.

### Ce qui a été testé (Chromium 1234, headless « new », extension chargée)

- Détection de la vidéo (page et iframe cross-origin), pré-remplissage du popup.
- Fichier local Windows-1252 : accents, œ, €, italique/gras/souligné, `<font>` supprimé.
- Synchro : seek, pause, lecture (boucle rAF), vitesse ×2.
- Raccourcis G/H/Maj+G/Maj+H/V, toast « Décalage : … », touches ignorées dans un `<input>`,
  relais d'une touche depuis la page principale vers l'iframe.
- Plein écran d'un **conteneur** (overlay déplacé dedans), plein écran de la **vidéo seule**
  (bascule automatique sur la piste native, puis retour à l'overlay), plein écran dans l'iframe.
- Scroll, mode natif forcé, fond semi-transparent, vidéo ajoutée dynamiquement.
- Mémoire : rechargement de la page → sous-titre **et** décalage réappliqués dès la lecture (mode auto).
- **Réel** (`--online`) : « Breaking Bad 5x16 » → 9 résultats de 3 sources ; téléchargement + affichage réussis
  depuis TVsubtitles, Addic7ed et Sous-titres.eu. « Inception (2010) » → 23 résultats ; téléchargement réussi depuis
  Addic7ed, YIFY et Sous-titres.eu. Deuxième recherche servie par le cache. « Tester les sources » : 6/6 OK.
  Bouton **Auto** sur « Inception (2010) » → « Inception 2010 Bluray (Addic7ed), 1741 répliques » appliqué.

### Pas testé

- La commande globale « chercher et appliquer » (même code que le bouton Auto, non déclenchée au clavier).
- Le parcours « challenge → Ouvrir le site → Réessayer » sur un vrai site (aucune des sources retenues n'a présenté
  de challenge ; seule la détection est testée sur des challenges réels sauvegardés).
- De vrais sites de streaming (lecteurs propriétaires, MSE/DRM, iframes imbriquées), Chrome stable avec interface
  graphique (tests en headless), le popup ouvert depuis l'icône (testé comme onglet `popup.html?tabId=`).
- Le quota de téléchargements d'addic7ed.

## Choix faits sans demander

- **Sources** : 4 retenues (ci-dessus) ; ordre par défaut sous-titres.eu (français, qualité) → addic7ed →
  tvsubtitles → yify. Un petit bonus suit l'ordre choisi dans les options.
- **fflate** : build ESM `vendor/fflate.esm.js` (0.8.2) plutôt que le `.min.js` UMD, car le service worker
  et le popup sont des modules ES ; seule `unzipSync` est utilisée.
- **Mode auto** : réapplique automatiquement le **dernier sous-titre choisi** (et son décalage) quand un contenu
  déjà vu démarre. Il ne lance **pas** de recherche réseau à chaque vidéo lue (ce serait du scraping à chaque
  pub / vidéo YouTube) ; pour une nouvelle vidéo : bouton « Auto » du popup ou commande globale.
- Le choix est mémorisé sous la clé de la recherche **et** sous celle de la détection automatique (si je corrige
  le titre dans le popup, la réouverture de la page retrouve quand même le sous-titre).
- **Overlay** dans un Shadow DOM **fermé** (isolé du CSS des sites), `position: fixed` recalée sur
  `getBoundingClientRect` (ResizeObserver, scroll en capture, resize, plein écran + filet de sécurité toutes les 250 ms).
- **Vidéo elle-même en plein écran** : aucun élément ne peut s'afficher par-dessus → bascule automatique sur la
  piste native le temps du plein écran.
- **Encodage** : la table Windows-1252 (0x80–0x9F : œ, €, guillemets) est appliquée explicitement car certains
  environnements décodent « windows-1252 » comme du Latin-1.
- Choix du fichier dans un zip : bon épisode > langue demandée (`.fr.`, `VF`, `French`) > .srt > .vtt > .ass ;
  « NoTAG » légèrement préféré.
- Recherche mise en cache 24 h **seulement si aucune source n'a échoué** (sinon on garderait l'échec).
- « Vider le cache » efface sous-titres et recherches, **garde** décalages et derniers choix.
- Épisode seul (« Ep 12 ») → saison 1 par défaut. Langues proposées : FR (défaut), EN, ES, DE, IT, PT.
- Raccourcis globaux `Alt+Maj+G/H/V` (Chrome limite à 4 suggestions et refuse G/H/V seuls).

## Limites connues

- Détection basée sur le titre d'onglet / l'URL : sur les sites qui n'y mettent pas le nom du contenu, il faut
  corriger le titre dans le popup (une fois : le choix est ensuite mémorisé).
- Lecteurs en **Shadow DOM** : les `<video>` dans des shadow roots ne sont pas détectées.
- Changement d'épisode sans changement de `src` (certains lecteurs MSE réutilisent le même `blob:`) : les
  sous-titres de l'épisode précédent restent affichés → « Retirer » dans le popup.
- Archives RAR/7z non prises en charge (rencontrées sur certains sites, pas sur les 4 retenus).
- Mode natif : style limité (celui du navigateur).
- Les sites peuvent changer à tout moment (voir « Réparer un provider ») ; addic7ed limite les téléchargements.

## Idées V2

- Adaptateurs par site de streaming pour une détection fiable du titre (hors périmètre V1).
- opensubtitles.org (cookie Anubis obtenu dans un vrai onglet) et subdl.com si le challenge disparaît.
- Recalage automatique (analyse audio / détection des dialogues) ; hash de fichier impossible en streaming.
- Détection des `<video>` dans les shadow roots ouverts ; archives RAR (lib dédiée).
- Recherche automatique optionnelle au démarrage d'une vidéo longue (> 20 min) avec confirmation.
- Firefox.
