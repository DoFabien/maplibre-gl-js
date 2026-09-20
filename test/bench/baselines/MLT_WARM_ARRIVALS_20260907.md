# MLT — préparation à cache chaud et arrivées partielles, 7 septembre 2026

## Périmètre et méthode

Ce lot étend les bancs navigateur, sans modifier le code produit, les bundles,
les images attendues ou les tolérances de pixels. GL JS reste sur
`restack/mlt-feature-state-native` (`cfb9f34ae37a0e3bc9696c2e251f54ac7ee0e77e`),
TileSpec sur `mlt-columnar/tile-spec-minimal`
(`1ec5c6b144c8ed5eca580c2ba406f323f240e45c`).
Node 24.18.1, Chromium 152, viewport 800 × 600, DPR 1, un worker et assets locaux.

### Historique mondial à cache chaud

`mlt-warm.ts` prend la main sur l'horloge publique et le planificateur navigateur
après le chargement initial de Berlin et la sélection d'un bâtiment/POI. La source
mondiale, masquée à ce zoom, n'a pas encore servi au rendu mondial. Les dessins
mondiaux sont ensuite tous enregistrés :

1. Première vue mondiale Mercator à zoom 2,5.
2. Configuration de la projection interpolée ou du globe avec DEM synthétique.
3. Excursion vers une autre caméra et un autre zoom.
4. Retour à la caméra de départ, sans `setTiles`, retrait ou remplacement de source.
5. Animation réelle `easeTo`/`flyTo` : seize étapes de 125 ms, puis stabilisation.

Les quatre parcours sont les deux sens de transition de projection, l'orbite
terrain et le vol terrain. Chaque session utilise une carte neuve ; la seconde
passe inverse l'ordre MVT/MLT. Le retour doit conserver les compteurs de requêtes
réseau et, en MLT strict, de décodage/clipping de l'excursion : il réutilise bien
des tuiles chaudes. Sources et `feature-state` restent conservés.

Les callbacks réels d'initialisation de source sont exécutés avec les callbacks
de rendu. L'initialisation TileJSON inline utilise elle aussi un callback
d'animation : elle ne peut pas attendre indéfiniment derrière une barrière qui
attendrait sa propre fin. Les barrières annotent explicitement cette phase ;
ensuite les chargements doivent finir entre dessins, sans repaint ajouté.

Chaque dessin archive le framebuffer PNG et les réponses GeoJSON complètes,
y compris les dessins qui lancent des chargements. Caméras, états, requêtes et
pixels appariés sont exacts. Seule la comparaison d'une cible demandée à sa
conversion caméra utilise 1e-9, comme dans le lot précédent.

Le contrôle négatif ajoute un dessin au même instant 500 ms pendant le vol :
son état doit être identique, mais son image différente, dans chaque encodage.
Le cache terrain réel reste actif.

### Livraisons vectorielles partielles

`mlt-arrival.ts` conserve le corpus Berlin chargé et sélectionné, puis ajoute une
source vectorielle distincte de quatre tuiles avec des remplissages et lignes
visibles. Le serveur local retient les vraies réponses HTTP, puis en libère une
à 500, 1 000, 1 500 et 2 000 ms pendant une rotation/inclinaison de caméra.
L'ordre canonique et son inverse sont testés ; les encodages sont aussi inversés
à la seconde passe. Aucune fonction de requête, de décodage ou de rendu n'est simulée.

Une frame d'initialisation précède la première demande de tuiles :
`areTilesLoaded()` y est vrai alors que `isSourceLoaded('arrival')` est faux.
Ce n'est pas une livraison terminée : aucune tuile de cette source n'a encore
été demandée. Après cette phase, les états incomplets 0/4, 1/4, 2/4 et 3/4 doivent
être observés et comparés, avec les identifiants réellement livrés et leurs requêtes.

