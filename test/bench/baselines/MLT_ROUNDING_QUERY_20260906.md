# Surzoom commun et profil des requêtes rendues — 6 septembre 2026

## Résultat

Le scénario navigateur MVT/MLT est maintenant **exactement conforme aux sept points
de contrôle**, y compris les deux surzooms : zéro différence de coordonnées GeoJSON,
d'attributs, d'état, de paint/layout et de pixels. Les images attendues et les
tolérances de rendu n'ont pas été modifiées ; sept références de requêtes GeoJSON
ont été actualisées après l'audit décrit ci-dessous. Ce résultat couvre ce scénario local,
pas tous les styles et toutes les plateformes.

La projection des résultats rendus MLT utilise désormais directement les tableaux
GeoJSON, sans objets `Point` intermédiaires. C'est une simplification vérifiée du
chemin public ; **aucun gain global de temps n'est établi** par cette campagne.
Les requêtes rendues conservent un surcoût géométrique en surzoom.

Ces modifications sont locales, après `cfb9f34ae` et les trois corrections du
[lot navigateur précédent](MLT_BROWSER_QUALIFICATION_20260906.md). Tile Spec reste
à `1ec5c6b1`, sans modification. Les résultats enregistrent le diff produit et les
SHA-256 des bundles, du banc et des tuiles ; ils ne décrivent pas le commit nu.

## Quantification

Le découpage MVT conservait des intersections décimales, utilisées par le rendu
worker, puis encodait leurs deltas avec un zigzag entier. La troncature de chaque
delta pouvait déplacer les coordonnées réencodées et les résultats publics.
MLT arrondissait déjà les coordonnées absolues finales.

`sliceVectorTileLayer` arrondit maintenant les points **après les deux axes de
découpage**, avant le rendu et le réencodage. La règle est `Math.round`, y compris
pour les demi-entiers négatifs. Les intersections restent calculées en flottant
jusqu'à cette dernière étape. Le clipper partagé n'est pas modifié.

Six nouveaux tests échouaient avant correction et passent après : lignes scindées,
intersections positives/négatives, demi-entiers, fermeture d'un polygone, puis
parité avant/après encodage MVT et avec le découpage MLT sur les quatre tuiles Berlin
à z+1 et z+2.

| Checkpoints navigateur | Avant ce lot, pixels différents | Après, pixels différents |
| --- | ---: | ---: |
| Initial, sélection, sélection rechargée, sélection effacée, source recréée | 0 chacun | 0 chacun |
| Surzoom 1 | 1 034 / 480 000 | 0 / 480 000 |
| Surzoom 2 | 112 / 480 000 | 0 / 480 000 |

Les hashes géométriques complets concordent aussi, pas seulement les captures.
Les deux campagnes de profil, avant puis après projection directe, terminent avec
`status: passed`, code 0, sans `--measure-with-differences`.

### Conséquence sur les références MVT existantes

Le premier passage d'intégration termine à **171/178** : sept fixtures de requêtes
MVT en surzoom sur `counties-7-37-48.mvt` conservent les anciennes réponses. Un
diagnostic séparé confirme les mêmes sept différences. Avant de modifier les
références, `mlt-query-reference-audit.ts` a reconstruit toutes les sous-tuiles z+1/z+2
du fichier original selon les deux politiques : découpage flottant puis deltas
tronqués (ancienne), et arrondi absolu final (nouvelle).

Les 16 géométries attendues correspondent à l'ancienne politique ; les 17 retournées
à la nouvelle. La vérification tolère uniquement le bruit de projection inférieur
à 1e-9 degré, sans modifier le comparateur des tests d'intégration. Les six cas à
effectif constant conservent IDs/attributs/état ; leurs coordonnées changent. Le cas
`line-width-features-in/tilt-inside` retourne aussi **Burlington County (id 33)** en
plus d'Ocean County (id 49) : le nouvel arrondi peut changer les intersections à la
limite d'une requête. Cette évolution observable de MVT est mentionnée au changelog.

Les sept `expected.json` sont actualisés pour ce contrat documenté, pas par une
hausse de tolérance. Les réponses avant/après et l'audit sont archivés ; les PNG de
rendu restent inchangés. Le filtre, le style et le rectangle de requête sont conservés.

## Profil et changement public

Le banc distingue trois phases : `queryRenderedFeatures()`, lecture des résultats
par `toJSON()`, puis `JSON.stringify()`. Chaque caméra fixe reçoit 10 chauffes,
50 mesures sans profiler, puis un lot séparé de 100 requêtes avec échantillonnage
CPU du thread principal à 1 ms. Trois paires alternées MVT/MLT sont enregistrées
pour chaque version. Les profils compressés et leurs self-times remappés aux sources
sont conservés ; leurs durées ne servent pas de mesures de performance.

Environnement identique au lot précédent : Chrome 152.0.7977.75, production 6.7.0,
Node 24.18.1, Iris Xe/ANGLE, viewport 800×600/DPR 1, un worker, réseau loopback fixe.
Les tests de validation ont été lancés après ces campagnes ; le poste reste une
machine de bureau non dédiée. Lint/typecheck ont chevauché le début de la première
campagne. Les chiffres avant/après montrent une dérive, notamment côté MVT témoin.

Les profils montrent deux coûts distincts :

