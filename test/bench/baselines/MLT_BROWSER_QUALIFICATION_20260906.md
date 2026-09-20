# Qualification navigateur MVT/MLT — 6 septembre 2026

## Résultat et périmètre

Le scénario navigateur a découvert et permis de corriger **trois défauts de requêtes
MLT**. Il ne certifie pas une parité complète : des différences de géométrie découpée
et de pixels subsistent en surzoom. Aucun golden ni quota de performance n'a été relevé
pour transformer ces différences en succès.

Les mesures de campagne sont conservées dans
[`browser-cfb9f34ae-20260906/results.json`](browser-cfb9f34ae-20260906/results.json).
La synthèse calculée est dans [`analysis.json`](browser-cfb9f34ae-20260906/analysis.json).
Les résultats décrivent **`cfb9f34ae` + corrections locales**, et non le commit nu :
le diff produit et les SHA-256 des bundles, du banc et des huit fichiers de tuiles
sont enregistrés. Tile Spec reste à `1ec5c6b1`, sans modification dans ce lot.

Le banc utilise Chrome 152.0.7977.75 et le build production 6.7.0, lancé par Node
24.18.1, sur Iris Xe :
`ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2), OpenGL ES 3.2)`.
Une page de 800×600 pixels, DPR 1, un worker ; serveur loopback, cache et compression
HTTP désactivés, sources exclusivement locales. Ce poste n'est pas une machine dédiée.

## Défauts corrigés

1. **Indices de couches après transfert.** Le worker projette les seules couches du
   style ; le thread principal reconstruisait leur dictionnaire depuis toutes les
   couches du fichier brut. Une requête réelle échouait avec
   `Geometry feature 1257 is out of range`. L'ordre des couches indexées accompagne
   désormais le `FeatureIndex`. La régression teste un parse projeté, sa sérialisation,
   puis une vraie intersection contre la tuile brute multicouche.
2. **Attributs perdus en surzoom.** Le découpage copiait seulement les colonnes déjà
   décodées pour le style, puis encodait une tuile incomplète pour les requêtes
   publiques. Les colonnes sont maintenant résolues avant découpage. Il s'agit de
   vecteurs columnar, pas de dictionnaires par feature. Un test `loadTile` avec faux
   serveur vérifie une propriété non stylée sur chargement froid et hit de cache,
   avec compteurs stricts actifs.
3. **Valeurs paint/layout incorrectes dans les résultats rendus.** Une vue réutilisable
   de propriétés créée avant décodage différé conservait des bindings incomplets.
   Par exemple, une route `class=main` retournait `line-width=2` au lieu de 4, même si
   son image était correcte. La vue résout maintenant la colonne demandée à la
   première lecture, tout en respectant une projection explicitement restreinte.
   Le test couvre lecture différée, ajout ultérieur de colonne et changement d'indice.

Les tests correspondants échouaient avant leur correction. Ils complètent les
contrôles navigateur ; les résultats publics demandés peuvent naturellement
matérialiser du GeoJSON, indépendamment du contrat sans objets de compatibilité
dans le chemin worker.

## Parcours et contrôles

Les quatre tuiles Berlin `14-8802/8803-5374/5375` alimentent six couches : landuse,
water, buildings, roads, density, pois (fill, line, heatmap, circle). `promoteId`
utilise `osm_id`, commun aux deux encodages. Ce scénario n'inclut pas symboles,
glyphes, terrain, globe, réseau distant ou manipulation de la souris.

Chaque cycle parcourt trois caméras, dont deux en surzoom avec pitch/bearing, puis
lit et sérialise les requêtes source et rendues, active une sélection, recharge via
`setTiles`, retire les couches/source et les réajoute. Un cycle compte 20 507 résultats
source et 7 515 résultats rendus, avec doublons de tuiles légitimes ; ce ne sont pas
28 022 objets géographiques distincts.

Sept points de contrôle archivent l'image et les réponses GeoJSON complètes gzip.
La comparaison canonique ignore l'ordre des features et des clés, mais conserve IDs,
propriétés, type de géométrie, état, métadonnées de tuile et paint/layout évalués.
La sélection doit changer l'image et survivre au rechargement ; le retrait/réajout
doit remettre l'état à zéro.

| Point de contrôle | Résultats source / rendus | Pixels différents / 480 000 |
| --- | ---: | ---: |
| Initial, sélection, sélection rechargée, sélection effacée, source recréée | 11 034 / 3 959 chacun | 0 chacun |
| Surzoom 1 | 4 872 / 2 421 | 1 034 (0,2154 %) |
| Surzoom 2 | 4 601 / 1 135 | 112 (0,0233 %) |

