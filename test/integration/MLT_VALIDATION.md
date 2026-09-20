# Validation MLT après synchronisation upstream

## Remplissages prétriangulés — état du 8 septembre

Le [prototype maillé](../bench/baselines/MLT_PRETRIANGULATED_FILL_20260908.md)
écrit les triangles MLT directement dans les buffers finaux au natif Mercator,
avec contours et requêtes ; les tuiles Berlin historiques étaient déjà maillées.
Point de retour commité avant modification : GL `4ac9eb198`, TileSpec `ddf28400`.
3 788 tests unitaires, 178 intégrations et 759 tests de build passent. Rendu strict :
243/243 logiciel et 236/243 GPU, avec les sept mêmes échecs et images qu'avant.
La suite GPU complète n'est pas rejouée. Les bundles finaux passent 46 paires
globe/terrain GPU/logiciel et 25 paires de styles à chaud GPU, sans matérialisation
interdite détectée. Aucun changement d'image attendue ou de tolérance.

Une campagne équilibrée retrouve environ −6 % jusqu'au dessin au natif, mais
+7,1 % en surzoom chaud : pas de gain global revendiqué. Une campagne indépendante
estime −30 % d'allocations worker au natif ; les buffers de géométrie n'ajoutent
que huit octets sur les quatre tuiles. Les 32 captures de performance et 16 captures
d'allocations, avec requêtes complètes, sont exactes. Le
[certificat propre au lot](../bench/baselines/pretriangulated-checkpoint-20260908/checkpoint.json)
conserve les sources et preuves. La prochaine vérification porte sur le signal
défavorable du surzoom, avant toute extension du raccourci.

## Clipping en flux — état du 8 septembre

Le [rapport clipping](../bench/baselines/MLT_CLIPPING_STREAM_20260908.md) suit la
suppression des buffers transformé/X/Y et des comptages préalables, après le lot
de remappage polygonal. Les ordres d'intersection et d'arrondi MVT sont conservés.
Les 3 770 tests GL, 2 622 tests TileSpec et 759 tests de build isolés passent,
ainsi que typecheck/lint et les builds prod/dev/stricts. Le premier passage build
sous charge fait 758/759 ; il est conservé séparément du succès isolé.
L'intégration complète finale passe à 178/178. Les sources, rapports et images
d'échecs sont archivés dans le [checkpoint](../bench/baselines/clipping-stream-checkpoint-20260908/checkpoint.json).

Deux campagnes production indépendantes de premiers surzooms en workers neufs
retrouvent 96 captures exactes et les mêmes requêtes complètes : environ −22–24 %
jusqu'au premier dessin chargé sur le corpus Berlin de base. C'est une mesure
de soumission CPU, pas de présentation GPU, sans conclusion générale au natif
ou à chaud.

La variante passe 243 fixtures MLT strictes logiciel, 23 paires globe/terrain
strict GPU et 23 strict logiciel, puis 25 paires de styles à chaud strict GPU.
Les archives complètes de géographie sont recalculées par un audit séparé.
Le GPU complet fait 1 887/1 923, avec les mêmes 36 noms en échec : 35 images
inchangées face au remappage, une variation de 23 pixels sur une fixture terrain
hors MLT, identique à l'image de la qualification indexée antérieure. Les échecs
et images sont archivés ; aucune référence ni tolérance n'est modifiée.
Les compteurs interdits contrôlés restent nuls. La portée demeure celle du
corpus exécuté, pas une parité universelle ni une absence de toute allocation.

## Parent partagé et vues indexées — état du 8 septembre

La [qualification des vues indexées](../bench/baselines/indexed-columns-qualified-20260908/qualification.json)
vérifie les sources complètes, les bundles et les nouvelles campagnes : 144 paires
globe/terrain/styles exactes en production GPU, strict GPU et strict logiciel.
La suite GPU complète retrouve 1 887 succès sur 1 923, sans test ignoré ni nouveau
nom en échec ; les 36 échecs restent des échecs et leurs images actuelles sont
archivées. L'identité des noms ne prouve pas une identité des écarts pixel.

Les sources sont identiques au checkpoint des 3 764 tests unitaires GL, 2 619
TileSpec, 759 build, 178 intégration et 243 rendus MLT stricts logiciel réussis.
Les compteurs contrôlés sont nuls ; ils couvrent les opérations instrumentées,
pas toutes les allocations possibles des dépendances. Les six échecs hérités
des anciens filtres `.spec.ts` hors configuration unitaire restent ouverts.

Trois répétitions navigateur confirment surtout des requêtes moins coûteuses et
moins de stockage, sans gain de dessin significatif établi. Le profil main/worker
cible maintenant la seconde passe de remappage polygonal puis les intermédiaires
du clipping. Voir le [rapport et ses limites](../bench/baselines/MLT_SHARED_PARENT_20260908.md).
Cette qualification d'un corpus n'affirme pas une parité universelle des styles
(notamment `distance`) ni l'achèvement de l'objectif MLT → rendu.

## Surzoom MLT direct — prototype du 8 septembre

Le [rapport direct](../bench/baselines/MLT_DIRECT_OVERZOOM_20260908.md) suit la
suppression de l'encodage MLT enfant entre découpage, cache et requêtes. Les
nouveaux bundles passent les 23 checkpoints globe/terrain et les 25 checkpoints
de changements de style en production Iris Xe et en workers stricts Iris
Xe/SwiftShader : pixels et GeoJSON exacts à MVT, compteurs interdits nuls.
Les 2 617 tests TileSpec, 3 758 tests unitaires GL JS, 759 tests de build,
178 tests d'intégration et 243 rendus MLT strict logiciel passent. Le GPU complet
strict termine à 1 887/1 923 avec les mêmes 36 noms de tests en échec que le lot
précédent. L'[audit du prototype](../bench/baselines/direct-overzoom-final-20260908/qualification.json)
conserve ces échecs comme tels.

