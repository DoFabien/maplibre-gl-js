# MLT → buffers polygonaux : réutilisation des indices — 8 septembre 2026

## Changement

Le chemin columnar des polygones réutilise `oldToNewIndices`, calculé lors de
l'initialisation des sommets. Les indices possédés par le résultat de `earcut`
sont remappés en place : pas de seconde recherche par coordonnées et pas de
tableau de conversion intermédiaire. Triangulation, ordre des sommets, arrondi,
déduplication, winding, contours et traitement des pôles gardent leurs algorithmes.
Les entrées de l'appelant ne sont pas modifiées. Le chemin MVT est inchangé.

La référence figée est le [lot vues indexées qualifié](indexed-columns-qualified-20260908/qualification.json),
dont les sources étaient identiques au début de ce changement. Son archive
`indexed-columns-checkpoint-20260908/workspace.tar.gz` a été extraite dans
`/tmp/mlt-polygon-before-C6lzuw`, sans restauration sur les dépôts de travail.
Les modules Node avant/après sont `polygon-remap-{before,after}-module-20260908`.

## Diagnostic worker isolé

Trois processus par mode, dix échauffements et trente échantillons par variante.
L'ordre avant/après × MVT/MLT est tournant. Au zoom natif, chaque charge utilise
une nouvelle table ; en surzoom le mode froid vide explicitement le cache worker,
le mode chaud le conserve. Les requêtes et captures de buffers sont hors du
chronométrage worker. Aucun test/build ni autre campagne n'est lancé en parallèle.

| Mode MLT, médiane des trois médianes de session | Avant | Après | Médiane des trois ratios appariés |
| --- | ---: | ---: | ---: |
| Chargement natif | 5,650 ms | 5,209 ms | 0,922 |
| Surzoom, cache froid | 10,175 ms | 9,996 ms | 1,002 |
| Surzoom, cache chaud | 2,753 ms | 2,572 ms | 0,941 |

Les ratios appariés comparent les mêmes numéros d'itération, puis sont résumés
par session ; ils ne sont pas le quotient des deux colonnes précédentes.
Les trois ratios natifs MLT sont 0,919 / 0,922 / 0,928, contre
0,996 / 1,004 / 0,992 pour MVT. En surzoom chaud, le gain est plus dispersé
(0,924 / 0,976 / 0,941). **Pas de gain froid établi** :
1,014 / 1,002 / 0,994. Le clipping et la gestion du parent ne sont pas modifiés.

Les six rapports `polygon-remap-{native,overzoom}-worker-{1,2,3}-20260908.json`
conservent les mesures brutes et empreintes des entrées/modules. Les positions
et indices de triangles sont exacts entre toutes les variantes, ainsi que les
requêtes complètes : 1 978 résultats natifs et 423 en surzoom. Les contours
sont comparés par les tests publics de subdivision, pas par ce hash worker limité
aux positions et triangles. Ce diagnostic n'installe pas le registre main de
parents : les octets bruts sont toujours retournés et les requêtes utilisent
le chemin indépendant. Il ne mesure ni le GPU ni le délai navigateur.

## Contrôles locaux

Trois tests supplémentaires couvrent trous, sommets fusionnés après arrondi,
contours par anneaux/segments ou absents, zoom natif et pôles, entrées gelées,
maillages vides et dégénérés. Ils passent avant modification du produit puis
après, avec 48 tests ciblés subdivision/buckets réussis.
Les validations de cette variante sont consignées ci-dessous ; celles du lot
précédent ne sont pas présentées comme de nouvelles validations de ce changement.

## Navigateur de production : deux campagnes indépendantes

Le [premier passage](polygon-remap-comparison-20260908.json) et sa
[répétition](polygon-remap-comparison-repeat-20260908.json) utilisent les mêmes
bundles, le même banc et le même corpus local Berlin, sans tests/builds concurrents.
Chaque campagne contient quatre rotations complètes des conditions avant/après ×
MVT/MLT, avec cinq échauffements et vingt rechargements par zoom. Scénario `base`
(polygones, lignes, cercles), Chrome 152 / Iris Xe, 800 × 600, DPR 1, un worker.

| Rechargement → premier dessin chargé, médianes de session | Premier passage, avant → après | Répétition, avant → après |
| --- | ---: | ---: |
| MLT, zoom natif | 61,725 → 60,525 ms | 62,825 → 59,600 ms |
| MLT, surzoom | 54,200 → 50,525 ms | 54,325 → 52,500 ms |
| Témoin MVT, zoom natif | 64,625 → 69,400 ms | 66,925 → 67,425 ms |
| Témoin MVT, surzoom | 83,850 → 84,325 ms | 82,850 → 81,875 ms |

Le premier témoin MVT natif variait davantage que prévu, d'où une répétition
complète plutôt qu'une conclusion sur ce seul passage. Cette variation ne se
retrouve pas avec la même amplitude dans la seconde campagne. Les médianes MLT
baissent dans les deux campagnes, mais les écarts par session sont dispersés :
ce n'est ni un gain garanti pour chaque rechargement ni une accélération générale
de tous les styles. Le gain worker ciblé est plus net que le gain jusqu'au dessin.

Chaque campagne vérifie 32 PNG (30 comparaisons à deux références de zoom) et
les résultats publics complets de tous les échantillons. Pixels et requêtes sont
exacts avant/après et entre formats ; les derniers GeoJSON par phase sont archivés
et leurs signatures recalculées par `mlt-geometry-validate.mjs`. Le stockage
externe retenu après GC reste pratiquement identique : la suppression concerne
un tableau temporaire, pas les buffers conservés ni la mémoire GPU.

Ces délais sont des événements de soumission CPU du dessin, pas la fin d'exécution
ou la présentation GPU. L'installation initiale de la carte est exclue. Au natif,
les rechargements décodent de nouvelles tables ; en surzoom les URLs changent
mais le contenu du parent peut être réutilisé. Les premières observations avant
échauffement sont conservées séparément, sans leur attribuer un gain à froid.

Les 3 767 tests unitaires GL et les 759 tests de build passent sur cette variante.
Typecheck et lint ciblé passent aussi. L'intégration complète fait 178/178.
La suite GPU stricte fait 1 887/1 923, avec les mêmes 36 noms en échec que le lot
indexé. Les images des échecs sont conservées dans
`polygon-remap-checkpoint-20260908/gpu-failure-images.tar.gz`. L'identité des noms
en échec ne signifie pas que tous leurs pixels sont immuables entre passages.

Le lot suivant est le [clipping en flux](MLT_CLIPPING_STREAM_20260908.md), avec une
référence figée incluant ce remappage et ses propres mesures/validations.
