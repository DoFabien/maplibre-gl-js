# Recontrôle du surzoom chaud prétriangulé — 13 septembre 2026

Une petite surcharge réelle a été identifiée et supprimée : le prototype teste
inutilement l'accès au maillage pour chaque feature des tables découpées. Son
coût CPU échantillonné est de l'ordre de **0,1 à 0,2 ms par rechargement** dans
ces profils. Cela ne suffit pas à expliquer les **3,475 ms / +7,1 %** du
[résultat historique](MLT_PRETRIANGULATED_FILL_20260908.md).

Le nouveau diagnostic ne retrouve pas systématiquement ce ralentissement, mais
ne démontre pas non plus un gain global après correction. La répétition exacte
de l'ancien protocole a échoué avant son terme : la cause du résultat historique
reste donc **indéterminée**. FastPFOR est hors de ce travail et reste destiné à
une future PR ; ni TileSpec ni les octets des fixtures ne changent.

## Ce que mesure le diagnostic

Le résultat du 8 septembre comparait quatre rotations avant/après × MVT/MLT :
49,225 → 52,700 ms en surzoom MLT, avec des différences par paire de +2,900,
−1,550, +2,900 et +4,600 ms. Chaque observation rechange les URL des tuiles à
caméra fixe ; le contenu parent identique peut être retrouvé dans le cache MLT.
« Chaud » désigne donc ici ce cache pendant des **rechargements forcés**.
Cela ne mesure ni les FPS, ni une navigation habituelle utilisant les tuiles
déjà dessinées, ni la présentation GPU.

L'ancien harness exécute des requêtes GeoJSON complètes puis les sérialise vers
Node et recalcule leurs signatures entre les observations, après l'arrêt du
chronomètre. Leur influence éventuelle sur l'état mémoire et l'ordonnancement
du rechargement suivant n'est pas mesurée séparément. Ce n'est pas une cause
démontrée des +7,1 %.

Le nouveau `mlt-overzoom-diagnostic.ts` garde les mêmes fixtures Berlin et le
scénario `base`, avec une fenêtre 800 × 600, DPR 1, un worker, 26 rechargements
natifs préalables, la première visite en surzoom puis 10 échauffements. Il
alterne avant/après et après/avant, dans une page neuve à chaque session.
Les requêtes complètes et captures n'ont lieu qu'après les observations.
Les sessions de chronométrage ne comportent aucun profilage CPU.

Il distingue l'arrivée du dernier événement `sourcedata` portant une coordonnée
de tuile et le premier dessin pour lequel la carte et la source sont chargées.
Le simple événement `sourceDataType: content` signifie ici le changement de
source, pas la fin du travail des tuiles. Les observations validées contiennent
chacune sept événements de tuile. L'intervalle entre données et dessin inclut
l'attente de frame, le travail main et la soumission du dessin ; ce n'est pas
un temps GPU isolé. Les médianes de ces composantes ne s'additionnent pas.

## Référence historique, prototype et témoin A/A

Les valeurs ci-dessous sont les médianes des médianes de session. Toutes les
observations sont conservées, y compris les sessions lentes.

| Campagne sans profileur | Paires × observations par version | Avant | Après | Écart |
| --- | ---: | ---: | ---: | ---: |
| Référence avant prétriangulation → prototype | 6 × 40 | 81,525 ms | 81,800 ms | +0,34 % |
| Témoin A/A, même référence binaire des deux côtés | 6 × 40 | 81,450 ms | 81,700 ms | +0,31 % |
| Prototype → correction, première série | 4 × 40 | 81,600 ms | 90,675 ms | +11,12 % |
| Prototype → correction, répétition plus longue | 8 × 40 | 81,500 ms | 82,050 ms | +0,67 % |

Dans la comparaison référence/prototype, le dernier événement de tuile passe
de 72,525 à 76,750 ms (+5,83 %). Le témoin utilisant **exactement les mêmes
bundles** des deux côtés passe lui aussi de 71,725 à 74,850 ms (+4,36 %).
La dernière paire de ce témoin présente même +14,500 ms au dessin. Il existe
donc une variabilité importante sans modification du produit. On ne soustrait
pas l'écart A/A de l'écart A/B pour fabriquer une correction causale.