Cette qualification de parité ne signifie pas que la performance globale est
acquise. Trois séries navigateur montrent environ −37 % jusqu'au dessin à froid,
mais +18 % à chaud ; la première requête et la mémoire sont plus coûteuses. Les
anciennes campagnes d'arrivées contrôlées ci-dessous ne certifient pas automatiquement
ce nouveau produit. Aucune référence image/GeoJSON ni tolérance n'est actualisée dans ce lot.

## Arrivées vectorielles et DEM partielles — banc du 7 septembre

Le [rapport arrivées terrain](../bench/baselines/MLT_TERRAIN_ARRIVALS_20260907.md)
combine une rotation locale sur quatre DEM et un vol globe avec sources
incomplètes. Deux ordres de livraison et un DEM retardé sont exercés en production
Iris Xe et workers stricts Iris Xe/SwiftShader, avec deux passes inversant MVT/MLT.
Les trois campagnes passent : **828 comparaisons positives exactes et 36 contrôles
discriminants**, 276 captures par configuration. Les compteurs interdits et
`propertyProxyMisses` sont nuls dans les workers stricts.

La [vérification indépendante](../bench/baselines/browser-terrain-arrival-production-20260907/validation.json)
retourne le code 0 (`verified-controlled-terrain-arrivals`). Par campagne :
140 captures encore en chargement, dont 108 avec autorisations partielles ;
48 captures de DEM partiellement reçus et 64 événements publics d'annulation.
Caméras/états/requêtes/événements et réponses livrées correspondent aussi entre
configurations ; les pixels ne sont pas comparés entre GPU différents.

Les demandes HTTP répétées et annulations naturelles sont conservées. Seules les
requêtes annulées avant ouverture de leur autorisation peuvent différer au niveau
HTTP, sans réponse livrée ; réponses complétées, événements publics et parité
images/états/requêtes restent stricts. Les contrôles DEM comparent une caméra et
des arrivées vectorielles identiques, mais exigent des images différentes.

**405 tests ciblés et cinq tests du serveur HTTP**, typecheck et lint passent.
Sources produit, bundles, références et seuils sont inchangés ; aucune nouvelle
qualification des suites complètes ci-dessous n'est revendiquée. Les pannes HTTP,
reprises explicites, timings natifs, tactile/pinch et DEM réels restent à couvrir.

## Indexation des parties dégénérées — correction du 7 septembre

Le [rapport indexation](../bench/baselines/MLT_LINE_INDEX_20260907.md) corrige les
points et parties de lignes sans segment dessinable dans les requêtes MLT : leurs
emprises numériques sont conservées, sans créer de segment ni matérialiser de
géométrie worker. Les six nouveaux cas passent ; le style d'arrivées reste inchangé.

La [vérification indépendante](../bench/baselines/browser-arrival-production-v4-20260907/validation.json)
qualifie production Iris Xe et strict Iris Xe/SwiftShader : **276 comparaisons
positives exactes et 12 contrôles discriminants**, 88 captures par configuration,
dont 48 partiellement chargées. Caméras/états/requêtes/événements correspondent
aussi entre configurations ; pas de comparaison de pixels entre GPU différents.

**3 751 unitaires, 759 build, 178 intégration et 243 fixtures MLT strictes logiciel**
passent, ainsi que les 69 tests ciblés et le test serveur. Typecheck, lint et builds
dev/prod/strict dev/strict prod passent ; quotas et références render inchangés.
Les 1 680 tests render hors filtre ne sont pas comptés comme réussis. Le GPU complet
et le cache chaud restent ceux des lots antérieurs, non relancés ici.
Les anciens échecs d'arrivées restent historiques ; leur combinaison avec les
livraisons partielles de DEM et le terrain/globe est traitée dans le lot ci-dessus.

## Cache chaud et arrivées partielles du 7 septembre — produit inchangé

Le [rapport de ce lot](../bench/baselines/MLT_WARM_ARRIVALS_20260907.md) distingue
deux résultats. La préparation mondiale à cache chaud est maintenant enregistrée
avec ses dessins, puis suivie d'un aller-retour et des quatre animations, sans
rechargement imposé de source. Production Iris Xe et workers stricts Iris Xe/SwiftShader
passent leurs 432 captures chacun. Caméras, états, requêtes, chronologie des tuiles
et réutilisation du cache sont contrôlés, avec zéro matérialisation interdite dans
les workers stricts. Les anciens parcours natifs ne sont pas certifiés rétroactivement.
La [vérification indépendante](../bench/baselines/browser-warm-production-v3-20260907/validation.json)
retourne le code 0 (`verified-warm-history-parity`) : **1 290 comparaisons positives
exactes et six contrôles discriminants**. Les 336 tests ciblés, le test serveur,
le typecheck et le lint passent.

Le banc de livraisons partielles termine 8 sessions et 88 captures en production
GPU, mais **échoue** : les 44 images appariées sont exactes, tandis que 20 paires
de `queryRenderedFeatures` divergent sur deux points d'une couche `road` stylée
`line` sans filtre. Les 44 répétitions sont exactes ; le défaut persiste après
chargement complet. L'[audit](../bench/baselines/browser-arrival-production-v3-20260907/audit.json)
retourne le code 1, statut `partial-arrival-parity-failed` ; il ne devient pas une
qualification par suppression des points ou ajout d'une tolérance.

La suite est une correction de l'indexation numérique des géométries sans segment
dessinable, accompagnée d'un test réduit et de la matrice complète de livraisons
partielles. Ce lot ne modifie pas les sources produit, bundles, seuils ou références
render ; les suites complètes ci-dessous restent celles du dernier lot produit.

## Historique contrôlé du 7 septembre — lot de banc, produit inchangé

