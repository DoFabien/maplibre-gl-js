# MLT → rendu direct : surzoom — 8 septembre 2026

## Résultat et décision

Le détour `tables découpées → MLT enfant encodé → décodage au retour du cache`
est supprimé dans le prototype local. Cela raccourcit le chemin de production des
buckets. Le navigateur confirme **37 % de délai en moins jusqu'au dessin à froid**
sur le scénario local mesuré, **mais pas une amélioration globale** : le
parent complet est transféré au main thread et le premier accès public redécoupe
les couches demandées. Le cache chaud et la mémoire sont donc des critères de
décision, pas seulement le temps worker à froid.

Ce lot prolonge l'objectif de parité du rendu MVT, pas les campagnes de livraisons
HTTP. Aucune image attendue, tolérance de pixels ou réponse GeoJSON de référence
n'est modifiée par ce lot. Les campagnes historiques restent attachées à leurs
anciens bundles ; elles ne certifient pas automatiquement cette modification.

## Chemin et invariants

Avant : décodage du parent projeté, résolution de toutes les propriétés,
découpage, construction des buckets, encodage MLT enfant pour les requêtes et le
cache. Au retour du cache : décodage du parent puis de l'enfant encodé.

Après : décodage des colonnes utiles au style, plan de découpage numérique
indépendant des propriétés, liaison des colonnes courantes, buckets. Le cache
conserve géométrie et indices de lignes source. Les octets du parent et ses
coordonnées accompagnent le `FeatureIndex` ; seules les couches effectivement
interrogées sont découpées sur le main thread, de façon synchrone.

- Aucun réencodage MLT enfant et aucun détour MVT dans le worker MLT.
- Les colonnes non utilisées restent disponibles pour les requêtes publiques.
- Les changements de style ne réutilisent pas les anciennes propriétés projetées.
- Un contenu différent à la même URL invalide le plan géométrique.
- Le cache reste borné à 64 MiB ; son budget compte les ArrayBuffers retenus et
  une estimation des objets, **pas le heap total** des workers et tuiles actives.
- La copie worker→main du parent existe encore, une fois par réponse enfant.
- Un test de changement de style puis de feature-state a révélé une propriété
  différée non transférée lorsque sa branche était inactive. La résolution
  ciblée des dépendances de feature-state corrige ce cas sans tout décoder.

## Référence figée et mesure worker

L'[archive avant modification](direct-overzoom-before-20260908/workspace.tar.gz)
contient `gl-src`, `mlt-src`, `mlt-dist`, `browser-dist` et `gl-package.json`,
capturés avant toute modification de ce lot, y compris le travail local antérieur.
Elle ne doit pas être reconstruite depuis HEAD, qui ne contient pas ces changements.
L'[archive après qualification](direct-overzoom-final-20260908/workspace.tar.gz)
conserve les deux arbres `src`, le MLT compilé et les bundles production/dev/strict
avec les chemins des dépôts. SHA-256 des archives :

- Avant : `fcbc4209e71eb84988ba6979a4c9f13f991ba77c0623fade3f4a0f044c3c8334`.
- Après : `8bd7292bff45deef3e3448002f58beb6cc19da3785b826b3b6602b43eab83e56`.

Le [diagnostic Node isolé](direct-overzoom-pipeline-isolated-20260908.json) alterne huit
variantes avant/après × MVT/MLT × cache froid/chaud : dix échauffements, trente
échantillons par variante, faux HTTP mais vrai décodage/clipping/buckets/transfert.
Les 423 features publiques et les buffers géométriques sont strictement identiques.
Les hashes et la construction des captures sont hors des mesures.

| Médiane MLT, diagnostic isolé | Avant | Après |
| --- | ---: | ---: |
| Worker, cache froid | 10,657 ms | 8,654 ms |
| Worker, cache chaud | 1,789 ms | 2,588 ms |
| Première requête complète, froid | 1,476 ms | 8,527 ms |
| Octets transférés, tous buffers uniques | 87 654 | 346 259 |
| Dont données brutes pour requêtes | 14 701 | 273 306 |
| Budget de l'entrée de cache | 14 701 | 299 194 |

Le coût de sérialisation/transfert Node reste autour de 0,7–0,8 ms, mais ce n'est
ni une mesure de transfert inter-thread navigateur, ni une mesure GPU. Le témoin
MVT garde les mêmes octets et des médianes worker proches. Le
[passage v2](direct-overzoom-pipeline-v2-20260908.json) et une répétition
[`final`](direct-overzoom-pipeline-final-20260908.json), concomitante aux contrôles
de compilation/navigateur, confirme le sens des écarts avec des temps absolus plus
élevés ; ils restent conservés distinctement du passage isolé.

Le premier essai de compilation du module gelé utilisait des sémantiques de
champs de classes différentes faute de `tsconfig` près des sources temporaires.
Le banc impose désormais le même `tsconfig` aux deux variantes. Cet essai échoué
n'est pas compté comme résultat produit. Les modules et leurs empreintes sont
conservés séparément, sans écraser la référence.

## Navigateur de production, avant/après

