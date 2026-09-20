# MLT — arrivées vectorielles et DEM partielles, 7 septembre 2026

## Périmètre

Ce lot étend le banc navigateur, sans changer les sources produit, les bundles,
les seuils ou les images attendues. Les octets servis sont ceux du
[correctif d'indexation](MLT_LINE_INDEX_20260907.md). GL JS reste sur
`restack/mlt-feature-state-native` (`cfb9f34ae`), TileSpec sur
`mlt-columnar/tile-spec-minimal` (`1ec5c6b1`). Aucun commit/push.

Le banc utilise Chromium 152, 800 × 600, DPR 1, un worker et des assets locaux.
Les DEM sont synthétiques, continus et non plats, pas de la topographie réelle.
Les contrôles sont de correction, pas des mesures de fluidité ou de mémoire GPU.

## Deux parcours et un contrôle DEM isolé

- `local-orbit` : vue inclinée près de l'intersection de quatre DEM z12, avec
  quatre tuiles vectorielles z14. Une réponse physique est autorisée toutes les
  250 ms pendant une rotation de 2 s. L'ordre entrelace vecteurs et DEM ; son
  inverse commence par un DEM. La caméra peut annuler une tuile devenue inutile.
- `globe-flight` : préparation mondiale enregistrée, puis vrai `flyTo` de Berlin
  vers la côte est américaine. Une tuile vectorielle mondiale et un DEM z0 sont
  autorisés à 500 et 1 500 ms, dans les deux ordres. Le surzoom produit plusieurs
  demandes de la même tuile physique ; elles passent toutes par le serveur réel.
- `dem-late` : même vol et même arrivée vectorielle à 500 ms, mais DEM retenu
  jusqu'à 2 000 ms. Le contrôle à 1 500 ms exige une caméra identique et des pixels
  différents : il isole l'effet du DEM, pas simplement celui du nouvel overlay.

Chaque session commence par une carte neuve et un corpus Berlin chargé/sélectionné.
La préparation globe et tous ses dessins sont enregistrés. Le banc n'impose pas
de rechargement des sources chaudes, ne désactive pas le cache terrain et n'injecte
pas de dessin supplémentaire dans l'animation. Les deux passes inversent MVT/MLT.

Les PNG et les réponses GeoJSON complètes sont archivés à chaque dessin :
préparation, initialisation de source, huit étapes de 250 ms, puis stabilisation
naturelle jusqu'à `idle`. Les coordonnées internes des géométries gardent leur
ordre ; seuls les objets retournés par les requêtes sont comparés comme multiensembles.

## Protocole de livraison

Le serveur retient de vraies réponses HTTP vectorielles et PNG. Les origines
locales des assets ordinaires, des vecteurs retenus et des DEM retenus sont
séparées : les connexions HTTP/1 bloquées ne doivent pas empêcher le chargement
des autres sources. CORS/CSP n'autorisent que les origines locales prévues.

Une autorisation concerne une ressource physique et toutes ses requêtes présentes
ou futures. Chaque demande HTTP reçoit un identifiant et une terminaison unique,
complétée ou annulée. La carte conserve en parallèle les événements publics avec
leurs tuiles de rendu/surzoom. Les frames distinguent `gates` (autorisations du
serveur) et `arrivals` (données effectivement reçues, reconstruites depuis ces événements).
`arrivals` est un historique cumulatif, pas l'inventaire des tuiles encore visibles.
À 750/1 000 ms du parcours local vecteur d'abord, la seule tuile reçue est sortie
de la vue : les requêtes de la source d'arrivée sont temporairement vides en MVT
comme en MLT. Ce cas est vérifié explicitement, pas écarté de la comparaison.

L'horloge publique est avancée avant chaque libération. Les callbacks réels du
navigateur sont retenus ; les barrières attendent les ressources non contrôlées
et les chargements autorisés, jamais les réponses encore volontairement retenues.
Elles enregistrent les tuiles en attente, les autorisations et l'état des sources.
Une tuile annulée avant libération ne doit pas bloquer artificiellement le banc.

Les pixels, caméras, requêtes, états, événements publics, barrières et réponses
HTTP **complétées** doivent correspondre exactement entre MVT/MLT et au rejeu.
Seule la comparaison d'une cible de caméra demandée à sa conversion numérique
utilise 1e-9, comme dans les bancs précédents ; aucune tolérance n'est ajoutée aux
comparaisons entre captures ou aux pixels.
La seule variabilité HTTP admise concerne une requête annulée **avant ouverture
de son autorisation**, donc sans réponse livrée. Elle peut quitter la file du
navigateur avant ou après avoir atteint le serveur. Ces demandes/annulations
restent archivées et comparées dans `transportOutcomes`, pas supprimées du rapport.
Toute différence de réponse complétée, toute annulation après libération ou tout
écart public/image reste un échec.

Les poses finales entre deux ordres de livraison sont mesurées séparément dans
`order-outcome`, sans présumer une convergence générale des textures terrain.
Ces diagnostics ne sont pas comptés comme comparaisons positives de parité.

## Validation

Les trois campagnes complètes retournent le code 0, statut `passed` :

- [Production Iris Xe](browser-terrain-arrival-production-20260907/results.json).
- [Worker strict Iris Xe](browser-terrain-arrival-strict-gpu-20260907/results.json).
- [Worker strict SwiftShader](browser-terrain-arrival-strict-software-20260907/results.json).

Chaque campagne comporte 20 sessions, 276 captures, 138 comparaisons MVT/MLT et
138 répétitions exactes, huit contrôles d'ordre de livraison et quatre contrôles
DEM isolés. Au total : **828 comparaisons positives et 36 contrôles discriminants**.
Les 24 diagnostics finaux entre ordres de livraison ne sont pas inclus dans ce
total. Les compteurs de matérialisation interdite et `propertyProxyMisses` restent
à zéro dans les workers stricts ; le décodage MLT est effectivement exercé.

La [vérification indépendante](browser-terrain-arrival-production-20260907/validation.json)
retourne le code 0, statut `verified-controlled-terrain-arrivals`. Elle relit les
828 PNG/résultats GeoJSON et vérifie les inventaires, événements, barrières,
autorisations, compteurs et empreintes des fichiers. Caméras, états, requêtes,
événements publics et réponses HTTP livrées sont exacts aussi entre les trois
configurations ; **les pixels ne sont pas comparés entre GPU différents**.

Chaque campagne comprend 140 captures d'animation encore en chargement, dont
108 avec autorisations seulement partielles ; 48 captures montrent une mosaïque
DEM effectivement partiellement reçue. Les 64 événements publics d'annulation
par campagne sont conservés. Le nombre de demandes HTTP au-delà d'une demande
par ressource/session est de 290/293/291 (production/strict GPU/strict logiciel).
Deux/trois/trois comparaisons internes et trois comparaisons entre configurations
diffèrent sur des demandes annulées avant ouverture, sans différence de livraison.
Les traces brutes et ces écarts figurent dans le certificat.

Le contrôle DEM isolé modifie 15 864 pixels sur Iris Xe et 16 069 sur SwiftShader,
à caméra identique, dans les deux encodages et répétitions. Les 24 diagnostics
finaux entre ordres de livraison ont ici zéro pixel différent. Leur état complet
n'est pas toujours identique : en local, l'historique cumulatif `arrivals` diffère
par une tuile reçue puis évincée dans un ordre, annulée avant réception dans
l'autre. Ce n'est pas un écart MVT/MLT, ni une preuve générale de convergence.

Les 405 tests ciblés caméra/horloge/cache terrain/indexation, les cinq tests du
serveur HTTP, le typecheck et le lint passent ; les deux rapports de tests et les
sept sources du protocole/validateur sont archivés avec leurs empreintes. Le produit et ses bundles sont
inchangés ; les suites complètes du lot d'indexation restent historiques. Un
contrôle négatif du validateur rejette toujours l'essai `probe-v4` échoué (code 1).

## Essais conservés

- `browser-terrain-arrival-globe-probe-20260907` : modèle initial trop simple,
  une réponse par ressource ; le surzoom demandait plusieurs copies physiques.
- `browser-terrain-arrival-globe-probe-v2-20260907` : réponses retenues sur la même
  origine que les assets ; limite de connexions HTTP/1 et barrière bloquée.
- `browser-terrain-arrival-globe-probe-v3-20260907` : deux ordres globe complets,
  30 comparaisons MVT/MLT exactes, 60 captures ; pas encore de contrôle DEM isolé.
- Les trois probes locaux précisent l'inventaire visible : la vue initiale Berlin
  ne demandait qu'un DEM ; la caméra déplacée couvre les quatre DEM. Une tuile
  vectorielle ensuite annulée nécessitait de distinguer autorisation et réception.
- `browser-terrain-arrival-probe-v4-20260907` : 10 sessions/138 captures, 69 paires
  MVT/MLT exactes ; le contrôle DEM isolé produit 15 864 pixels différents à caméra
  identique sur Iris Xe, dans les deux encodages. Le runner reste en échec sur
  l'ancienne exigence d'identité de toutes les demandes HTTP : une requête et son
  annulation supplémentaires, sans réponse livrée, événements publics inchangés.
  Ce résultat échoué n'est pas réétiqueté en certificat.

## Reproduction

Les variantes production normale et stricte doivent être présentes ; le banc
sert les fichiers `.mjs`, pas les `-dev.mjs`. Utiliser des sorties neuves et exécuter
les campagnes navigateur séquentiellement.

```bash
npm run test-unit -- \
  src/ui/camera.test.ts src/util/time_control.test.ts \
  src/webgl/render_to_texture.test.ts src/webgl/rtt_fingerprint.test.ts \
  src/source/worker_tile_line_query_parity.test.ts \
  src/source/worker_tile_synthetic_mvt_mlt_parity.test.ts \
  src/data/feature_index.test.ts \
  src/data/bucket/columnar/columnar_bucket_parity.test.ts \
  --reporter=json --outputFile=<unitaires-405.json>
npx vitest run test/bench/e2e/mlt-terrain-arrival-server.test.ts --environment node \
  --reporter=json --outputFile=<serveur.json>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-terrain-arrival.ts --runs 2 --output <production>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-terrain-arrival.ts --strict --runs 2 --output <strict-gpu>
PUPPETEER_GPU=software \
  node test/bench/e2e/mlt-terrain-arrival.ts --strict --runs 2 --output <strict-logiciel>
node test/bench/e2e/mlt-terrain-arrival-validate.mjs \
  <production> <strict-gpu> <strict-logiciel> <unitaires-405.json> <serveur.json>
```

Hors périmètre : timings natifs, tactile/pinch, pannes HTTP ou reprises explicites,
DEM réels multi-niveaux, autres matériels GPU et variations arbitraires de réseau.
Les annulations naturelles observées pendant ces deux trajectoires sont incluses,
mais ne constituent pas une qualification générale de toutes les interruptions.