Le [rapport historique](../bench/baselines/MLT_HISTORY_20260907.md) ajoute un oracle
distinct du rejeu statique : vrais `easeTo`/`flyTo`, seize dessins à horloge contrôlée,
chargements terminés entre dessins sans repaint intermédiaire, puis frames de
stabilisation jusqu'à `idle`. Quatre animations, deux ordres et cartes neuves.

La source mondiale est rechargée à la pose de départ, avant la trace. Aucun cache
n'est désactivé ou effacé par le banc pendant l'animation. Les premières tentatives à cache
chaud avaient des tuiles retenues différentes ; leurs écarts restent archivés et
ce nouveau protocole ne les certifie pas rétroactivement.

- Production Iris Xe et strict Iris Xe/SwiftShader : **136/136 comparaisons MVT/MLT** et **136/136
  répétitions exactes** chacun, en pixels/caméras/GeoJSON/états. Huit comparaisons
  de préfixe exactes et deux contrôles discriminants réussis par campagne.
- Les deux contrôles insèrent un dessin au même instant 500 ms : caméra et
  requêtes inchangées, **15 488 pixels différents** sur Iris Xe, **15 531** sur
  SwiftShader, identiquement dans les deux encodages sur chaque backend.
  L'historique des textures est ainsi distingué de la seule pose.
- **48 captures avec chargement en cours** par campagne incluses dans les
  comparaisons ; ce ne sont pas des frames exclues. L'ordre brut des événements
  est conservé ; leur multiensemble par intervalle entre dessins doit correspondre.
- **336/336 tests ciblés** caméra/horloge/cache terrain, typecheck et lint réussis.
  Code produit et octets des bundles inchangés ; pas de nouvelle exécution des
  suites complètes du lot précédent, ni de mesure de performance ou mémoire GPU.

La [vérification indépendante](../bench/baselines/browser-history-production-v3-20260907/validation.json)
termine avec le code 0, statut `verified-controlled-history-parity` : **840
comparaisons positives exactes et six contrôles discriminants** recalculés.
Caméras, états, GeoJSON et événements par intervalle correspondent aussi entre
production, strict GPU et strict logiciel ; pas de comparaison de pixels entre GPU différents.

SwiftShader ne manque plus d'étapes dans ce protocole ; cela ne transforme pas
les anciens échecs en temps réel en succès. Les
préparations à cache chaud, arrivées partielles arbitraires, timings natifs et
tactile/pinch restent hors de ce protocole.

## Gestes et animations du 7 septembre — qualification partielle, dernier lot produit

Le [rapport gestes/animations](../bench/baselines/MLT_MOTION_20260907.md) ajoute huit
gestes souris/clavier natifs via Puppeteer/CDP et quatre animations sur le corpus
local globe/terrain. Il corrige un défaut commun MVT/MLT : après un cran isolé de
molette classifié avec retard, les événements de caméra perdaient `originalEvent`.
Deux tests publics distinguent les chemins immédiat/différé : 1/2 avant, 2/2 après.

- Production Iris Xe et worker strict Iris Xe : **42/48 comparaisons d'images
  exactes chacun**, dont **24/24 poses finales** et **18/24 frames intermédiaires**.
  Pose, GeoJSON complet et états restent conformes aux 48 comparaisons.
- Les six frames du vol terrain divergent du rejeu statique. Le contrôle MVT→MVT
  reproduit cet écart, MLT→MLT aussi ; l'orbite à zoom constant est exacte. Les
  textures terrain conservent leur historique pendant le zoom. Ce n'est ni une
  preuve de régression MLT, ni une certification de parité de ces frames.
- SwiftShader : **36 comparaisons exactes** avant interruption. L'orbite MLT ne
  fournit que deux frames chargées sur trois exigées, même isolée. Le vol et le
  deuxième passage prévu ne sont pas exécutés ; **qualification logiciel incomplète**.
- Aucun seuil de pixels, changement d'image attendue ou désactivation du cache.
  Les commandes de mouvement restent en échec, code 1. Les phases de chargement
  sont archivées séparément, pas comptées comme succès ; les trajectoires natives
  ne sont pas déclarées identiques. Aucun résultat FPS/mémoire GPU n'en est déduit.
- **3 745/3 745 unitaires, 759/759 builds, 178/178 intégration**, typecheck/lint
  et builds dev/production/strict réussis. L'intégration passe à la reprise complète
  isolée ; le premier échec Marker/terrain (177/178) reste conservé sans changer
  de fixture. Cette suite native, contrairement au corpus de mouvement, utilise
  certaines ressources réseau externes.
- **243/243 rendus MLT stricts logiciel**, **1 887/1 923 rendus GPU complets**,
  exactement les mêmes 36 échecs connus. Compteurs interdits et `propertyProxyMisses`
  nuls ; régression globe/terrain **23/23 checkpoints exacts** avec le correctif molette.
- Main : +23 octets bruts/+4 gzip ; worker/partagé inchangés, référence de taille
  et quotas inchangés dans ce lot. Tout reste local, sans push.
- Le [vérificateur indépendant](../bench/baselines/browser-motion-production-v3-20260907/validation.json)
  confirme ces archives et le code source, avec le statut
  `verified-partial-motion-qualification` et le code 1 : images non exactes et
  couverture logiciel incomplète restent des limites, pas des succès.

La prochaine étape est un oracle de rejeu avec historique des tuiles et textures,
ainsi qu'une couverture animée fiable en logiciel. Voir les archives détaillées et
les limites dans le rapport ; le manque de couverture n'est pas un succès partiel
transformé en validation de tout le parcours.

## Globe et terrain du 7 septembre — lot produit précédent

Le [rapport globe/terrain](../bench/baselines/MLT_GEOGRAPHY_20260907.md) ajoute un
parcours local/mondial avec DEM synthétiques non plats, sans accès réseau externe.
Il corrige deux défauts communs de projection (tuples littéraux et retour au globe
automatique), puis la subdivision numérique des fills/lignes MLT et leurs contours,
pôles et jointure du monde. Aucun `Point` reconstruit par ces nouveaux chemins.