Les traces HTTP vérifient demande, libération et fin de réponse ; les événements
publics de la carte vérifient la réception/parsing. L'ordre inverse doit changer
l'image intermédiaire à caméra identique ; une fois les quatre tuiles présentes,
les deux ordres doivent converger exactement.

## État de validation

La [vérification indépendante](browser-warm-production-v3-20260907/validation.json)
termine avec **le code 0**, statut `verified-warm-history-parity`.
Les campagnes [production Iris Xe](browser-warm-production-v3-20260907/results.json),
[strict Iris Xe](browser-warm-strict-gpu-v3-20260907/results.json) et
[strict SwiftShader](browser-warm-strict-software-v3-20260907/results.json)
passent chacune : **18 sessions, 432 captures, 202 comparaisons MVT/MLT,
202 répétitions et 26 préfixes exacts**, plus deux contrôles discriminants.
Total : **1 290 comparaisons positives exactes et six contrôles discriminants**.

Les contrôles au même instant produisent 15 488 pixels différents sur Iris Xe et
15 531 sur SwiftShader, identiquement dans les deux encodages de chaque backend ;
leur état reste exact. Les 48 captures d'animation avec chargement en cours par
campagne sont incluses, pas écartées. Caméras, états, requêtes et événements par
intervalle correspondent aussi entre les trois configurations ; les pixels ne
sont pas comparés entre deux GPU différents.

Le validateur vérifie les captures brutes, les événements, les compteurs stricts,
la réutilisation des tuiles au retour et les empreintes du code/bundles/assets.
Il archive les scripts, le rapport unitaire et les listes de comparaisons.
**336/336 tests ciblés** caméra/horloge/cache terrain passent à nouveau, ainsi que
le test du serveur de livraison, le typecheck et le lint des nouveaux fichiers.
Les octets des bundles et le diff produit restent ceux du lot gestes/animations.

Le validateur chaud reconstruit aussi 66 répétitions de préparation absentes de
la liste de comparaisons du runner. Il contrôle cette liste séparément et archive
sa propre liste complète ; il ne se contente pas du statut `passed` du runner.

### Livraisons partielles : échec de parité conservé

La [campagne production](browser-arrival-production-v3-20260907/results.json)
termine ses **8 sessions et 88 captures**, puis échoue sur la parité GeoJSON.
L'[audit complet](browser-arrival-production-v3-20260907/audit.json) reconstruit
les comparaisons même après l'arrêt des assertions du runner :

- **44/44 paires MVT/MLT ont des pixels identiques** ; caméra, sélection, sources,
  horloge, tuiles effectivement livrées et requêtes de source correspondent.
- **20/44 paires divergent dans `queryRenderedFeatures`**, y compris après
  chargement complet. Chaque écart est constitué des mêmes deux points présents
  en MVT et absents en MLT dans la couche `arrival-roads`.
- **44/44 répétitions** du même encodage sont exactes ; les deux ordres convergent
  à l'identique dans les **4 comparaisons finales par encodage**. Cela ne supprime
  pas le défaut de parité entre encodages.
- Les heures de libération HTTP et de réception des événements publics sont
  contrôlées : 500, 1 000, 1 500 et 2 000 ms. Aucune étape ne manque.
- Le runner, l'audit et la vérification du dataset échoué retournent **le code 1**.
  Le statut de l'audit reste `partial-arrival-parity-failed`. La matrice complète
  de qualification stricte GPU/SwiftShader de ce nouveau banc n'est pas certifiée.

Les objets manquants sont `osm_id=-29217319` (`turning_circle`) et
`osm_id=-29276745` (`traffic_signals`), dans `14-8802-5374`. Le style `line`
ne contient volontairement pas de filtre de type de géométrie. Le problème ne
concerne donc pas uniquement les chargements incomplets : ceux-ci révèlent un
cas de géométrie mixte jusque-là absent du banc.