Les attributs, identifiants, états, types, comptes et valeurs de style concordent
aux sept points. La géométrie complète concorde aux cinq premiers, pas aux deux
surzooms : 256 puis 188 géométries source diffèrent. Leurs groupes d'attributs sont
uniques, leurs structures de coordonnées identiques ; l'écart maximum vaut environ
2 puis 4 unités de tuile (extent 4096), sur ce corpus seulement.

Le chemin MLT arrondit les coordonnées découpées ; le réencodage MVT applique son
zigzag entier aux deltas flottants. Cette différence de quantification est visible
dans le code et les réponses archivées. Les doublons des requêtes rendues ne portent
pas tous leur tuile : l'analyse annule les géométries exactement égales, puis signale
les appariements ambigus sans inventer de correspondance de sommets.
**Aligner le contrat de quantification du surzoom reste un travail distinct**, pas une
tolérance désormais acceptée. Les métriques qui suivent portent donc sur des
parcours équivalents, mais pas des géométries de sortie bit à bit identiques.

## Mesures et limites

Trois paires MVT/MLT alternées ; 30 cycles mesurés par session après un cycle animé
de chauffe. Les échantillons bruts et médianes/p95 R7 sont conservés. Les ratios
comparent les médianes de sessions appariées, pas des p95 de ratios individuels.
Les requêtes totalisent trois groupes par cycle (neuf appels source et trois rendus) ;
les temps incluent la lecture de géométrie/propriétés et la sérialisation JSON.

| Mesure, médianes des trois sessions | MVT | MLT | Ratio MLT/MVT des trois paires |
| --- | ---: | ---: | --- |
| Requêtes source + JSON, ms/cycle | 78,05–78,35 | 66,00–67,45 | 0,862 / 0,844 / 0,846 |
| Requêtes rendues + JSON, ms/cycle | 53,50–54,60 | 66,90–69,95 | 1,282 / 1,232 / 1,281 |
| Rechargement jusqu'à idle, ms/cycle | 59,45–59,85 | 62,45–63,05 | 1,056 / 1,050 / 1,051 |
| Retrait/réajout jusqu'à idle, ms/cycle | 100,10–100,20 | 100,05–100,10 | 0,999 / 1,000 / 1,000 |

Sur ce parcours, la sérialisation source MLT est donc **14–16 % plus rapide**, mais
les requêtes rendues sont **23–28 % plus lentes**. Le rechargement médian est environ
5 % plus lent ; son p95 est néanmoins inférieur (65,18–66,47 ms MLT contre
75,02–77,54 ms MVT). Ce n'est pas un gain global uniforme.

Le p95 des intervalles RAF vaut **16,7–16,8 ms dans les deux formats**. Sur 4 854
intervalles MVT et 4 859 MLT, aucun ne dépasse 50 ms ; un intervalle MLT dépasse
33,34 ms, aucun en MVT. Ce parcours atteint essentiellement le plafond d'environ
60 Hz de cette session : cela ne départage pas la marge disponible sous un style
plus lourd. Les chronométrages ont précédé la répétition unitaire de confirmation.

Les intervalles RAF couvrent les animations, pas le temps GPU ni la présentation
effective de chaque frame. Le comptage des long tasks est observé autour de ces
fenêtres et peut inclure une tâche traversant la frontière avec une requête ; il
ne mesure donc pas exclusivement le coût de rendu.

Les sessions mémoire sont distinctes des sessions chronométrées : cinq cycles de
chauffe, puis 100 cycles sans animation, avec GC CDP et contrôle des mêmes résultats
tous les dix cycles. Les relevés séparent tas principal, tas worker et backing
storage ; ils ne couvrent ni RSS de Chrome ni mémoire GPU. Les contrôles chargés
ont tous exercé les requêtes publiques avant le relevé.

À 100 cycles, les trois sessions concordent : backing storage worker de **64,218 Mo
MVT / 48,419 Mo MLT**, encore en augmentation. La moindre valeur MLT à ce stade
ne constitue pas un gain mémoire stabilisé : les URL de rechargement uniques
remplissent le cache LRU de surzoom, borné à 64 Mio de tuiles encodées par instance.

Une [extension de 300 cycles par format](browser-cfb9f34ae-20260906-memory300/results.json)
confirme le plateau des buffers. Les deux chronométrages à un seul échantillon de
cette extension sont ignorés : elle ne sert qu'au diagnostic mémoire.

| Mesure après GC, au cycle 300 (Mo décimaux) | MVT | MLT |
| --- | ---: | ---: |
| Tas JavaScript principal | 8,379 | 8,911 |
| Tas JavaScript worker | 4,433 | 5,370 |
| Backing storage principal | 4,236 | 5,308 |
| Backing storage worker, carte chargée | 69,362 | 69,891 |
| Backing storage worker, source retirée | 67,786 | 67,751 |
| Backing storage worker, carte retirée | 0,710 | 0,710 |