- **23/23 checkpoints exacts** en PNG et GeoJSON complet : production Iris Xe,
  worker strict Iris Xe et worker strict SwiftShader. Sources/états conservés,
  altitudes et facteur effectif de projection vérifiés ; deux cycles supplémentaires
  de neuf mutations contrôlent les requêtes et états, sans captures additionnelles.
- Les premières campagnes avaient huit captures globales en échec malgré des
  requêtes et compteurs stricts conformes. Elles restent archivées ; aucune tolérance
  de pixels ou image de référence n'est modifiée pour obtenir la parité.
- **3 743/3 743 unitaires, 759/759 builds, 178/178 intégration** ; typecheck/lint
  et builds dev/production/strict réussis. La référence de taille est actualisée
  après mesure (+1 128 octets bruts/+256 gzip dans le partagé), quotas inchangés.
- **1 887/1 923 rendus GPU**, exactement les 36 échecs précédents, aucun nouveau
  ni disparu. La commande reste en échec, code 1.
- **243/243 rendus MLT stricts logiciel**, compteurs interdits nuls ; scénarios
  navigateur base 7/7 et styles 25/25 exacts. Le
  [vérificateur indépendant](../bench/baselines/browser-geography-production-v4-20260907/validation.json)
  valide PNG, GeoJSON, états, ressources et archives sans masquer les échecs connus.
- Pas de mesure de performance, d'animation ou de mémoire GPU dans ce lot.

## Image finale avant idle du 7 septembre — lot produit précédent

Le [rapport idle](../bench/baselines/MLT_IDLE_20260907.md) réduit l'écart logiciel
à un aller-retour de caméra avec symboles, en MVT comme en MLT. Après le dernier
dessin, le nettoyage des tuiles retenues pour fondu changeait les entrées du
placement sans demander une autre frame. Le correctif ne laisse plus la carte
émettre `idle` avant le dessin du jeu de tuiles final.

- Huit sessions diagnostiques corrigées : zéro pixel différent avant/après repaint,
  avec lecture de la dernière frame WebGL avant `idle`. Les captures avant correction
  et deux tests échouant sans la demande de frame sont conservés.
- Styles : **25/25 checkpoints exacts** sur Iris Xe en production/strict et dans
  deux passages SwiftShader stricts ; GeoJSON, source/feature-state et compteurs conformes.
- **3 730/3 730 unitaires, 759/759 builds, 178/178 intégration**,
  **243/243 rendus MLT stricts logiciel**, typecheck/lint/builds réussis.
- **1 887/1 923 rendus GPU complets**, exactement les mêmes 36 échecs connus.
  Un premier passage sur ports alternatifs avait 16 échecs supplémentaires dus
  aux URLs internes de TileJSON restées sur 2900 ; le rejeu sur ports standard
  et le premier rapport sont conservés. La suite GPU reste en échec (code 1).
- Scénarios navigateur base 7/7 et symboles 10/10 conformes ; aucune nouvelle
  mesure de performance/mémoire, aucune image attendue ou tolérance modifiée.

## Styles à chaud du 7 septembre — lot de banc précédent, qualification partielle

Le [rapport styles](../bench/baselines/MLT_STYLES_20260907.md) ajoute les setters
paint/layout/filter, `setStyle` avec diff/reconstruction, changement de ressources,
remplacement d'encodage et retrait/réintroduction de source. Aucun changement produit.

- **25/25 checkpoints exacts sur Iris Xe**, production et worker strict.
- Réponses GeoJSON et états conformes en logiciel ; dix compteurs interdits et
  `propertyProxyMisses` nuls à chaque relevé. Cinq cycles supplémentaires par session.
- **Logiciel en échec** au retour final : 38 puis 19 pixels MVT/MLT différents,
  delta maximal 1 ; le témoin MVT varie aussi au rejeu isolé. Aucun assouplissement.
- **320/320 unitaires ciblés**, typecheck/lint/builds réussis ; régressions symboles
  10/10 et base 7/7 conformes. Pas de nouvelle mesure de performance/mémoire.
- Le [vérificateur indépendant](../bench/baselines/browser-styles-production-20260907/validation.json)
  conserve `render-differences` et le code 1 ; les deux campagnes logiciel en échec
  restent archivées. La suite complète n'est pas relancée dans ce lot de banc.

Ce cas logiciel est réduit et corrigé dans le lot idle ci-dessus ; les archives
de ce premier passage gardent leur statut d'échec.

## Symboles/glyphes du 6 septembre — lot de banc précédent

Le [rapport symboles](../bench/baselines/MLT_SYMBOLS_20260906.md) étend le scénario
navigateur aux textes sur points/lignes, icônes, glyphes locaux et feature-state
d'un symbole. Aucun changement produit : les bundles sont identiques au lot intersections.

- **10/10 checkpoints exacts** en production GPU, worker strict GPU et worker strict
  logiciel, en GeoJSON complet et pixels MVT/MLT ; dix compteurs interdits présents et nuls.
- **91/91 unitaires ciblés**, typecheck/lint et builds production/strict réussis.
- **7/7 checkpoints du scénario de base** avec le banc final.
- **160 cycles animés**, mêmes nombres de résultats à chaque cycle ; les chronométrages
  fluctuent et ne démontrent pas de gain global. Pas de nouvelle mesure mémoire.
- Caméra non interactive et contrôlée, canvas réellement fixé à 800×600/DPR 1.
  Un essai préliminaire instable a été arrêté et conservé, sans assouplir les assertions.

Le [vérificateur indépendant et les archives](../bench/baselines/browser-symbols-production-v2-20260906/validation.json)
recalculent les signatures et contrôlent pixels, ressources, compteurs et charges.
La suite complète n'est pas relancée : son dernier résultat reste celui ci-dessous,
avec les 36 échecs GPU connus, et ne doit pas être présenté comme intégralement vert.