La première série après correction est défavorable (+11,12 %) et reste dans
le bilan. La répétition plus longue ramène l'écart agrégé à +0,67 %, mais
comporte encore des paires à +15,450 et −12,000 ms. Ces mesures n'établissent
ni une accélération globale, ni l'absence de toute régression. Elles ne sont
pas directement comparables aux 49–53 ms de l'ancien protocole, dont les
intervalles entre rechargements diffèrent.

## Surcharge trouvée dans le worker et correction

Après découpage en surzoom, `applyFeatureTableSlice` fournit une géométrie
plate, sans le `GpuVector` contenant les triangles du parent. Le bucket peut
néanmoins avoir `overscaling === 1` pour la tuile enfant canonique : ce test
seul ne suffit pas à exclure le maillage. L'ancien calcul d'éligibilité laisse
alors appeler `appendPretriangulatedFill` pour chaque feature. La fonction
constate immédiatement l'absence de `GpuVector` et revient au chemin numérique.

La correction ajoute `featureTable.geometryVector instanceof GpuVector` au
calcul d'éligibilité **avant la boucle**. Les tables découpées sont exclues
une seule fois ; leurs coordonnées et leur triangulation ne changent pas.
Les tables natives maillées conservent leur chemin direct et ses validations.

Deux campagnes CPU distinctes utilisent les bundles production et leurs
sourcemaps exactes, avec deux paires de 80 rechargements et un intervalle
d'échantillonnage de 250 µs. Le temps exclusif échantillonné dans
`pretriangulated_fill.ts`, rapporté à un rechargement, est :

| Comparaison | Avant, par session | Après, par session |
| --- | ---: | ---: |
| Référence historique → prototype | 0 / 0 ms | 0,215 / 0,214 ms |
| Prototype → correction | 0,165 / 0,112 ms | 0 / 0 ms |

L'absence d'échantillons après correction concorde avec la suppression de ces
appels dans le code. Ce sont des estimations de travail CPU, pas une économie
exacte sur la latence totale. La découpe, les buffers, Earcut et la subdivision
restent présents. Les temps de rechargement collectés sous profileur sont
conservés dans les données brutes mais exclus du tableau de performance.

## Vérifications et limites

- **29 tests passent**, dans les quatre fichiers ciblant le remplissage
  prétriangulé, le bucket colonnaire, le worker MLT direct et `MltTileData`.
  Typecheck et lint du bucket passent ; le build production corrigé passe.
- Le rebuild témoin, avec le fichier du bucket avant correction, reproduit
  exactement les trois modules production du prototype. Le candidat corrigé
  n'ajoute que **32 octets bruts / 7 gzip** au module partagé, par une insertion
  unique ; les modules main et worker sont identiques. Les empreintes sont
  dans [build-proof.json](overzoom-recheck-checks-20260913/build-proof.json).
- Le vérificateur indépendant recalcule **2 560 observations** dans six
  campagnes, dont 1 920 sans profileur et 640 sous profileur, les coûts CPU à
  partir des profils bruts et sourcemaps, ainsi que les signatures et pixels.
  Les **56 images et 56 archives de requêtes** correspondent exactement entre
  toutes les sessions : 4 872 résultats source et 2 421 résultats rendus.
  Parmi ces captures, **14 concernent le candidat corrigé**. Cela couvre ce
  scénario de surzoom, pas l'ensemble des configurations GPU.
- La suite GPU complète n'est pas rejouée. Aucune image de référence ou
  tolérance n'est modifiée. Les résultats historiques des autres suites ne
  sont pas comptés comme nouveaux tests de cette correction.
- La répétition exacte du harness historique s'arrête après **6 sessions
  complètes sur 16** sur `Target.closeTarget: No target with given id found`.
  Elle ne constitue pas une campagne terminée. Le pilote GPU headless échoue
  à initialiser WebGL2 ; les six campagnes retenues utilisent le GPU dans
  une fenêtre visible. Un autre pilote précède la correction de l'instrumentation
  des événements de tuile et reste également exclu.

