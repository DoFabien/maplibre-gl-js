# FastPFOR sur le chemin MLT prétriangulé — 8 septembre 2026

## Résultat

Sur cette scène, FastPFOR ne démontre pas de gain de rendu stable par rapport
au MLT VARINT actuel. Les allocations worker sont proches, et le poids gzip
augmente de **3,52 %**. Le chemin direct reste actif et la scène est identique
en pixels et en requêtes. En revanche, **la parité globale des données échoue
sur une couche `contour`** : ne pas activer FastPFOR par défaut sur cette base.

Le moteur n'a pas été modifié : les 848 fichiers source GL JS, 143 fichiers
source MLT et les bundles production correspondent au checkpoint prétriangulé.
Lors de la campagne du 8 septembre, les commits restaient `4ac9eb198` (GL) et
`ddf28400` (TileSpec), avec le prototype prétriangulé non commité déjà présent.
Aucun commit ni push n’avait été effectué dans cette campagne.

## Mesures comparables, moteur identique

Les temps sont des médianes de six médianes de session, en millisecondes.
« Dessin chargé » désigne la soumission CPU après rechargement, pas la fin
GPU, la présentation, les FPS ou le chargement initial de la carte.
Les requêtes sont l'extraction exhaustive des couches building/road/poi_label,
`queryRenderedFeatures` et `toJSON`, chronométrée séparément ; pas une requête
ponctuelle sous la souris, ni `JSON.stringify`.

| Mesure | MVT | MLT VARINT | MLT FastPFOR |
| --- | ---: | ---: | ---: |
| Dessin chargé, natif | 75,625 ms | 67,475 ms | 67,750 ms |
| Dessin chargé, surzoom chaud | 98,550 ms | 60,400 ms | 62,050 ms |
| Requêtes complètes, natif | 45,025 ms | 70,200 ms | 69,975 ms |
| Requêtes complètes, surzoom | 25,275 ms | 33,775 ms | 33,425 ms |
| Allocations worker estimées, 10 rechargements natifs | 387,11 Mio | 181,50 Mio | 180,06 Mio |
| Total des quatre tuiles, gzip | 733 662 octets | 509 665 octets | 527 605 octets |
| Total des quatre tuiles, brut | 1 481 872 octets | 1 055 493 octets | 1 003 790 octets |

FastPFOR contre VARINT : dessin **+0,41 %** au natif et **+2,73 %** au surzoom,
allocations **−0,79 %**, gzip **+3,52 %**, taille brute **−4,90 %**.
Les écarts de temps ne constituent pas un bénéfice stable : les comparaisons
natives appariées sont favorables à FastPFOR dans trois rotations sur six,
et défavorables dans trois. Leurs écarts vont de −2,24 % à +18,07 % ; ceux
du surzoom vont de −15,39 % à +23,72 % (deux gains, une égalité, trois pertes).
Ce sont des plages observées, pas des intervalles de confiance.

FastPFOR contre MVT reste plus rapide jusqu'au dessin sur cette scène :
**−10,41 %** au natif et **−37,04 %** au surzoom. Les requêtes complètes restent
plus lentes : **+55,41 %** et **+32,25 %**. Ne pas mélanger ces mesures avec
les valeurs absolues d'une campagne précédente : le témoin MVT est remesuré.

## Parité ciblée acquise, parité globale en échec

L'encodage conserve `--tessellate --outlines ALL --nomorton` et ajoute seulement
`--enable-fastpfor`. Le JAR, les fichiers, les tailles et les streams sont
identifiés dans `fastpfor-encoding-audit-20260908/manifest.json`.
Les quatre tuiles contiennent 676 flux FAST_PFOR, 76 VARINT et 522 NONE.
Les couches de la scène contiennent 240 flux FAST_PFOR, dont 112 géométriques.
Les fichiers originaux n'ont pas été remplacés.

L'audit compare les features ordonnées, IDs, propriétés, coordonnées, contours
et buffers de triangles. **64 couches sur 65** passent exactement. Le décodage
de `contour` dans `14-8803-5374.mlt` échoue avec
`RangeError: start offset of Int32Array should be a multiple of 4`.
Dans `integerStreamDecoder.ts`, `getVectorType` traite un flux non-VARINT
DELTA+RLE à deux runs comme quatre mots bruts, sans distinguer FAST_PFOR.
Le décodeur n'a pas été corrigé ni contourné dans cette campagne.

La scène de référence inchangée ne dessine pas `contour`. Ses cinq couches
source (landuse, water, building, road, poi_label), avec six couches de style
fill/line/circle/heatmap, passent les comparaisons complètes sur GPU et logiciel.
Les compteurs interdits et `propertyProxyMisses` sont nuls. Au natif, le
chargement initial puis le rechargement cumulent 9 850 features et 54 728
triangles sur le chemin direct, identiques pour VARINT et FastPFOR.
Cela ne qualifie pas tous les styles, symboles, projections ou la suite GPU complète.

## Protocole et robustesse

- Chrome 152.0.7977.75, Linux x64, Intel i7-1260P, GPU Intel Iris Xe via ANGLE,
  800 × 600, DPR 1, un worker par carte.
- Quatre tuiles réelles Berlin, zoom natif 14,5 puis surzoom chaud à 15,25.
  Les six permutations des trois formats équilibrent leur position et leur ordre.
- Six sessions par format, vingt mesures après cinq échauffements par phase.
  Le premier rechargement et la première visite sont conservés séparément,
  exclus des agrégats : 720 mesures retenues, 36 premières observations.