La [campagne navigateur](browser-direct-pipeline-production-20260908/results.json)
compare les vrais bundles avant/après sur Chrome 152.0.7977.75, Iris Xe, canvas
800 × 600, DPR 1, un worker et les quatre tuiles Berlin locales. Douze sessions :
trois rotations de l'ordre avant/après × MVT/MLT. Chaque session effectue cinq
échauffements puis vingt mesures **pour chaque état du cache**, froid et chaud.
Cela représente 480 mesures retenues et 120 échauffements, pas 600 observations
indépendantes. Le cache HTTP est désactivé ; des URLs identiques/uniques exercent
le cache applicatif chaud/froid. Aucune autre campagne de tests/build ne tourne
pendant ce passage. Les requêtes, signatures, captures et GC sont hors du délai
rechargement→dessin ; les mesures ne contiennent pas les garde-fous stricts.

Les chiffres ci-dessous sont les médianes des trois médianes de session.

| Mesure | MLT avant | MLT après | MVT avant → après |
| --- | ---: | ---: | ---: |
| Rechargement → premier dessin chargé, froid | 135,55 ms | 85,45 ms | 88,25 → 88,25 ms |
| Même mesure, cache chaud | 53,05 ms | 62,60 ms | 59,05 → 60,35 ms |
| Première requête complète, après froid | 35,10 ms | 78,00 ms | 22,00 → 24,10 ms |
| Première requête complète, après chaud | 33,25 ms | 79,10 ms | 23,05 → 22,85 ms |

Le gain à froid se répète dans les trois sessions : médianes avant 133,20–136,70 ms,
après 80,10–86,95 ms. Le cache chaud régresse d'environ 18 % et la première requête
coûte plus du double. Il ne faut ni additionner arbitrairement les médianes, ni
présenter ce résultat comme un gain de FPS : l'événement `render` marque la
soumission CPU du dessin, **pas la fin d'exécution GPU ou la présentation écran**.
La carte est déjà créée ; ce n'est pas le chargement initial de toute l'application.
Toutes les signatures de requêtes sont identiques entre variantes/répétitions,
ainsi que les douze captures finales. Les tableaux géométriques Node et les
campagnes strictes apportent des contrôles complémentaires.

La mémoire est relevée après GC, séparément des chronométrages. À la fin des
vingt paires mesurées, le stockage externe V8 (`backingStorageSize`, ArrayBuffers
et chaînes externes) passe de **9 556 605 à 61 150 153 octets dans le worker**,
et de **2 854 150 à 6 819 155 octets sur le main thread**. Ces valeurs sont
identiques dans les trois répétitions. Les heaps JS utilisés sont respectivement
environ 4,25 → 8,43 Mo et 7,24 → 7,74 Mo. Le témoin MVT garde son stockage externe
à environ 13,1 Mo worker / 2,5 Mo main.

Retirer la source libère ses données actives main, mais conserve le cache worker
dans les deux versions. Après `map.remove()`, le stockage externe worker revient
à environ 0,7 Mo et le main à 1,24 Mo. Ce passage n'établit ni un plateau à très
long terme, ni une limite de mémoire GPU, ni un plafond global de 64 MiB : ce
dernier ne s'applique qu'au budget estimé du cache d'overzoom.

## Vérifications et reste à conclure

- 2 617 tests TileSpec et 3 758 tests unitaires GL JS passent.
- 759 tests de build passent après actualisation des tailles constatées,
  sans modifier les quotas. Les trois bundles passent de 1 292 427 à 1 282 267
  octets bruts au total, et de 341 130 à 338 832 octets gzip.
- Le typecheck et le lint des modifications passent.
- 23 checkpoints globe/terrain et 25 checkpoints styles passent chacun sur
  production Iris Xe, worker strict Iris Xe et worker strict SwiftShader :
  **144 paires exactes**, pixels et requêtes complètes, avec répétitions de mutations.
  Les dix compteurs interdits et `propertyProxyMisses` sont présents et nuls.
- La campagne navigateur de production avant/après est complète, sans profiler
  ni compteurs stricts ; ses limites de mesure sont précisées ci-dessus.
- 178 tests d'intégration et 243 rendus MLT strict en logiciel passent sur le
  produit courant. La suite complète GPU strict termine à **1 887/1 923**, avec
  exactement les mêmes 36 noms de tests en échec que le lot précédent et aucune
  fixture omise. Elle reste en échec contre les baselines ; aucune tolérance
  n'est ajoutée. Cette comparaison des noms ne prouve pas que chaque image déjà
  en échec présente exactement le même écart.

L'[audit de parité](direct-overzoom-validation-v3-20260908/validation.json)
recalcule les 144 comparaisons PNG/GeoJSON, vérifie les compteurs, les octets
servis et le manifeste de tous les fichiers source. La
[consolidation finale](direct-overzoom-final-20260908/qualification.json)
conserve les résultats GPU, les trois répétitions navigateur, le passage Node
isolé et leurs empreintes. Son statut reste explicitement qualifié **avec échecs
GPU de référence et compromis de performance**, pas « tout est vert ».

Deux premiers essais de l'auditeur ont conservé un statut d'échec : ils
supposaient à tort que la session initialement MVT ne décodait jamais de MLT,
puis qu'elle surzoomait ce MLT. Les changements de style basculent bien
l'encodage, mais à zoom natif. L'audit final exige le décodage dans cette session,
zéro clipping MLT dans celle-ci et du clipping positif dans la session MLT ;
les compteurs interdits restent exigés présents et nuls partout. Les données
produit et les captures n'ont pas été modifiées pour corriger ces assertions.

Le prochain verrou d'architecture est de réutiliser le parent et les plans entre
enfants, et d'éviter leur redécodage/redécoupage côté requêtes, tout en conservant
les API synchrones et les propriétés complètes. Il faut mesurer cette variante
avant d'étendre les optimisations à d'autres phases des buckets.
