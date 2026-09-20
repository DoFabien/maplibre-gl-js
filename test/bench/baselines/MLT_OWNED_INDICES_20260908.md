# MLT → rendu : indices de triangles en place — 8 septembre 2026

La variante limitée aux indices est retenue : un tableau intermédiaire en moins,
environ −3,4 % d'allocations worker estimées sur le corpus, sans accélération
significative du dessin établie. La qualification ciblée conserve les échecs GPU
préexistants décrits ci-dessous, sans échec supplémentaire sur ce périmètre.
Le prototype coordonnées + indices plus coûteux au natif n'est pas intégré.

## Référence et profil

La référence est le checkpoint clipping en flux :
`clipping-stream-checkpoint-20260908/workspace.tar.gz`, SHA-256
`4e3822b4936b830afed0e24dcb1b3aced028c3fe5a43a665c98229d7ed933cc2`.
Ses empreintes de sources ont été vérifiées avant modification. Il est extrait
dans `/tmp/mlt-owned-before-MpH1MP` pour les comparaisons.

Le nouveau profil production `browser-post-clipping-render-profile-20260908`
utilise deux sessions par format, cinq rechargements natifs, un premier surzoom
puis cinq rechargements à chaud, avec symboles. Pixels et signatures publiques
sont exacts aux trois phases. Les bundles et sourcemaps correspondent à la
référence figée, **pas** aux bundles modifiés ensuite dans `dist/`.

Sur les cinq rechargements natifs MLT, les échantillons CPU inclusifs attribuent
75,55/86,71 ms à `populatePolygon`, dont 25,07/34,44 ms à la subdivision aplatie.
Le clipper du premier surzoom prend 9,21/13,10 ms échantillonnées. Ces coûts
inclusifs se recouvrent : ils ne s'additionnent pas. Le profileur ne mesure ni
une accélération avant/après, ni l'exécution GPU.

## Prototype coordonnées + indices écarté

Un premier essai transfère la propriété du tableau de coordonnées à la
subdivision : earcut lit d'abord sa disposition initiale, puis les sommets sont
compactés dans ce même tableau. Les bornes des requêtes sont calculées pendant
l'aplatissement, avant ajout des sommets de pôles. Une seconde version fusionne
aussi le remappage et la correction d'orientation dans les indices d'earcut.

Ces essais passent leurs tests ciblés et les hashes worker de positions,
triangles et requêtes. Le premier essai ne donne pas de gain worker : ratios
appariés médians MLT 1,027/1,023/1,030 ; témoins MVT 1,030/1,021/1,006.
La seconde version donne 1,019/1,015/1,009 ; témoins MVT 1,032/1,024/1,031.
Il n'y a pas de gain absolu worker établi dans ces campagnes.

La seconde version passe 3 774 tests unitaires, mais 758/759 tests de build :
le contrôle de taille signale +733 octets bruts et +282 gzip par rapport au
clipping. Les références de taille n'ont pas été mises à jour pour ce prototype.

La campagne navigateur `browser-owned-mesh-production-20260908` comprend quatre
rotations avant/après × MVT/MLT, vingt observations après cinq échauffements par
phase et session. Les 32 PNG et archives complètes de requêtes sont exacts.

| Médiane des médianes de session, action → dessin chargé | Avant | Prototype |
| --- | ---: | ---: |
| MLT natif | 60,850 ms | 63,275 ms |
| MVT témoin natif | 70,300 ms | 67,825 ms |
| MLT surzoom chaud | 53,825 ms | 53,025 ms |
| MVT témoin surzoom chaud | 83,250 ms | 81,175 ms |

Le natif MLT est plus lent dans chacune des quatre rotations ; le résultat
agrégé est environ +4 %. Ce n'est pas un gain global malgré les copies retirées.
Le profil d'allocations distinct `browser-owned-mesh-allocations-20260908` estime
264,87 → 252,83 Mio alloués dans le worker sur dix rechargements natifs, soit
environ −4,5 % ; témoin MVT 387,40 → 386,31 Mio. La mémoire conservée reste proche
dans le banc sans profileur. Ce compromis n'est pas intégré tel quel.

