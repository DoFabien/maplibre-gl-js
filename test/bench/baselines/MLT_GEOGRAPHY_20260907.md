# Globe et terrain MVT/MLT — 7 septembre 2026

## Défauts révélés par le parcours navigateur

Le nouveau parcours alterne Mercator, un mélange explicite à 50 % et le globe,
puis active, recharge, exagère et retire un terrain non plat. Il conserve les
sources vectorielles et leur feature-state. Il prolonge le
[lot idle](MLT_IDLE_20260907.md), sans modifier les images attendues ni les tolérances.

Trois corrections sont nécessaires :

- **Projection commune MVT/MLT** : les tuples littéraux de mélange n'étaient pas
  normalisés comme les résultats d'expressions ; le mélange à 50 % devenait un globe
  à 100 %. `GlobeProjection.transitionState` interprète maintenant ces tuples.
- **Retour au globe automatique** : une projection personnalisée partage le nom
  runtime `globe`. `setProjection({type: 'globe'})` pouvait donc conserver l'ancienne
  expression malgré le changement de style. Le raccourci vérifie aussi la configuration
  précédente, pas seulement le nom de la famille de projection.
- **Subdivision MLT** : le fill colonnaire imposait une granularité nulle et la ligne
  ignorait la granularité de projection. Les buckets utilisent maintenant le zoom
  canonique, y compris avec motifs et pointillés différés. Les contours aplatis sont
  subdivisés numériquement ; le traitement des pôles et de la jointure X à z0 est
  aligné sur MVT. Les distances des lignes découpées sont recalculées après subdivision.

Les tableaux numériques temporaires restent permis. Aucun `Point`, `Point[][]`
ou tableau de couples de coordonnées n'est reconstruit par ces nouveaux chemins.
La normalisation de projection concerne sa configuration, pas les features MLT.

## Contre-épreuves

Après correction des deux problèmes de projection, les réponses GeoJSON et états
étaient déjà identiques aux 23 checkpoints, mais huit captures globales différaient.
Le mode strict ne détectait aucune matérialisation interdite : cela ne suffisait
donc pas à prouver la justesse du rendu.

| Capture avant correction de subdivision | Iris Xe : pixels différents | SwiftShader : pixels différents |
| --- | ---: | ---: |
| Mélange 50 % | 25 885 | 25 141 |
| Globe | 40 774 | 40 204 |
| Globe et terrain | 16 467 | 16 228 |
| Globe tourné | 52 036 | 51 652 |

Ces différences ne sont pas du bruit d'un niveau : l'écart maximal atteint 153
niveaux par canal en logiciel. Les
[captures production avant subdivision](browser-geography-production-20260907/results.json)
et [logiciel strict avant subdivision](browser-geography-strict-software-20260907/results.json)
gardent leur statut d'échec et leurs données complètes.

Les tests de régression ont échoué avant les corrections :
[quatre tests de projection](browser-geography-production-v4-20260907/beforeUnit.json.gz),
[cinq cas de parité de buckets](browser-geography-production-v4-20260907/beforeBuckets.json.gz)
et [trois cas de subdivision aplatie](browser-geography-production-v4-20260907/beforeFlattened.json.gz). Les cinq cas de
buckets couvrent polygone troué, motif différé, ligne courte/longue, anneau fermé,
pointillés différés, distances découpées et zooms canoniques 0/3. Les trois tests du
subdiviseur couvrent contours par anneaux/par segments et absence de contour, avec
pôles et géométrie dépassant la jointure du monde. Les maillages finaux sont comparés
octet par octet à MVT. Le groupe ciblé subdivision/buckets passe à **57/57**.

## Périmètre et garde-fous

Chrome 152.0.7977.75, canvas 800 × 600, DPR 1, un worker, ressources exclusivement
locales, cache HTTP désactivé, caméra non interactive et `fadeDuration: 0`.
Les paires de tuiles sont les quatre tuiles Berlin z14 déjà utilisées et la paire
monde z0 existante. La vue mondiale utilise landcover, water et admin : 2 201 features
source et 448 réponses rendues au checkpoint globe. Les symboles et bâtiments sont
exercés dans les vues locales, pas comme preuve de placement mondial à l'horizon.

Les cinq DEM PNG sont **synthétiques**, générés par une fonction continue non plate,
encodés Mapbox RGB puis archivés et hachés. Ce ne sont pas des relevés topographiques
de Berlin. Quatre tuiles z12 servent la zone locale ; une tuile z0 sert le globe.

| Parcours | Contrôles |
| --- | --- |
| Terrain local, caméra inclinée, exagération 1 → 2 → 1 | Pixels, altitudes non plates et doublées, GeoJSON complet |
| Rechargement DEM et vectoriel, retrait/réintroduction DEM | Retour exact, identité des sources vectorielles et feature-state conservés |
| Mercator → mélange 50 % → globe | Facteur réel du shader observé par une couche custom 2D qui ne dessine rien |
| Terrain mondial, exagération, rotation et retours | Images exactes, caméra/états/requêtes, effets visuels du DEM vérifiés |
| Retour au domicile puis désélection | Restauration exacte de l'état sélectionné puis de l'image initiale |

