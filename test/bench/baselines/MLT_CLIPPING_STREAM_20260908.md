# MLT → rendu : clipping en flux — 8 septembre 2026

## Changement et référence

`sliceGeometryVector` lit et transforme les sommets à la demande. Un découpeur
X alimente un découpeur Y, qui écrit les coordonnées arrondies dans le constructeur
de géométrie enfant. Les buffers `Float64Array` transformé/X/Y, les offsets de
parties intermédiaires et les passes de comptage par axe sont supprimés.
Les deux découpeurs utilisent une quantité constante d'état, réutilisée entre
parties/features de la même table. La sortie reste proportionnelle à la géométrie.

Les opérations et l'ordre MVT sont conservés : intersections X puis Y, fermeture
polygonale entre axes, séparation des lignes, arrondi seulement après les deux
axes et suppression de fermeture d'après les coordonnées **non arrondies**.
Les colonnes/IDs indexés du parent, l'invalidation par contenu, la triangulation,
la subdivision et les shaders ne changent pas. Aucun fichier produit GL n'est
modifié par ce lot ; son changement produit se limite au clipper TileSpec.

La référence inclut le remappage polygonal du lot précédent. Archive :
`polygon-remap-checkpoint-20260908/workspace.tar.gz`, SHA-256
`0d178c6a7eea9d9a1a8e11e9cf5c8521d3c8c874cdbe5454d9bc70e9817c7695`.
Extraction isolée : `/tmp/mlt-clipping-before-iAMWuH`. Les sourcemaps des bundles
production confirment l'ancien clipper avant et le clipper en flux après.
Les modules worker figés sont `clipping-stream-{before,after}-module-20260908`.

Ce n'est pas zéro allocation : la sortie numérique enfant, les tableaux du
constructeur puis leur conversion typée restent présents. Les lectures denses
et indexées n'allouent plus de paire de coordonnées ; le lecteur Morton conserve
son décodeur existant et ses petits objets temporaires. Ce lot n'en change pas
la sémantique et ajoute une comparaison Morton/dense/indexé.

## Parité et contrôles locaux

Les trois nouveaux tests GL comparent les APIs publiques MVT et MLT sur des
intersections fractionnaires/négatives, tangences aux bords, trous, sorties et
rentrées multiples, sommets répétés, points et parties réduites. Ils incluent
160 parcours multiparties déterministes, avec ou sans dictionnaire de sommets.
L'entrée MLT ne peut pas appeler `getGeometries`. Le GeoJSON/géométrie de sortie
peut être matérialisé par le test. Avec les tests du corpus réel à z+1/z+2,
neuf tests passent sur la référence **avant** modification du produit.

Après modification : 55 tests GL ciblés réussis, puis **3 770 tests unitaires GL**
et **2 622 tests TileSpec** réussis. Les nouveaux tests TileSpec couvrent aussi
Morton, les parties vides/singletons, les offsets de tuile et deux buffers de
découpage. Typecheck, lint ciblé GL et lint TileSpec passent.

Les builds prod/dev et workers stricts prod/dev passent. Les tests de build
font 758/759 sous charge concurrente, avec un échec d'import du main ESM ; le
rejeu complet isolé fait **759/759**, sans changement de produit ou de test.
Les deux résultats sont conservés ; la cause précise de ce premier échec n'est
pas établie par le seul succès du rejeu.
L'intégration complète finale passe à **178/178** sans modification de référence.

## Worker isolé : trois campagnes

Même banc `mlt-direct-pipeline.test.ts`, dix échauffements et trente observations
par variante avant/après × MVT/MLT × cache froid/chaud. Le froid vide explicitement
le cache de surzoom ; le chaud le conserve. Ordre tournant, aucun autre test,
build ou navigateur de mesure concurrent. Les captures et requêtes sont hors
chronométrage worker.

| Campagne, MLT froid | Avant | Après | Ratio apparié médian |
| --- | ---: | ---: | ---: |
| 1 | 8,320 ms | 4,881 ms | 0,575 |
| 2 | 9,403 ms | 5,597 ms | 0,591 |
| 3 | 9,724 ms | 5,792 ms | 0,604 |

Les ratios apparient les mêmes itérations ; ils ne sont pas le quotient des
médianes globales. Ils indiquent environ **40–42 % de temps worker en moins**
à froid sur ce corpus. Les ratios témoins MVT froid sont 1,004/1,012/1,056.
En MLT chaud : 0,996/1,024/1,030, sans gain établi ; le clipping ne s'y répète pas.

Les trois rapports `clipping-stream-worker-{1,2,3}-20260908.json` conservent les
mesures brutes. Positions/indices de triangles et 423 réponses publiques sont
identiques entre toutes les variantes. Ce hash ne couvre pas tous les attributs
de peinture ni les contours ; les contrôles visuels restent nécessaires.
Ce diagnostic Node ne mesure pas le GPU et n'installe pas le registre de parents
du thread principal : les octets parent sont retournés et la requête suit le
chemin indépendant. Les temps de requêtes/transfert restent séparés.

## Navigateur et qualification visuelle