- À la caméra initiale, lecture différée des propriétés et projection GeoJSON pèsent
  dans la matérialisation publique. `GeoJSONFeature` utilisait encore `Point[][]`,
  alors que l'adaptateur source possédait déjà une projection directe.
- Aux caméras en surzoom, les intersections relisent fréquemment les sommets via
  `ColumnarGeometryView.getVertexIndex` et le curseur de topologie. Cette partie
  reste inchangée dans ce lot. La projection directe ne peut pas supprimer ce coût.

Le getter de géométrie public réutilise maintenant `loadFeatureGeoJSONGeometry`.
La classification des anneaux conserve aussi les cas MVT vides/dégénérés : un seul
anneau dégénéré est conservé ; les anneaux de surface nulle sont ignorés quand il
y en a plusieurs. Les tests couvrent toutes les géométries des quatre tuiles en
ordre inverse, les trous, plusieurs anneaux externes, la lecture paresseuse et
l'indépendance des résultats modifiables. Ils vérifient zéro `Point`/`Point[][]`
intermédiaire ; les tableaux GeoJSON publics restent naturellement alloués.

## Mesures descriptives après projection directe

Plages des médianes des trois sessions, millisecondes **par requête** à caméra fixe.
Le total est la médiane de la somme par échantillon, pas la somme des médianes.

| Caméra / résultats | MVT total | MLT total | MVT `toJSON()` | MLT `toJSON()` |
| --- | ---: | ---: | ---: | ---: |
| Initiale / 3 959 | 34,55–35,30 | 34,45–34,80 | 3,10–3,20 | 7,80–7,90 |
| Surzoom 1 / 2 421 | 20,60–21,00 | 24,10–24,30 | 1,80–1,90 | 4,50–4,60 |
| Surzoom 2 / 1 135 | 10,70–11,00 | 13,30–13,70 | 1,00 | 2,10 |

Ces lots fixes ne reproduisent pas le coût complet du cycle animé/rechargé du
rapport précédent. Ils ne remplacent donc pas son résultat de +23–28 % pour les
requêtes rendues du parcours. Ils localisent le surcoût, sans établir un gain
avant/après fiable : par exemple, le témoin MVT initial passe de 29,30–31,60 ms à
34,55–35,30 ms entre les deux campagnes. Il serait trompeur de traiter cette dérive
comme un effet de l'optimisation MLT.

Archives reproductibles :

- [Surzoom corrigé, avant projection directe](browser-rounded-before-query-20260906/results.json).
- [Après projection directe](browser-rounded-direct-query-20260906/results.json).
- [Comparaison calculée et contrôlée](browser-rounded-direct-query-20260906/query-comparison.json) :
  mêmes hashes de banc/tuiles, checkpoints identiques avant/après, trois paires et
  mêmes nombres de résultats. Les profils bruts se trouvent dans ces deux dossiers.

## Validation et suite

- **3 726/3 726 unitaires**, passage complet confirmé code 0 ; deux attentes anciennes
  d'allocations publiques ont été adaptées à l'absence d'intermédiaires `Point`.
- **750/750 tests de build**, sans relever la référence de taille ni les quotas dans
  ce lot ; typecheck, lint ciblé et builds dev/prod/worker strict réussis.
- **243/243 fixtures MLT strictes en logiciel**, tous les compteurs interdits à zéro.
- **1 887/1 923 rendus GPU** sur Iris Xe, code 1 : exactement les 36 mêmes fixtures en
  échec que dans `MLT_EXTENSION_20260906.json`, aucune nouvelle. Les compteurs worker
  stricts restent tous à zéro (817 couches, 3 273 colonnes, 2 535 723 valeurs,
  29 377 563 octets de colonnes ; 156 796 506 octets cumulés de copies brutes).
- **178/178 tests d'intégration** après actualisation des sept références, code 0.
  Le test Marker/terrain anciennement instable passe ici ; ce lot ne prétend pas
  corriger son instabilité historique.

Le premier passage unitaire relevait uniquement l'ancienne attente d'allocation
d'un test public ; la première confirmation avait déjà chargé sa deuxième attente
avant correction. Les rapports non conformes sont conservés avec la confirmation.
Le GPU complet puis le logiciel/intégration ont chevauché les tests unitaires, pas
les campagnes de profil navigateur.
Les [rapports bruts et la synthèse de validation](browser-rounded-direct-query-20260906/validation.json)
archivent également les passages non conformes, les métadonnées GPU, les compteurs
et les sept réponses de requêtes avant/après. La mémoire 300 cycles et le parcours
animé de 30 cycles du lot précédent n'ont pas été rejoués sur ce snapshot.

La prochaine optimisation à isoler est la lecture des sommets pour les intersections
des requêtes rendues : éviter les résolutions répétées de plage/topologie sans
recréer de géométrie par feature. Elle devra être mesurée par versions alternées dans
une même campagne, avec parité publique complète et compteurs worker stricts.
Symboles/glyphes, globe/terrain dans le scénario de cycle de vie, transferts worker→main
et mémoire GPU restent hors de la qualification présente.

```bash
npm run build-prod
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-lifecycle.ts --phase profile --runs 3 --output <nouveau-dossier>
node test/bench/e2e/mlt-query-compare.mjs <avant> <apres>
```