Les modifications des coordonnées et des bornes ont été retirées avec
vérification d'identité à la référence avant de tester la variante suivante.
Le prototype complet est conservé dans
`owned-mesh-prototype-v2-20260908/workspace.tar.gz`, SHA-256
`1ba664493134751cf45c1f3a7b33c126affce3e82eb72e608f5d45bebdd8ff46`.
Ses modules exécutables et rapports worker v1/v2 restent dans leurs répertoires.

## Variante limitée aux indices

Seul `subdivideFlattenedPolygonInternal` change : lorsque la granularité est
inférieure à deux, il remappe et oriente chaque triangle dans le tableau déjà
produit par earcut. Il évite une passe séparée et le tableau de correction
d'orientation. Les coordonnées restent empruntées et intactes ; le dictionnaire
de sommets, les bornes, contours, pôles et subdivisions fines sont conservés.

Cette branche est utilisée par les remplissages MLT et les toits d'extrusions.
Le chemin MVT, les APIs publiques et la fonction publique `fixWindingOrder`
ne changent pas. L'aplatissement des coordonnées, les tableaux finaux des buckets
et leur transfert vers le rendu restent présents : ce n'est pas zéro allocation.

Trois nouveaux tests paramétrés comparent les APIs MVT et aplatie, avec entrées
gelées, orientations d'anneaux différentes, trous, doublons arrondis et pôles,
aux granularités 0/1/8 et sur deux tuiles canoniques. Les 59 tests ciblés,
3 773 tests unitaires et 178 tests d'intégration passent. Builds production/dev
et stricts production/dev, typecheck et lint ciblé passent.

Les trois campagnes worker natif de cette variante conservent les positions,
indices de triangles et 1 978 réponses publiques exacts. Ratios appariés médians
MLT 0,991/1,008/0,977 ; témoins MVT 0,991/1,012/1,000. Ils ne démontrent pas
d'accélération régulière. Chaque campagne utilise dix échauffements et trente
observations par variante, en ordre tournant, sans autre test/build/navigateur.

`browser-owned-indices-production-20260908` utilise le même protocole que le
prototype : quatre rotations, vingt observations et cinq échauffements par
phase/session. Le vérificateur recalcule les 32 PNG exacts, les 32 archives de
requêtes complètes, les timings et les empreintes des trois rapports worker.

| Médiane des médianes de session, action → dessin chargé | Avant | Indices seuls |
| --- | ---: | ---: |
| MLT natif | 60,925 ms | 60,700 ms |
| MVT témoin natif | 67,525 ms | 67,075 ms |
| MLT surzoom chaud | 52,700 ms | 51,575 ms |
| MVT témoin surzoom chaud | 83,950 ms | 84,050 ms |

Ces petits écarts et les variations de session ne démontrent pas une accélération
régulière. Les requêtes natives MLT passent de 55,825 à 56,375 ms, celles du
surzoom de 26,950 à 26,800 ms ; pas de gain de requête revendiqué. La mémoire
conservée reste proche. Le délai s'arrête à la soumission CPU du dessin chargé,
pas à la fin GPU ni à la présentation. Il ne mesure ni les FPS ni le chargement
initial de la carte. Les premiers surzooms ne sont pas agrégés aux mesures chaudes.

La campagne séparée `browser-owned-indices-allocations-20260908` donne :

| Allocations estimées, médiane de quatre sessions de dix rechargements | Avant | Indices seuls |
| --- | ---: | ---: |
| Worker MLT | 267,25 Mio | 258,29 Mio |
| Worker MVT témoin | 385,05 Mio | 385,90 Mio |
| Main MLT | 20,55 Mio | 21,05 Mio |
| Main MVT témoin | 20,11 Mio | 19,72 Mio |

La baisse worker MLT est observée dans les quatre rotations. Le résultat
agrégé est environ −3,4 %, sans conclusion de réduction de mémoire maximale
ou conservée. Les seize captures et archives de requêtes sont exactes ; les
profils bruts et leurs résumés sont vérifiés par le banc.