Deux campagnes indépendantes utilisent les mêmes bundles :
`browser-clipping-first-overzoom-production-20260908` et
`browser-clipping-first-overzoom-production-repeat-20260908`.
Le banc `mlt-first-overzoom-browser.ts` utilise une carte et un worker neufs
pour chaque premier surzoom, avec douze rotations avant/après × MVT/MLT par
campagne. Changer seulement l'URL ne garantit pas un cache de géométrie froid
avec le parent adressé par contenu. Chrome 152, Iris Xe, 800 × 600, DPR 1,
style de base Berlin (polygones, lignes, cercles), aucun test/build concurrent.

| Médiane du premier surzoom | Campagne 1, avant → après | Campagne 2, avant → après |
| --- | ---: | ---: |
| MLT, action → premier dessin chargé | 141,500 → 110,050 ms | 142,650 → 108,900 ms |
| MVT témoin, action → premier dessin chargé | 155,700 → 156,050 ms | 158,100 → 160,700 ms |
| MLT, requêtes complètes après dessin | 124,850 → 103,500 ms | 127,150 → 101,200 ms |
| MVT témoin, requêtes complètes après dessin | 55,850 → 56,600 ms | 58,050 → 54,800 ms |

Le gain jusqu'au dessin est d'environ **22–24 %** sur ce scénario de premier
surzoom, indépendamment du gain worker Node. Les requêtes MLT deviennent moins
coûteuses mais restent plus lentes que MVT ici. Il ne s'agit ni d'un gain de FPS,
ni d'une accélération garantie au natif, à chaud ou pour tous les styles.
L'installation initiale de carte/style est exclue. Le chronométrage s'arrête
à la soumission CPU du dessin, pas à la présentation ou fin d'exécution GPU.

Les **96 captures** et toutes les réponses publiques sont exactes avant/après
et entre formats. Chaque observation conserve son PNG et ses GeoJSON complets
compressés ; `--verify` recalcule les signatures et compare les pixels, vérifie
l'ordre tournant, les hashes des bundles et ceux du banc. Les timings bruts
sont conservés. Aucune conclusion sur la mémoire conservée n'est tirée de ce banc.

Les nouveaux bundles passent également les contrôles suivants :

- GPU strict complet : **1 887/1 923**, avec exactement les mêmes 36 noms en
  échec que le remappage polygonal. Onze compteurs vérifiés nuls pour les
  1 923 fixtures, dont les fallbacks, wrappers, propriétés, points, réencodages
  et `propertyProxyMisses`. Ces compteurs couvrent les frontières instrumentées.
- Comparaison des 36 images en échec avec le remappage : **35 identiques** ;
  `terrain/symbol-height-offset-occluded-ground` varie de 23 pixels, maximum
  11 niveaux par canal. Cette image est exactement celle de la qualification
  indexée antérieure. La fixture utilise un DEM et du GeoJSON, pas de MLT.
  L'écart est conservé, sans changement de référence ni de tolérance.
- Logiciel strict : **243 fixtures MLT réussies**, zéro échec, 1 680 autres tests
  non sélectionnés. Compteurs interdits nuls et décodage MLT effectivement exercé.
- Globe/terrain strict GPU et logiciel : **23 paires exactes par configuration**,
  et 27 étapes répétées par encodage/configuration. Un audit séparé recalcule
  les 46 paires PNG et les 92 archives complètes de requêtes, les hashes des
  entrées/bancs, les états répétés et les compteurs.
- Styles à chaud strict GPU : **25 paires exactes**, changements de style,
  ressources, feature-state et remplacements de source compris, trois cycles.

Les rapports sont dans `browser-clipping-geography-strict-{gpu,software}-20260908`
et `browser-clipping-styles-strict-gpu-20260908`. L'audit de géographie et le
résumé du banc styles sont dans `clipping-stream-checkpoint-20260908/browser-parity-audit.json`.
Les images des 36 échecs GPU sont archivées avant les campagnes suivantes dans
`clipping-stream-checkpoint-20260908/gpu-failure-images.tar.gz`, avec leur comparaison
dans `gpu-comparison.json`. Ce lot ne réattribue pas les campagnes historiques
d'arrivées/animations à ces nouveaux bundles et ne certifie pas tous les styles.

## Suite

Le [checkpoint](clipping-stream-checkpoint-20260908/checkpoint.json) conserve les
empreintes des sources et résultats. Son delta face à la référence est limité
à `overzoom/sliceGeometryVector.ts` et deux nouveaux fichiers de tests ; aucun
autre fichier produit ne diffère. Les 47 rapports/logs de cette campagne,
échecs initiaux inclus, sont dans `validation-artifacts.tar.gz`, les bancs dans
`bench-harnesses.tar.gz`, et les sources/bundles actuels dans `workspace.tar.gz`
du même répertoire. Les campagnes navigateur et les modules avant/après restent
dans leurs répertoires dédiés. Les modifications sont locales, sans commit/push.

La géométrie enfant finale est encore stockée pour les buckets et les requêtes.
Le prochain raccourcissement doit examiner ses copies et les écritures des
buffers de rendu, sans multiplier les découpages pour chaque couche ou requête.
La parité universelle n'est pas acquise : `distance`, les six anciens tests
de filtres hors configuration unitaire et les écarts GPU connus restent ouverts.