Hôte : Intel i7-1260P / Iris Xe, ANGLE Mesa, Chrome 152.0.7977.75,
Node 24.18.1, noyau Linux 7.0.0-31-generic (−30 dans l'environnement historique).
Les chronométrages ont été exécutés séparément des builds et tests, dans la
session graphique active. L'origine précise des sessions lentes n'est pas
établie ; aucune attribution au GC, au GPU ou à une autre application n'est
justifiée par ces mesures.

## Preuves et reproduction

La [synthèse vérifiée](overzoom-recheck-final-20260913.json) conserve les valeurs
par session, les différences appariées et les empreintes de tous les fichiers
relus. Les logs ciblés, y compris les tentatives échouées, sont dans
`overzoom-recheck-checks-20260913/`. Les bundles, captures et profils volumineux
restent locaux dans les six répertoires indiqués par cette synthèse.

Après le rangement du dépôt le 13 septembre, ces fichiers bruts sont conservés
sous `../wFabien/bench-artifacts-20260913/maplibre-gl-js/`, avec leur arborescence
d'origine et un manifeste SHA-256. Il faut restaurer les fichiers nécessaires
aux chemins enregistrés avant de relancer le vérificateur ; voir les
[consignes de rangement](../README.md#local-benchmark-artifacts).

La référence avant prétriangulation vient de `4ac9eb198`, restaurée depuis
`owned-indices-checkpoint-20260908/workspace.tar.gz` dans
`/tmp/mlt-overzoom-reference-20260913-80skvu9j/maplibre-gl-js/dist`.
Ses empreintes, celles du prototype dans `dist/` et celles des trois fichiers
du harness historique correspondent à la campagne du 8 septembre.
Le prototype source est celui de `bdbe31b2e` ; TileSpec reste à `ddf2840008`.
Le candidat corrigé a été construit séparément dans
`overzoom-hoist-build-20260913/` pour préserver le prototype exécutable.

```bash
BUILD=production npx rolldown -c rolldown.config.ts --dir <nouveaux-bundles>
cp dist/maplibre-gl.css <nouveaux-bundles>/maplibre-gl.css
```

Le contrôle de reproductibilité utilise le même build avec un hook `load` qui
fournit seulement le fichier `columnar_fill_bucket.ts` de `bdbe31b2e` ; sa
configuration et sa copie source restent dans
`overzoom-hoist-control-build-20260913/` avec les sorties correspondantes.

Depuis la racine GL JS, en conservant les trois modules, leurs sourcemaps et
`maplibre-gl.css` dans chaque répertoire de bundles :

```bash
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-overzoom-diagnostic.ts --mode timing \
  --reference <bundles-avant> --candidate <bundles-apres> \
  --runs 6 --samples 40 --native 26 --warmup 10 --output <nouveau-repertoire>
```

Pour le témoin A/A, utiliser le même répertoire pour les deux arguments.
Pour le profil CPU séparé, passer `--mode profile --runs 2 --samples 80`.
Pour répéter la dernière série chronométrée, passer `--runs 8 --samples 40`.
Ne pas lancer de builds ou tests pendant ces mesures.

```bash
node test/bench/e2e/mlt-overzoom-verify.mjs <nouvelle-synthese.json> \
  test/bench/baselines/overzoom-diagnostic-timing-20260913 \
  test/bench/baselines/overzoom-diagnostic-control-20260913 \
  test/bench/baselines/overzoom-diagnostic-profile-20260913 \
  test/bench/baselines/overzoom-hoist-profile-20260913 \
  test/bench/baselines/overzoom-hoist-timing-20260913 \
  test/bench/baselines/overzoom-hoist-timing-repeat-20260913
```

La vérification exige les artefacts bruts et bundles inchangés aux chemins
enregistrés. Pour une qualification du résultat historique, il reste à terminer
une répétition de son protocole exact dans un environnement suffisamment stable.