Le module partagé augmente de 298 octets bruts et 112 gzip face au clipping.
Le premier contrôle de build fait 758/759, uniquement sur la référence de taille.
`bundle_size.json` est ensuite actualisé aux tailles réellement mesurées
(651 897 bruts, 175 022 gzip) : le rejeu isolé passe à **759/759**.
Les quotas et le test de taille ne sont pas assouplis ; l'échec initial est conservé.

## Qualification visuelle

Le GPU strict ciblé fait **236/243**, avec exactement les sept noms MLT déjà en
échec dans le GPU complet du checkpoint clipping. Les sept images produites sont
identiques pixel par pixel à cette référence, contrôles MVT compris. Elles sont
archivées avant le passage logiciel dans
`owned-indices-checkpoint-20260908/gpu-failure-images.tar.gz` ; la comparaison est
dans `gpu-comparison.json`. Aucune image attendue ni tolérance n'est modifiée.
Les 1 680 autres fixtures GPU ne sont pas sélectionnées dans ce lot : ce n'est
pas un nouveau passage de la suite GPU complète de 1 923 tests.
Le rendu strict logiciel passe à **243/243**. Les compteurs interdits sont
contrôlés dans les deux configurations ; le décodeur MLT est effectivement exercé.

Globe/terrain strict GPU et logiciel : **23 paires exactes par configuration**,
plus 27 étapes répétées par encodage/configuration. L'audit recalcule les pixels
des 46 paires et les signatures des 92 archives complètes de requêtes, puis
vérifie les états répétés et les onze compteurs interdits/proxy.
Styles à chaud strict GPU : **25 paires exactes**, trois cycles, sources,
ressources et feature-state compris ; les images et compteurs sont revérifiés.
Le banc styles conserve les signatures/états publics, pas les GeoJSON complets
de chaque checkpoint. Les résultats historiques d'animations/arrivées ne sont
pas réattribués à ces nouveaux bundles.

Le [checkpoint](owned-indices-checkpoint-20260908/checkpoint.json) répertorie les
empreintes, validations et archives. Son delta produit face au clipping est
limité à `src/render/subdivision.ts`, accompagné de ses tests ; TileSpec et le
bucket fill sont identiques à la référence. `workspace.tar.gz` fige les sources
et bundles, `validation-artifacts.tar.gz` les rapports/logs, et
`benchmark-evidence.tar.gz` les campagnes, modules et bancs associés.

## Méthode d'allocation

`mlt-allocation-profile.ts` est un nouveau banc réutilisable. Il échantillonne
les allocations V8 main/worker sur dix rechargements natifs après cinq
échauffements, avec quatre rotations équilibrées et un worker par carte.
L'intervalle de Poisson vaut 16 Kio ; les objets déjà récupérés par les GC
mineurs et majeurs sont inclus. Ce sont des **estimations**, pas des octets
exacts, une mémoire retenue/maximale, une durée de GC ou une mémoire GPU.

Les profils bruts compressés, sourcemaps, hashes d'entrées, images et requêtes
complètes sont conservés. `--verify` recalcule les résumés et comparaisons.
Les requêtes et captures sont hors profil ; aucun gain de temps n'est déduit
de cette instrumentation. Les mesures de latence utilisent un banc séparé.

Les rapports enregistrent les chemins des sources/bundles réellement utilisés.
Après changement du produit, un ancien rapport doit être vérifié contre son
snapshot correspondant, et non les nouvelles sources du workspace.

## Suite ciblée

Le prochain essai doit viser l'écriture par blocs dans les buffers finaux des
remplissages : le chemin actuel réserve déjà la capacité, mais appelle encore
un ajout de sommet pour chaque paire de coordonnées. Comparer cette écriture
aux appels élémentaires, en préservant les contours, les décalages d'indices et
la segmentation des maillages de plus de 65 535 sommets. Le chemin général doit
rester disponible pour ces grands maillages. Le succès se juge sur rendu/requêtes,
allocations et délai complet, pas seulement sur une boucle plus courte.

Restent aussi `distance`, les six anciens tests de filtres hors configuration
unitaire et les écarts GPU connus. Ce lot ne les résout pas et ne certifie pas
tous les styles, plateformes ou comportements animés. Aucun commit/push n'est fait.