## Cache de topologie du 6 septembre — lot produit précédent

Le [lot intersections](../bench/baselines/MLT_INTERSECTIONS_20260906.md) mémorise
uniquement les bornes scalaires de la partie courante de `ColumnarGeometryView`.
Le curseur partagé peut être déplacé par une autre lecture sans invalider ces bornes ;
les changements de feature/partie et la fermeture virtuelle sont testés.

- **3 728/3 728 unitaires**, **750/750 builds**, typecheck, lint et builds
  dev/prod/worker strict réussis.
- **243/243 rendus MLT stricts en logiciel**, compteurs interdits nuls.
- **1 887/1 923 rendus GPU complets**, mêmes 36 échecs connus, aucun nouveau ;
  les compteurs worker restent aussi à zéro.
- **178/178 intégration**. Aucune référence GeoJSON, image ou tolérance changée
  dans ce lot ; les modifications du lot surzoom précédent restent distinctes.
- Quatre rotations avant/après × MVT/MLT sur build production : parité exacte
  des sept checkpoints entre versions/encodages ; temps de requête MLT en surzoom
  réduit de 15–20 %, ou 4–11 % avec GeoJSON/JSON. Pas de gain net à la vue initiale,
  ni de conclusion sur les FPS, la mémoire GPU ou le cycle animé complet.

Les [preuves de validation](../bench/baselines/browser-intersections-20260906/validation.json)
incluent rapports, compteurs et vérification des hashes. Le bundle partagé ajoute
318 octets bruts / 66 octets gzip ; main/worker et les quotas restent inchangés.

## Surzoom et projection GeoJSON du 6 septembre — lot précédent

Le [rapport surzoom/profil](../bench/baselines/MLT_ROUNDING_QUERY_20260906.md) décrit
l'arrondi final commun MVT/MLT et la projection publique sans `Point` intermédiaire.
Le scénario navigateur production atteint la parité exacte aux sept checkpoints,
surzoom compris : coordonnées, attributs, état, style et pixels. Aucun gain global
de temps avant/après n'est établi ; les profils isolent encore un coût d'intersection.

- **3 726/3 726 unitaires**, **750/750 builds**, typecheck, lint ciblé et builds
  dev/prod/worker strict réussis.
- **243/243 rendus MLT stricts en logiciel**, tous les compteurs interdits nuls.
- **GPU complet relancé après les corrections : 1 887/1 923**, exactement les mêmes
  36 échecs que `MLT_EXTENSION_20260906.json`, aucun nouveau ; garde-fous stricts nuls.
- **178/178 intégration** au passage final. Le premier passage 171/178 a révélé sept
  références GeoJSON MVT dépendant de l'ancien réencodage de deltas flottants. Elles
  ont été auditées contre le fichier brut avec les deux politiques puis actualisées.
  Un cas de bord inclut désormais Burlington County, id 33 ; le changement est
  documenté au changelog. Aucune image attendue ni tolérance n'a été modifiée.

Les [archives de validation](../bench/baselines/browser-rounded-direct-query-20260906/validation.json)
conservent les succès et échecs, les réponses GeoJSON avant/après et l'audit.
Le test Marker/terrain historiquement instable passe cette fois, sans correction
spécifique dans ce lot. Les campagnes mémoire et animées précédentes n'ont pas été
rejouées. Les sections suivantes conservent les résultats de leurs snapshots respectifs.

## Qualification navigateur du 6 septembre — corrections locales après `cfb9f34ae`

Le [scénario sur build production](../bench/baselines/MLT_BROWSER_QUALIFICATION_20260906.md)
a mis en évidence trois défauts qui n'étaient pas couverts par les images seules :
indices de source-layer projetés perdus au transfert, attributs non stylés perdus au
surzoom, et bindings incomplets de propriétés différées dans les valeurs paint/layout
retournées par les requêtes. Les trois sont corrigés avec tests de non-régression ;
aucune modification de Tile Spec n'a été nécessaire.

- 3 715/3 715 tests unitaires confirmés (code 0), 750/750 tests de build.
- Typecheck, lint des fichiers modifiés, builds dev/prod et worker strict : réussis.
- 243/243 fixtures MLT strictes en logiciel : tous les compteurs interdits restent nuls.
  817 couches, 3 273 colonnes, 2 535 723 valeurs et 29 377 563 octets de colonnes décodés ;
  156 796 506 octets cumulés de copies brutes. Le surzoom doit désormais conserver
  aussi les colonnes des attributs publics non utilisés dans le style : ces volumes
  ne doivent pas être comparés à un chemin qui perdait ces attributs comme s'il
  effectuait le même travail.
- Interactions relancées : 177/178, même test terrain `Marker: correct position`
  en échec ; ne pas présenter cette suite comme verte.
- Navigateur Iris Xe, sept checkpoints multicouches : attributs, IDs, états,
  nombres de résultats et paint/layout évalués identiques ; géométrie et image
  exactes sur cinq checkpoints. Les deux vues en surzoom ont encore des écarts de
  quantification et 1 034 / 112 pixels différents sur 480 000.

La suite GPU complète de 1 923 fixtures n'a pas été relancée après ces trois
corrections : son résultat historique ci-dessous reste attaché au snapshot précédent.
La référence de taille des bundles a été actualisée aux octets mesurés après les
corrections (+85 octets worker et +341 shared par rapport au premier build du lot,
main inchangé) ; les quotas de taille sont inchangés. Le premier contrôle 749/750,
le contrôle final, les rapports bruts et compteurs sont archivés dans
[`validation.json`](../bench/baselines/browser-cfb9f34ae-20260906/validation.json).

Les nouvelles mesures navigateur ne remplacent pas les campagnes Node historiques
ni une validation exhaustive du surzoom. Les modifications de ce lot restent locales.