Les cinq derniers contrôles du backing storage worker sont compris entre
69,362–69,395 Mo MVT et 69,891–69,954 Mo MLT. Ce relevé inclut d'autres buffers
que les 64 Mio du cache. Le tas JS garde une dérive modeste entre les cycles 150 et
300 : +194 ko principal / +26 ko worker MVT, +242 ko / +92 ko MLT. On confirme un
cache de buffers borné et libérable, **pas une absence générale de fuite** ni un
plateau parfait du tas JS. MLT n'est pas moins coûteux sur tous ces postes mémoire.

Le worker partagé reste vivant après `map.remove()` : le dispatcher global, initialisé
notamment par le gestionnaire RTL, conserve son acquisition du pool. Ce mécanisme
existe aussi dans l'upstream intégré. On mesure donc la mémoire résiduelle avant de
fermer la page ; la présence du worker ne démontre pas à elle seule une fuite MLT.

Les fichiers d'entrée pèsent **1 481 872 octets MVT / 1 055 493 octets MLT**, soit
−28,8 % pour les corps HTTP non compressés. Ce n'est pas une comparaison gzip/Brotli,
ni un volume worker→main. Les requêtes intermédiaires et annulées pendant l'animation
peuvent faire varier le nombre de réponses ; leurs volumes cumulés sont conservés
séparément et ne représentent ni un pic ni une économie de mémoire.

## Vérification et reproductibilité

Les résultats des suites sont résumés dans
[`validation.json`](browser-cfb9f34ae-20260906/validation.json).
Le scénario de production n'embarque pas les garde-fous stricts : ceux-ci sont
vérifiés dans le worker de validation séparé et les tests ciblés.

| Vérification finale | Résultat |
| --- | --- |
| Suite unitaire, confirmation à 2 workers | 3 715/3 715, code 0 |
| Suite de build | 750/750, code 0 |
| Corpus render MLT logiciel strict | 243/243, code 0 ; 1 680 hors sélection |
| Interactions complètes | 177/178, code 1 ; `Marker: correct position` terrain |
| TypeScript, lint modifié, builds dev/prod/strict | Réussis |

Un premier passage unitaire final avait écrit un rapport entièrement réussi mais
s'était terminé avec le code 143 ; la confirmation ci-dessus lève cette incertitude.
Elle a chevauché les diagnostics mémoire, pas les trois paires de chronométrage.
Le timeout terrain est le même que lors des campagnes précédentes, où il avait
également été reproduit upstream. Aucun test n'a été désactivé.

Les compteurs worker stricts interdits restent tous nuls. Les totaux deviennent
817 couches, 3 273 colonnes, 2 535 723 valeurs, 29 377 563 octets de colonnes et
156 796 506 octets **cumulés** de copies brutes. Résoudre les attributs publics
avant surzoom décode davantage de colonnes : ce coût corrige une perte de données,
il ne faut pas le comparer à un résultat incomplet comme à travail identique.

La référence de taille des bundles a été actualisée après mesure : par rapport au
premier build de ce lot, main inchangé, worker +85 octets, shared +341 octets.
Le premier contrôle de build donnait 749/750, avec échec de taille du shared.
La référence antérieure avait déjà consommé presque toute sa marge ; les quotas
raw/gzip eux-mêmes sont inchangés. Les deux passages sont archivés.
La suite GPU complète de 1 923 fixtures n'a pas été rejouée après ces corrections.

```bash
npm run build-prod
npm run build-css
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-lifecycle.ts --runs 3 --cycles 30 --memory-cycles 100 \
  --measure-with-differences --output /tmp/mlt-browser-new-campaign
node test/bench/e2e/mlt-lifecycle-analyze.mjs /tmp/mlt-browser-new-campaign

PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-lifecycle.ts --runs 1 --cycles 1 --memory-cycles 300 \
  --measure-with-differences --output /tmp/mlt-browser-memory-extension
node test/bench/e2e/mlt-lifecycle-analyze.mjs /tmp/mlt-browser-memory-extension
```

Le dossier de sortie doit être nouveau. Sans `--measure-with-differences`, les écarts
de géométrie/pixels interrompent le banc avant les chronométrages. Avec cette option,
les mesures continuent mais **le statut reste `differences` et le code de sortie 1**.
Une différence d'attributs/état/comptes reste bloquante. Aucun seuil d'acceptation des
écarts géométriques n'a été ajouté.

Les campagnes Node précédentes restent celles de leurs snapshots historiques ;
elles ne deviennent pas une qualification implicite des trois corrections de ce lot.
Les sources produit, outils, preuves et documentation restent locaux, sans commit
ni push dans ce lot.
