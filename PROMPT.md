# Prompt — Extension Chrome « Sous-titres auto »

Tu vas créer une extension Chrome (Manifest V3) pour mon usage perso, chargée en mode « non empaquetée ». Code dans `~/subs-ext/`. Lis tout ce prompt avant d'écrire la moindre ligne, puis travaille étape par étape en vérifiant chaque étape.

## Objectif

Quand je regarde une vidéo dans le navigateur (n'importe quel site, y compris les lecteurs embarqués dans des iframes), l'extension trouve automatiquement des sous-titres **en français**, les télécharge et les affiche par-dessus la vidéo, synchronisés, avec possibilité de corriger le décalage au clavier.

**Contrainte majeure : aucune API, aucune clé, aucun compte.** L'extension récupère les sous-titres en **scrapant les sites publics** de sous-titres (pages de recherche HTML + liens de téléchargement), exactement comme le ferait un humain dans le navigateur. Rien à configurer pour que ça marche.

## Contraintes techniques

- **Manifest V3**, Chrome uniquement.
- **Pas de build** : JS vanilla (ES modules autorisés dans le service worker), HTML/CSS simples. Je dois pouvoir faire « Charger l'extension non empaquetée » directement sur le dossier.
- **Aucun script externe chargé depuis un CDN** (interdit en MV3). Si une lib est nécessaire (dézip), télécharge-la une fois et mets-la dans `vendor/` avec sa version notée. Préférer `fflate` (petit) pour les .zip.
- Code propre, commenté en français là où ce n'est pas évident, fichiers courts et séparés par responsabilité.

## Architecture attendue

```
subs-ext/
  manifest.json
  background.js          # service worker : orchestration, fetch des pages, téléchargement, dézip, cache
  offscreen.html / offscreen.js   # document offscreen : parsing HTML (DOMParser absent du service worker)
  content.js             # injecté dans toutes les frames : détecte <video>, affiche l'overlay
  content.css
  popup.html / popup.js / popup.css
  options.html / options.js   # langue, sources activées, style des sous-titres
  rules.json             # règles declarativeNetRequest (Referer, etc.) si un site l'exige
  lib/
    detect.js            # parsing titre / saison / épisode
    subtitles.js         # parse SRT / VTT (+ ASS basique), décodage d'encodage
    match.js             # scoring des résultats (titre, année, S/E, release)
    providers/
      _base.js           # interface commune + helpers (fetch, throttle, retry)
      <un fichier par site scrapé>.js
  test/fixtures/         # pages HTML réelles sauvegardées de chaque site, pour tester les parsers
  vendor/fflate.min.js
  test/
    index.html           # page de test locale (vidéo directe + vidéo dans iframe)
  README.md
```

### manifest.json
- `content_scripts` sur `<all_urls>` avec **`all_frames: true`** et `match_about_blank: true` (les lecteurs de streaming sont presque toujours dans une iframe d'un autre domaine).
- permissions : `storage`, `activeTab`, `scripting`, `webNavigation`, `offscreen`, `declarativeNetRequest`, `tabs`.
- `host_permissions` : `<all_urls>` (nécessaire pour les content scripts **et** pour que le service worker puisse fetcher les sites de sous-titres sans CORS).
- `commands` pour les raccourcis globaux (voir plus bas).

### Communication
- **Tous les fetch vers les sites de sous-titres passent par le service worker** (grâce aux host_permissions, pas de CORS).
- **Le service worker MV3 n'a pas `DOMParser`** : le HTML récupéré est envoyé à un **document offscreen** (`chrome.offscreen.createDocument` avec la raison `DOM_PARSER`) qui le parse et renvoie des données structurées. Ne pas parser du HTML à coups de regex.
- Le popup ne peut pas lire le titre d'une iframe cross-origin : il utilise `chrome.tabs.query` → `tab.title` et `tab.url` de l'onglet pour la détection.
- Chaque content script qui trouve une `<video>` significative (durée > 60 s ou taille > 300×150 px) se signale au background avec son `frameId`. Le popup envoie les sous-titres **à la bonne frame** via `chrome.tabs.sendMessage(tabId, msg, { frameId })`. S'il y a plusieurs vidéos, prendre la plus grande / celle en lecture.
- Gérer les vidéos ajoutées dynamiquement (MutationObserver) et les changements de `src` (épisode suivant).

## Fonctionnalités V1

### 1. Détection du contenu (`lib/detect.js`)
À partir du titre de l'onglet, de l'URL (slug) et, si accessible, de `og:title` :
- Nettoyer le titre (retirer le nom du site, « Regarder », « streaming », « VF », « VOSTFR », « HD », années entre parenthèses mises de côté, séparateurs ` - `, ` | `, ` – `).
- Extraire saison / épisode depuis tous les formats courants : `S01E02`, `s1e2`, `1x02`, `Saison 1 Épisode 2`, `saison-1/episode-2` dans l'URL, `Season 1 Episode 2`, `Ep 2`.
- Extraire l'année si présente.
- Retourner `{ title, year?, season?, episode?, type: 'movie'|'episode' }`.
- Écrire des **tests unitaires simples** (fichier `test/detect.test.html` ou script node) avec au moins 15 titres réalistes.

### 2. Popup
- Affiche la détection pré-remplie, **modifiable** : titre, année, saison, épisode, langue (FR par défaut).
- Bouton « Chercher » → liste des résultats (nom de la release, source, nb de téléchargements, note, indication « correspond à la release » si le nom ressemble au titre de la page).
- Clic sur un résultat → téléchargement + affichage immédiat sur la vidéo.
- Bouton **« Auto »** : cherche et prend directement le meilleur résultat.
- Bouton **« Charger un fichier .srt »** (input file) en secours manuel.
- Indicateur d'état : vidéo détectée ou non, sous-titre actif, décalage actuel.
- Contrôles du décalage (−1 s, −0,1 s, +0,1 s, +1 s, reset) et taille du texte.
- Si aucune vidéo n'est détectée dans l'onglet, le dire clairement.

### 3. Sources de sous-titres par scraping (`lib/providers/`)

Interface commune à chaque provider :
- `search({title, year, season, episode, lang}) → [{id, provider, release, url, downloads?, rating?, ...}]`
- `download(result) → { filename, bytes }` (fichier brut ou zip)

**Choix des sites — à vérifier toi-même, ne rien supposer :**
Candidats connus avec un bon catalogue FR (certains peuvent être morts, avoir changé ou être derrière Cloudflare) :
- `opensubtitles.org` (l'ancien site, pages de recherche HTML, gros catalogue FR)
- `subdl.com` (site web, pas l'API ; regarder si les données sont dans le HTML ou dans un JSON embarqué type `__NEXT_DATA__`)
- `addic7ed.com` (séries, bonne qualité FR ; exige souvent un `Referer` pour le téléchargement)
- `podnapisi.net`, `tvsubtitles.net`, `yifysubtitles` (films) et tout autre site public FR pertinent que tu trouves.

Pour **chaque** candidat :
1. Ouvre-le réellement dans le navigateur (outil Chrome si dispo, sinon `curl`) : fais une recherche film et une recherche épisode de série, suis le lien jusqu'au téléchargement du fichier.
2. Note dans le README : URL de recherche, structure de la page de résultats, étapes jusqu'au fichier, format (srt / zip), protections rencontrées (Cloudflare, captcha, Referer, cookie, limite de téléchargements).
3. **Sauvegarde les pages HTML réelles dans `test/fixtures/`** et écris les parsers + leurs tests à partir de ces pages (jamais à partir de suppositions).
4. Ne garde que les sites qui fonctionnent sans compte ni captcha systématique. Vise **au moins 2 sources fiables** pour avoir un secours.

**Robustesse du scraping :**
- Sélecteurs CSS centralisés en haut de chaque provider (facile à corriger quand un site change de design), avec des sélecteurs de repli si possible.
- Si un parser ne trouve plus rien sur une page qui contient pourtant des résultats → erreur explicite « le site X a probablement changé » dans le popup, pas un silence.
- **Politesse** : 1 requête à la fois par site, petit délai entre requêtes, aucune requête en boucle, aucun préchargement massif. Usage strictement perso : on ne fait que ce qu'un humain ferait à la main.
- Headers : utiliser ceux du navigateur (le fetch du service worker part déjà avec le User-Agent de Chrome et les cookies du site). Si un site exige un `Referer`, l'ajouter via une règle `declarativeNetRequest` (fetch ne permet pas de le définir).
- **Cloudflare / captcha** : ne pas essayer de le contourner. Si la page renvoyée est un challenge, proposer dans le popup « Ouvrir le site » (onglet réel où je résous le challenge moi-même), puis réessayer — les cookies obtenus seront réutilisés par l'extension. Sinon basculer sur la source suivante.
- Timeout (10 s) et un seul retry par requête.

**Fichiers :**
- Souvent des **.zip** → dézipper avec fflate, choisir le bon fichier (.srt/.vtt/.ass) ; pour un pack de saison, celui qui correspond à l'épisode (détecter `S01E02`, `1x02`, etc. dans le nom).
- Ignorer les fichiers qui ne sont pas des sous-titres.

**Classement des résultats (`lib/match.js`)** : score selon titre normalisé (accents, ponctuation, articles), année, saison/épisode exacts, langue réellement FR, popularité si dispo, bonus si le nom de la release ressemble au titre de la page (WEB-DL, BluRay, nom du groupe…). Interroger les sources en parallèle, fusionner, dédoublonner, trier.

### 4. Parsing & encodage (`lib/subtitles.js`)
- Parser **SRT** et **VTT** de façon robuste (lignes vides multiples, `\r\n`, BOM, numéros manquants, virgule ou point dans les timestamps). **ASS/SSA** : extraction basique du texte des `Dialogue:`, suppression des balises `{\...}`.
- Garder `<i>`, `<b>`, `<u>` (les sous-titres FR en utilisent beaucoup), supprimer le reste du HTML, **ne jamais injecter du HTML non assaini** (construire le DOM ou n'autoriser qu'une liste blanche de balises).
- **Encodage** : beaucoup de .srt français sont en Windows-1252 / ISO-8859-1. Décoder d'abord en UTF-8 avec `TextDecoder('utf-8', { fatal: true })`, et en cas d'erreur retomber sur `windows-1252`. Tester avec des accents (é, è, à, ç, œ).
- Sortie : tableau trié `[{ start, end, text }]` en secondes.

### 5. Affichage sur la vidéo (`content.js`)
- Overlay positionné en absolu au-dessus de la vidéo, recalé sur resize / scroll (ResizeObserver + `getBoundingClientRect`).
- **Plein écran** : écouter `fullscreenchange` et déplacer l'overlay dans `document.fullscreenElement` (souvent un conteneur du lecteur, pas la vidéo elle-même), puis le remettre en place à la sortie. C'est le piège principal, à tester explicitement.
- Synchro : boucle `requestAnimationFrame` pendant la lecture (pas `timeupdate`, trop imprécis), recherche du cue actif par recherche binaire, prise en compte du décalage. Gérer pause, seek, changement de vitesse.
- Style par défaut lisible : texte blanc, contour/ombre noire, fond semi-transparent optionnel, bas centré, taille relative à la hauteur de la vidéo. Configurable dans les options.
- `pointer-events: none` sur l'overlay pour ne pas bloquer le lecteur. z-index très élevé.
- Option de secours dans les options : rendu via `video.addTextTrack()` + `VTTCue` natif (pour les lecteurs où l'overlay pose problème).

### 6. Raccourcis clavier
Dans la frame de la vidéo (en ignorant les frappes dans les champs de saisie), style VLC :
- `G` : −0,1 s · `H` : +0,1 s · `Shift+G` / `Shift+H` : ±1 s
- `V` : afficher / masquer les sous-titres
- Afficher brièvement le décalage à l'écran (« Décalage : +0,4 s ») à chaque changement.
- Écouter en phase de capture pour passer avant le lecteur, mais ne bloquer que ces touches-là.

### 7. Mémoire & cache
- `chrome.storage.sync` : langue, sources activées et leur ordre, préférences de style.
- `chrome.storage.local` : 
  - cache des sous-titres déjà téléchargés (clé = titre normalisé + saison + épisode) pour ne pas re-scraper les sites à chaque rechargement ;
  - cache court (24 h) des résultats de recherche ;
  - **décalage mémorisé par contenu** ;
  - dernier choix de sous-titre pour un contenu donné.
- Quand je rouvre le même épisode, le sous-titre et le décalage sont réappliqués automatiquement dès que la vidéo démarre (si l'option « auto » est activée).

### 8. Page d'options
Langue par défaut (FR), sources activées + ordre (cases à cocher, glisser-déposer ou flèches), mode auto on/off, taille, couleur, fond, position verticale, mode de rendu (overlay / natif). Bouton **« Tester les sources »** qui lance une recherche réelle connue (un film et un épisode) sur chaque site et affiche OK / cassé / bloqué par challenge. Bouton « Vider le cache ».

## Page de test (`test/index.html`)
- Une vidéo HTML5 directe et une vidéo dans une iframe (servie depuis un autre port pour simuler le cross-origin, ex. `python3 -m http.server 8001` et `8002`).
- Un conteneur qui passe en plein écran (pas la vidéo directement) pour tester le reparentage de l'overlay.
- Un .srt de test en Windows-1252 avec accents et balises `<i>`.
- Utilise une vidéo libre de droits (ex. Big Buck Bunny) téléchargée localement, pas commitée si trop grosse.

## Méthode de travail
1. Commence par l'exploration des sites candidats (section 3) : retiens les sources viables, sauvegarde les fixtures, documente dans le README ce que tu as **réellement constaté**.
2. Implémente dans cet ordre, en vérifiant à chaque étape : parsing + encodage (avec tests) → détection (avec tests) → overlay + synchro + plein écran avec un .srt local → popup + chargement manuel → offscreen + providers scraping (tests sur fixtures, puis test réel) → classement → auto + cache + mémoire du décalage → options.
3. Teste dans Chrome réellement (outil navigateur si disponible) sur la page de test : vidéo directe, iframe, plein écran, raccourcis, accents.
4. Ne me demande pas de valider chaque petite décision : prends des choix raisonnables et liste-les à la fin.
5. À la fin, donne-moi :
   - comment charger l'extension (chrome://extensions → mode développeur → « Charger l'extension non empaquetée »),
   - les sources retenues / écartées et pourquoi,
   - comment réparer un provider quand un site change (où sont les sélecteurs, comment regénérer les fixtures),
   - ce qui a été testé et ce qui ne l'a pas été,
   - les limites connues et les idées pour une V2.

## Hors périmètre V1 (à noter pour la V2)
- Détection automatique fiable du titre sur des sites spécifiques (adapters par site).
- Recalage automatique (analyse audio / détection des dialogues).
- Hash de fichier vidéo (impossible sur du streaming).
- Firefox.