## Extension du 6 septembre 2026 — après consolidation et mesures

La consolidation `ff84d7466` est suivie de l'optimisation des propriétés publiques
`babea70db` et de ses [six campagnes documentées](../bench/baselines/MLT_POST_MERGE_20260906.md)
(`594ba2eb7` pour l'archive). Les résultats historiques plus bas restent ceux de
la consolidation, pas une certification implicite des modifications suivantes.

L'extension ajoute `zoom` et `is-supported-script` au filtre columnar, avec les
`EvaluationParameters` des buckets et des requêtes : le zoom effectif/overscaled
est distinct du zoom canonique utilisé par `within`. La sémantique sans callback,
les erreurs de type, le court-circuit, les expressions imbriquées et le plugin RTL
chargé/non chargé sont comparés à l'évaluateur natif.

`heatmap` utilise désormais le maillage columnar commun aux cercles, sans clé de
tri de cercle et avec subdivision pour le globe. Les tests comparent les buffers
MVT/MLT aux granularités 1/3/5/7, les multipoints et points hors extent, radius/weight,
les valeurs réellement mises à jour après transfert et les intersections de requêtes.

État de vérification de l'extension :

- 262 tests ciblés réussis ; **3 712/3 712 tests unitaires** réussis ensuite.
- Builds dev/prod et worker strict, typecheck, lint des fichiers modifiés : réussis.
- 750/750 tests de build réussis.
- **243/243 fixtures du corpus MLT réussies en logiciel strict**, dont 12 nouvelles
  fixtures dans `mlt/heatmap-globals` (six paires MVT/MLT).
- Suite GPU complète : **1 887/1 923 images conformes** sur
  `ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2), OpenGL ES 3.2)`.
  Les 36 fixtures en échec sont exactement celles du passage précédent : aucune
  nouvelle fixture en échec, aucun échec disparu. Les 12 nouvelles fixtures passent.
  La commande reste en échec (code 1) ; les qualifications upstream/MVT historiques
  ci-dessous ne sont pas transformées en succès de la suite complète.

Les nouvelles références sont produites exclusivement par les six variantes MVT,
puis partagées avec leur paire MLT : basic, data-driven, feature-state, globe,
zoom-filter et script-filter. Les nouvelles images ont été inspectées ; les anciennes
références restent inchangées. Le lancement de génération MVT seul avec le worker
strict produit les six images, puis échoue volontairement au garde-fou global
« doit exercer du décodage MLT ». Le lancement commun des 12 variantes passe ;
chaque variante MLT a des compteurs de décodage non nuls.

Le passage logiciel complet mesure 817 couches, 2 221 colonnes, 1 888 273 valeurs
et 23 521 972 octets de colonnes décodés. Fallback worker, wrappers, objets de
propriétés, Points/parties matérialisées, tuples, descripteurs et réencodages MVT
restent tous à zéro. Les copies de tuile brute restent mesurées séparément :
156 568 643 octets cumulés, et non un pic de mémoire.
Les mêmes totaux et zéros sont vérifiés sur le passage GPU complet.

Audit des filtres : 1 923 fixtures, 999 occurrences, **998 prises en charge,
0 valides non prises en charge dans ce corpus, 1 invalide selon la spécification**.
Ce n'est pas une couverture de toute la spécification : `distance` reste un manque
valide hors corpus ; `feature-state` dans un filtre reste invalide. L'audit couvre
les couches initiales et certaines opérations dynamiques, pas tous les `setStyle`
ou filtres de requêtes possibles.

Preuves de l'extension : `/tmp/mlt-performance.jt1Hcv/extensions-*.json` et `.log`.
Le [résumé de validation versionné](MLT_EXTENSION_20260906.json) conserve les totaux,
les 36 noms de fixtures en échec et la comparaison des six paires nouvelles :
**zéro pixel RGBA différent sur GPU pour chaque paire MVT/MLT**.
Les nouveaux styles et leur générateur, les tuiles et les références MVT sont versionnés.
Les commandes de reproduction restent celles du rapport ci-dessous ; le sous-ensemble
nouveau se sélectionne avec `-t 'tests/mlt/heatmap-globals/'`.

## Historique — validation de la consolidation upstream

Campagne commencée le 6 septembre 2026. Révisions de départ : GL JS `e1ce7e58c3`,
Tile Spec `1ec5c6b1`. Node 24.18.1 ; npm 11.16.0.

## Critères et ordre de travail

1. Vérifier les 231 fixtures du répertoire de rendu MLT (218 render-layers,
   10 filter-parity, 3 synthetic-smoke), puis la suite complète de rendu et les
   interactions. Expliquer les écarts par comparaison à l'upstream si nécessaire.
   Vérifier séparément les garde-fous de non-matérialisation.
2. Construire une matrice des filtres valides supportés/manquants, des rejets
   attendus et des couches supportées. Comparer les sélections avec l'évaluateur
   standard sur les mêmes données.
3. Corriger les écarts et compléter les preuves sur les trous/multiparties,
   frontières de tuiles, overzoom, symboles sur lignes, feature-state, requêtes,
   patterns et dasharrays.
4. Compléter la validation logicielle par une exécution sur GPU matériel, avec
   identification du moteur WebGL, puis finaliser la documentation.

Une image correcte et une absence de matérialisation interne sont deux critères
distincts. Les objets produits à la demande pour l'API GeoJSON publique ne sont
pas interdits par le second critère.

## Résultats logiciels

Les journaux et JSON détaillés sont conservés dans `/tmp/mlt-post-merge.56G54Q`.
Ce dossier est temporaire ; les commandes ci-dessous permettent de régénérer les preuves.
Aucune image attendue n'a été remplacée.

Les corrections de cette campagne sont versionnées avec ce rapport dans GL JS. Tile Spec n'a
pas été modifié pendant la consolidation. Les anciennes branches, stashes et artefacts de
benchmark présents avant la campagne sont conservés ; le worktree upstream diagnostique
reste dans le dossier temporaire pour permettre l'inspection.

| Campagne | Résultat | Interprétation |
| --- | --- | --- |
| Render MLT initial | 231/231 | Images correctes ; ne prouve pas l'absence de matérialisation |
| Render complet initial | 1880/1911, 31 échecs | Aucune fixture omise |
| Réexécution des régressions après correction | 27/32 | Les 23 échecs de dégradés sont corrigés ; les 3 timeouts terrain passent |
| Vidéo et transition de texte en séquentiel | 2/2 | Sensibilité au timing/concurrence, pas reproduite dans ce passage |
| Intégration complète initiale | 176/178 | Échecs Marker terrain et fullscreen shadow DOM |
| Intégration complète finale | 177/178 | Seul le timeout Marker terrain subsiste ; également reproduit upstream |
| MLT strict après corrections | 231/231 | 808 couches décodées, garde-fous actifs dans les workers |
| Suite unitaire finale | 3689/3689, 236 fichiers | Parallélisme limité à 4, timeout de test 20 s |
| Tests de build finaux | 750/750 | Parallélisme limité à 2, timeout de test 20 s pour les imports ESM |
| Typecheck et lint des fichiers modifiés | Réussis | Aucun changement des seuils de lint |

Les échecs `text-local-glyphs/no-glyphs`, `text-local-glyphs/missing` et
`text-local-ideographs/cjk-symbols` se reproduisent sur l'upstream isolé `32e555b2c1`.
Le timeout `Marker: correct position` s'y reproduit aussi et dépend de sources terrain distantes.
Les timeouts terrain ne sont pas stables entre passages. La course de chargement du test
fullscreen shadow DOM a été corrigée en attendant la création effective de la carte.
Ce résultat n'est donc pas une déclaration « suite complète verte ».

Un premier passage unitaire sous forte charge donnait 3 échecs (ordre de requêtes setStyle,
deux timeouts scroll-zoom). Les deux fichiers passent séparément, puis la suite entière passe
avec les paramètres bornés ci-dessus. Aucun test n'a été supprimé ni désactivé.

Les builds dev et production réussissent. Les bundles main et worker ont exactement la taille
de référence ; le shared augmente de 442 octets bruts / 321 octets gzip. Sa référence de taille
a été actualisée après mesure (pas les quotas). Un import des constantes GeoJSON-VT depuis le
code partagé déplaçait inutilement le tiler vers ce bundle : les clés sont des littéraux vérifiés
contre les exports upstream dans le test, afin de conserver la séparation des bundles.

### Régressions corrigées

- Les métriques de lignes GeoJSON-VT utilisent désormais `geojsonvt_clip_start/end`.
  Les deux buckets prennent ces clés en priorité, avec compatibilité pour une paire complète
  `mapbox_clip_start/end` ; les dépendances de décodage projeté comprennent les deux variantes.
- Les chemins de paint et de dépendances pattern des lignes/fills ne reconstruisent plus
  systématiquement des dictionnaires `properties`.
- Le placement ponctuel des symboles sur lignes et polygones ne passe plus par `Point[][]`.
  La recherche de pôle d'inaccessibilité accepte une vue scalaire avec trous ; les frontières
  des polygones d'une multipolygone sont préservées.
- `within` est accepté comme booléen imbriqué dans une comparaison ou une expression.
  Un test compare les indices sélectionnés à l'évaluateur standard pour intérieur, extérieur
  et frontière, avec les garde-fous stricts actifs sur le chemin columnar.
- Les constructions des vecteurs séquentiels des benchmarks spécifient leur caractère signé,
  conformément à l'API MLT intégrée ; les identifiants négatifs restent négatifs.

### Contrat strict mesuré

Sur les 231 fixtures : `workerFilterFallbackFeatures`, `vectorTileFeatureWrappers`,
`propertyObjects`, `propertyProxyMisses`, `pointObjects`, `geometryPartsMaterialized`,
`overzoomPointObjects`, `mvtReencodes`, `rawTileMainThreadDecodes`, `coordinateTuples` et
`propertyDescriptors` sont tous à zéro dans les workers instrumentés.
Le passage a clippé 6 594 entités en overzoom et décodé 2 188 colonnes.

Ce n'est pas du « zéro allocation » : les buffers plats et ancres sont permis. Les copies
brutes restent présentes (`rawTileBytesCopied` : 156 567 882 octets cumulés sur ce passage,
pas un pic mémoire). Les requêtes publiques peuvent produire des objets GeoJSON à la demande ;
les tests unitaires d'index/requêtes complètent les tests render, qui ne les exercent pas tous.
Les compteurs vérifient les frontières instrumentées, pas toutes les allocations V8 possibles.

## Matrice de couverture

L'audit `test/integration/lib/mlt_filter_audit.ts` examine les couches vector/GeoJSON des
1 911 fichiers `style.json`, les opérations `addLayer`, `setFilter` et les valeurs de
global-state à chaque changement. Ce n'est pas un recensement exhaustif de la spécification,
ni une conversion automatique des fixtures GeoJSON. Les styles chargés par `setStyle` et
les filtres des requêtes ne font pas partie de cette matrice.

| Statut des occurrences de filtres | Initial | Après correction `within` |
| --- | ---: | ---: |
| Pris en charge | 992 | 993 |
| Valides mais non pris en charge | 2 | 1 |
| Syntaxe invalide selon style-spec | 1 | 1 |

- Manque valide du corpus : `is-supported-script/filter`, opérateur `is-supported-script`.
- Rejet attendu : `filter/mixed-legacy-expression`, mélange syntaxe historique/expression.
- Aucun filtre du sous-corpus MLT actuel n'est rejeté.
- Exemples valides hors corpus encore rejetés : `zoom`, `distance`.
- `feature-state` dans un filtre est invalide ; ne pas le confondre avec le paint state-dependent.

Les tests de parité existants comparent les sélections avec le chemin standard sur des
données synthétiques et réelles, dont les chaînes flat/dictionary/FSST. La classification
« supporté » seule n'est pas une preuve de parité pour toute combinaison de valeurs.

| Couches | État MLT |
| --- | --- |
| fill, line, circle, symbol, fill-extrusion | Autorisées ; couvertes par les fixtures strictes |
| heatmap | Rejet explicite dans WorkerTile ; 45 occurrences dans le corpus de référence audité, aucune MLT |
| background, raster, hillshade, custom… | Pas des buckets de features MLT ; hors de cette liste |

Les tests de `columnar_synthetic_bucket_parity`, `columnar_symbol_geometry`, `symbol_bucket`,
`worker_tile_mlt_real_tile`, `vector_tile_mlt`, `vector_tile_worker_source` et `feature_index`
couvrent les trous/multiparties, limites de tuiles, overzoom, placement sur lignes, paint
state-dependent, queries, patterns et dasharrays. La couverture est bornée à ces cas, pas à
toutes les géométries ou tous les styles possibles.

## GPU matériel

Configuration constatée pour les 1 911 cartes : Chrome/152.0.7977.75,
`ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2), OpenGL ES 3.2)`.
Lancement Linux en session graphique, ANGLE `gl-egl`. Le lanceur échoue si le renderer
constaté est SwiftShader, llvmpipe, softpipe ou non identifié.

La suite complète GPU, worker strict actif, termine à **1 875/1 911** : 36 différences
d'images, aucune fixture omise, aucun compteur interdit non nul. Le sous-corpus MLT termine
à **224/231** contre les baselines enregistrées (dont cinq échecs réellement MLT et deux MVT).
Ce n'est pas une campagne GPU entièrement verte.

Les **29 échecs hors du répertoire MLT se reproduisent tous** dans l'upstream isolé,
avec le même profil GPU (`upstream-hardware-failures.json`). Ils concernent notamment
polices, terrain/globe, raster et superpositions translucides. Cette comparaison situe ces
écarts hors des modifications columnar ; elle ne remplace pas une correction des baselines
ou du moteur upstream.

Qualification des sept échecs du répertoire MLT :

- `filter-parity/{mlt,mvt}-line-filter-matrix` et `{mlt,mvt}-fill-arithmetic` : les paires
  MLT/MVT ont zéro pixel différent au seuil pixelmatch du lanceur, sur ce GPU.
- `render-symbol-visibility-visible` : zéro pixel différent de la fixture MVT native
  `visibility/symbol/visible`, qui échoue aussi contre les baselines.
- `render-fill-extrusion` / `render-fill-extrusion-pattern` : 95 / 108 pixels différents
  des baselines logicielles sur 65 536 pixels. Un export MVT hors mesure a été rendu par
  l'upstream isolé sur le même GPU ; les écarts MLT/MVT (38 / 41 pixels) sont exclusivement
  aux lignes 9–12, là où le debug affiche la taille en kB des tuiles encodées. Le reste de
  l'image est identique au seuil du lanceur. L'overlay n'est donc pas une référence commune
  aux deux formats. Aucune image attendue ni tolérance n'a été changée.

Les métadonnées et compteurs complets sont dans `hardware-full-metadata.json` et
`hardware-full-worker-stats.json` du dossier de campagne. La conversion diagnostique est
dans `export-gpu-references.ts` ; elle matérialise volontairement les **entrées de référence**,
jamais le chemin MLT strict mesuré. L'upstream temporaire a seulement reçu des adaptations de
lanceur (ports/GPU) et ces fixtures diagnostiques, pas de modification de son moteur.

## Commandes

```bash
npm run build-dev
npm run build-css
RENDER_TEST_CONCURRENCY=4 npm run test-render -- --run -t 'tests/mlt/'
RENDER_TEST_CONCURRENCY=4 npm run test-render -- --run
npm run test-integration
npm run test-unit -- --maxWorkers=4 --testTimeout=20000
npm run test-build -- --maxWorkers=2 --testTimeout=20000

# Audit reproductible (écrit le JSON détaillé au chemin demandé)
MLT_FILTER_AUDIT_OUTPUT=/tmp/mlt-filter-audit.json npx vite-node test/integration/lib/mlt_filter_audit.ts

# Bundle indépendant, garde-fous actifs durant toute la vie des workers
BUILD=dev npx rolldown -c rolldown.config.mlt-validation.ts
MLT_RENDER_STRICT=true RENDER_TEST_CONCURRENCY=3 npm run test-render -- --run -t 'tests/mlt/'

# GPU identifié ; cette configuration Linux requiert une session graphique
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false MLT_RENDER_STRICT=true \
  RENDER_TEST_CONCURRENCY=2 npm run test-render -- --run -t 'tests/mlt/'

# Retirer le filtre -t pour la campagne GPU complète de 1 911 fixtures
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false MLT_RENDER_STRICT=true \
  RENDER_TEST_CONCURRENCY=2 npm run test-render -- --run
```

Par défaut, Puppeteer utilise `--disable-gpu` et SwiftShader. Les métadonnées du renderer
de chaque carte sont écrites dans `render/results-metadata.json` et les compteurs stricts
dans `render/mlt-worker-stats.json` (fichiers ignorés par Git). Les variables
`RENDER_TEST_METADATA_OUTPUT` et `MLT_WORKER_STATS_OUTPUT` permettent de conserver chaque passage
à un chemin distinct. `RENDER_TEST_PORT` configure les deux ports adjacents (2900/2901 par défaut).
Attention : cette relocalisation ne réécrit pas les URLs internes aux TileJSON
statiques. Utiliser 2900/2901 pour une campagne complète incluant ces ressources.