- Chronométrage sans instrumentation ni profileur. Allocations dans un processus
  distinct : six sessions par format, dix rechargements après cinq échauffements,
  échantillonnage Poisson V8 à 16 Kio, objets déjà collectés inclus.
  Il ne s'agit pas de mémoire conservée, maximale ou GPU.
- Réseau local, sans compression HTTP ni latence artificielle. Le gzip est une
  mesure de fichiers séparée avec les mêmes réglages de compression.
  Le bureau et sa charge ambiante ne sont pas un laboratoire matériel contrôlé.
- Le vérificateur indépendant recalcule les médianes, totaux des profils bruts,
  signatures complètes et comparaisons de pixels : **66 images, 66 archives de
  requêtes et 756 observations** vérifiées. Tous les inputs et bundles sont hashés.

La première campagne d'allocations est conservée comme diagnostic : un nom
de fonction `toString` entrait en collision avec le prototype du dictionnaire
du récapitulatif par fonction. Les totaux bruts n'étaient pas affectés.
Le nouvel outil utilise un dictionnaire sans prototype et la campagne a été
entièrement rejouée. La version mesurée du harness avant cette correction
d'une ligne est conservée dans `fastpfor-measured-harness-20260908.ts` ; le
vérificateur contrôle son hash pour la campagne de temps et les contrôles stricts.

## Reproduction et preuves

Outils : `test/bench/generate-mlt-fastpfor.mjs`,
`test/bench/e2e/mlt-fastpfor-browser.ts`, `test/bench/e2e/mlt-fastpfor-verify.ts`.
Utiliser Node natif, des dossiers de sortie neufs, et les mêmes bundles.
Ne pas lancer de builds/tests pendant une campagne de performance.

```bash
node test/bench/generate-mlt-fastpfor.mjs <nouveau-dossier-tuiles>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false node test/bench/e2e/mlt-fastpfor-browser.ts --mode parity --strict --fixtures <dossier-tuiles> --output <nouveau-dossier-parite>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false node test/bench/e2e/mlt-fastpfor-browser.ts --mode timing --runs 6 --samples 20 --warmup 5 --fixtures <dossier-tuiles> --output <nouveau-dossier-temps>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false node test/bench/e2e/mlt-fastpfor-browser.ts --mode allocations --runs 6 --repeats 10 --warmup 5 --fixtures <dossier-tuiles> --output <nouveau-dossier-allocations>
```

Le générateur retourne actuellement un code non nul et un manifeste `failed`
pour préserver l'échec `contour`. Le benchmark autorise ce corpus seulement
après contrôle explicite de la parité des couches effectivement utilisées.

Preuves principales : `fastpfor-comparison-20260908.json`,
`browser-fastpfor-timing-20260908/results.json`,
`browser-fastpfor-allocations-final-20260908/results.json`,
`browser-fastpfor-parity-final-{gpu,software}-20260908/results.json`.
Le recalcul indépendant SQLite depuis les observations et les noeuds des
profils bruts retrouve exactement les mêmes chiffres :
`fastpfor-sql-verification-20260908.json`. Il est reproductible avec
`node test/bench/e2e/mlt-fastpfor-sql-verify.mjs` (sortie neuve requise), en
utilisant les requêtes `mlt-fastpfor-timing.sql` et `mlt-fastpfor-costs.sql`.
Le rapport consultable est conservé sous forme de manifeste complet dans
`fastpfor-report-20260908.json` ; sa validation et son rendu MCP réussissent.
Le graphique compare six barres groupées par phase, avec légende, axe en ms
partant de zéro et palette native bleu/orange ; les autres mesures restent
dans leur propre tableau afin de ne pas mélanger unités et échelles.

Le lint ciblé des quatre outils passe. Les suites produit complètes n'ont pas
été rejouées : aucun code du moteur n'a changé.

## Suite proposée

Corriger et couvrir la détection DELTA+RLE avec FastPFOR avant toute activation
par défaut. Puis réévaluer l'encodage sélectif et la réutilisation des espaces
de travail du décodeur si un profil montre qu'ils coûtent réellement du temps.
Une généralisation demande d'autres corpus, styles et architectures, ainsi
qu'un vrai scénario réseau compressé ; ce test n'établit pas que FastPFOR est
inutile en général.

## Versionnement du 13 septembre

Les outils, requêtes SQL, rapport, comparaison, vérification SQL et manifeste
de l'audit sont versionnés. Les tuiles, images, profils et séries brutes restent
locaux hors Git ; leurs chemins exigent ce workspace ou la restauration des
preuves correspondantes.

Le typage du choix MVT/MLT est précisé sans changer le JavaScript exécuté.
`fastpfor-allocations-harness-20260908.ts` conserve les octets exacts du harness
de la campagne finale d'allocations, en complément du snapshot de chronométrage
existant. Le vérificateur reconnaît les deux empreintes historiques ; aucune
mesure ni erreur du décodeur n'est corrigée par cette préparation des commits.

Le vérificateur relancé le 13 septembre avec la gestion des snapshots confirme
**66 images, 66 archives de requêtes et 756 observations**, avec le statut
`passed-with-global-input-parity-failure`. L'erreur `contour` reste explicitement
contrôlée. Le JavaScript émis du harness d'allocations est identique avant/après
l'annotation de type, et le contrôle TypeScript du workspace passe.