Le chemin MVT insère les géométries dans l'index après la tentative de construction
du trait, même sans segment dessinable (`line_bucket.ts`, `populate`). Le chemin
colonnaire peut stocker une liste d'emprises vide pour le point
(`columnar_line_bucket.ts`, `addGeometryParts`/`addLine`) ; le worker consomme cette
liste vide au lieu de calculer l'emprise numérique de la géométrie.
Le correctif produit n'est pas inclus dans ce lot. La prochaine étape est de
préserver cette indexation sans matérialisation, avec un test réduit de points et
lignes dégénérées, puis de relancer ce banc inchangé. Ajouter un filtre `LineString`
ici masquerait l'écart au lieu de corriger la parité.

Le serveur de contrôle passe son test Vitest isolé (quatre vraies réponses retenues,
libérées individuellement et vérifiées octet pour octet) ; son rapport est archivé
dans la campagne production. Cela valide le mécanisme de livraison, pas la parité MLT.

## Reproduction

Depuis la racine GL JS, utiliser des répertoires de sortie neufs et exécuter les
campagnes navigateur séquentiellement :

```bash
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-warm.ts --runs 2 --output <production-neuf>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-warm.ts --strict --runs 2 --output <strict-gpu-neuf>
PUPPETEER_GPU=software \
  node test/bench/e2e/mlt-warm.ts --strict --runs 2 --output <strict-logiciel-neuf>
node test/bench/e2e/mlt-warm-validate.mjs \
  <production> <strict-gpu> <strict-logiciel> <rapport-unitaires-336.json>

npx vitest run test/bench/e2e/mlt-arrival-server.test.ts --environment node \
  --reporter=json --outputFile=<rapport-serveur.json>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-arrival.ts --runs 2 --output <arrivees-neuf>
node test/bench/e2e/mlt-arrival-analyze.mjs <arrivees> <rapport-serveur.json>
```

Les deux dernières commandes échouent actuellement avec le code 1 sur le défaut
de requête décrit ci-dessus. `mlt-arrival-validate.mjs` est prêt pour exiger une
matrice production/strict GPU/strict logiciel entièrement réussie après correction ;
il rejette la campagne actuelle. L'audit d'échec n'est pas ce certificat de parité.

## Essais conservés et limites

- `browser-warm-probe-20260907` : transition inverse, deux passes strict GPU,
  exactes ; preuve initiale de réutilisation du cache.
- `browser-warm-production-20260907`, `browser-warm-production-v2-20260907` et
  `browser-warm-terrain-probe-20260907` : barrières d'initialisation du banc
  incorrectes, bloquées sur le callback TileJSON retenu. Pas un échec de rendu MLT.
- `browser-warm-terrain-probe-v2-20260907` : callbacks réels correctement exécutés,
  préparation et orbite terrain MVT/MLT exactes.
- `browser-arrival-probe-20260907` : assertion initiale incorrecte sur
  `areTilesLoaded()` avant toute demande de tuile ; l'archive garde l'état réel.
- `browser-arrival-probe-v2-20260907` : quatre sessions strict GPU complètes,
  même écart de deux points dans les requêtes. La campagne production v3 aligne
  explicitement l'horloge de la carte avant chaque libération HTTP et reproduit
  l'écart dans deux passes ; le défaut ne disparaît pas avec cet alignement.

Ce protocole ne certifie pas rétroactivement les anciens parcours natifs ou
les préparations non contrôlées du [lot historique](MLT_HISTORY_20260907.md).
Le démarrage local initial n'est pas contrôlé. Le banc chaud attend les sources
entre dessins ; le banc de livraison partielle est local, en Mercator, sans DEM.
Leur combinaison avec un vol globe/terrain et des DEM multi-niveaux, les
annulations/erreurs réseau, les gestes tactiles, les timings natifs et les mesures
de fluidité/mémoire GPU restent hors de cette qualification.

Les suites complètes produit/render ne sont pas relancées dans ce lot de banc :
leur dernier résultat reste attaché au [lot gestes/animations](MLT_MOTION_20260907.md),
dont les 36 écarts render GPU connus. Les tests ciblés sont exécutés à nouveau.