Chaque session capture **23 PNG et 23 archives GeoJSON complètes**. Deux cycles
supplémentaires de neuf mutations contrôlent les signatures et états à chaque étape,
sans captures supplémentaires. Ce ne sont pas des animations ou des gestes réels.

Le worker strict expose dix compteurs interdits et `propertyProxyMisses`, exigés
présents et nuls. Le témoin MVT ne décode aucune couche MLT ; la session MLT doit
décoder de nouvelles couches mondiales et exercer le surzoom. Les captures et
restaurations sont exactes : aucun seuil de pixels, arrondi GeoJSON ou repaint
diagnostique supplémentaire ne masque une différence.

## Validation finale

- **23/23 checkpoints exacts**, PNG et GeoJSON complet, dans les trois campagnes finales :
  [production Iris Xe](browser-geography-production-v4-20260907/results.json),
  [worker strict Iris Xe](browser-geography-strict-gpu-v4-20260907/results.json),
  [worker strict SwiftShader](browser-geography-strict-software-v4-20260907/results.json).
  Deux cycles de neuf mutations supplémentaires par session, mêmes états et requêtes.
- Dix compteurs interdits et `propertyProxyMisses` présents et nuls à chaque relevé
  strict. Le parcours MLT GPU termine avec 404 couches décodées et 16 907 features
  découpées en surzoom ; ce sont des compteurs de travail, pas de performance.
- **1 887/1 923 rendus GPU**, exactement les mêmes 36 échecs que le lot idle : aucun
  nouveau, aucun disparu. La suite reste en échec, code 1, sans changement de référence
  d'image ou de tolérance.
- **759/759 tests de build**. Le premier passage avait un seul échec : la croissance
  attendue du bundle partagé franchissait le garde-fou de taille. Sa référence est
  actualisée après mesure, les quotas du test restent inchangés : 658 334 octets bruts
  et 176 524 gzip, soit +1 128/+256 par rapport à la référence précédente.
  Les références main/worker sont également synchronisées aux mesures (584 059/50 011
  octets bruts). Le [premier échec de taille](browser-geography-production-v4-20260907/beforeSize.json.gz)
  est conservé, distinct des défauts de rendu.
- **3 743/3 743 tests unitaires**, **178/178 tests d'intégration**,
  **243/243 rendus MLT stricts logiciel**, compteurs interdits nuls.
- Régressions navigateur : base **7/7** en strict GPU et styles **25/25** en strict
  logiciel, avec deux cycles de styles supplémentaires. Images et requêtes exactes.
- Builds production/dev/strict, typecheck et lint ciblé réussis.

Le [vérificateur indépendant](browser-geography-production-v4-20260907/validation.json)
confirme ces résultats, recalcule les signatures GeoJSON et pixels PNG, contrôle les
ressources et compteurs, compare les listes d'échecs GPU, puis archive rapports bruts,
métadonnées et sources compressés. Son statut `verified-with-known-gpu-failures`
ne transforme pas la suite GPU complète en succès.

Les sorties v3 constituent les premiers passages corrigés ; les v4 ci-dessus
utilisent les tests finalisés après lint. L'essai production v2 échouait avant la
création de carte, car `vite-node` transformait l'import dynamique destiné au
navigateur ; il n'est pas compté comme qualification produit. Ces archives ne sont
ni écrasées ni requalifiées.

## Reproduction

Depuis la racine GL JS, construire les bundles puis utiliser **Node**, pas `vite-node` :
la fonction passée à Puppeteer doit conserver son import dynamique de navigateur.

```bash
npm run build-prod
BUILD=production npx rolldown -c rolldown.config.mlt-validation.ts
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-geography.ts --cycles 2 --output <nouveau-dossier>
```

Répéter avec `--strict`, puis avec `PUPPETEER_GPU=software --strict`.
Chaque sortie doit être un nouveau dossier. Les étapes, versions, différences source,
empreintes des bundles/ressources et paramètres effectifs du navigateur sont archivés.
Le lanceur échoue sur toute différence et ferme ses pages/navigateur/serveur.

Le vérificateur indépendant reçoit, dans cet ordre : dossiers production/strict GPU/
strict logiciel, rapports JSON unit/build/intégration/GPU, compteurs GPU, rapport
projection avant correction, résultats navigateur base/styles, rapports buckets et
subdiviseur avant correction, rapport render MLT strict logiciel et rapport de build
avant actualisation des tailles.
Il recalcule les pixels et signatures depuis les archives, vérifie les empreintes
actuelles et distingue échecs GPU connus, résolus et nouveaux.

## Limites et suite

Ce lot vérifie la correction, pas la performance. La subdivision supplémentaire
augmente la densité des maillages MLT à faible zoom ; son coût CPU/mémoire/FPS n'est
pas mesuré ici. Les durées de campagnes parallèles ne sont pas des benchmarks.
Les compteurs stricts ne prouvent ni zéro allocation ni absence de fuite/GPU cache.

Restent les gestes réels, les animations et frames intermédiaires, les symboles
mondiaux à l'horizon, les encodages et topologies rares, les DEM réels à plusieurs
niveaux et les autres pilotes. La suite logique est un parcours de gestes et de
transitions animées sur ce corpus déterministe, avec vérification d'état final,
puis une mesure isolée du coût des maillages globaux.
