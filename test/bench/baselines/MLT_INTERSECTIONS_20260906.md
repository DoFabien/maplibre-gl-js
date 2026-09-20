# Accès à la topologie des requêtes rendues — 6 septembre 2026

## Résultat

La mémorisation des bornes de la partie courante réduit le temps de
`queryRenderedFeatures()` MLT en surzoom de **15–20 %** sur les deux vues mesurées.
En incluant `toJSON()` et la sérialisation JSON, la baisse est de **4–11 %**.
La vue initiale ne présente pas de gain net. La parité complète des réponses et des
pixels est conservée entre les deux versions et les deux encodages aux sept
checkpoints ; aucune référence ni tolérance n'est modifiée dans ce lot.

Ces résultats concernent des requêtes à caméra fixe sur les quatre tuiles Berlin,
pas un gain de FPS ni de l'ensemble du cycle animé. Les coûts résiduels de
matérialisation/sérialisation publique ne disparaissent pas.

## Changement borné

`ColumnarGeometryView.getX/getY` repositionnait le curseur partagé et sélectionnait
la partie à chaque lecture de sommet. La vue conserve maintenant l'indice, le début,
la fin et la fermeture virtuelle de la partie courante. Elle invalide ces quatre
champs scalaires à chaque changement de feature, puis les résout au premier accès
à une nouvelle partie. Aucun index de toutes les features, tableau de géométrie,
`Point` ou dictionnaire de propriétés supplémentaire n'est construit.

Le cache contient une copie des bornes, pas une référence à la sélection mutable du
curseur partagé. Il reste donc valide si une autre vue ou une lecture publique
déplace ce curseur. Les contrôles des indices, l'ordre des sommets, les offsets de
vertices, l'arrondi à l'extent interne et la fermeture des polygones sont conservés.

Deux tests ajoutés couvrent les lectures intercalées, le changement de partie et de
feature, les indices invalides, les offsets de vertices, l'extent et la fermeture
virtuelle. Le test de résolution répétée échouait avant : **22 appels à `seek` pour
20 lectures X/Y**, contre **2** après (positionnement initial et première sélection).
Les lectures géométriques restent possibles sans matérialisation sous garde-fous stricts.

Le dépôt Tile Spec reste inchangé à `1ec5c6b1`. La base GL JS est `cfb9f34ae` plus les
corrections locales documentées précédemment, pas le commit nu. Le build de référence
est figé dans [snapshot.json](browser-intersections-reference-20260906/snapshot.json),
avec le diff produit et les SHA-256 des bundles/maps. La référence inclut déjà
l'arrondi commun et la projection GeoJSON du [lot précédent](MLT_ROUNDING_QUERY_20260906.md).

## Protocole avant/après dans la même campagne

- Chrome 152.0.7977.75, Node 24.18.1, production 6.7.0, Iris Xe/ANGLE, 800×600/DPR 1,
  un worker, quatre tuiles locales, pas de réseau distant ni de compression HTTP.
- Quatre conditions : avant-MVT, avant-MLT, après-MVT, après-MLT. Quatre rotations
  déplacent chaque condition à chacune des quatre positions d'exécution.
- Page/worker distincts par condition ; aux trois caméras : contrôle GeoJSON complet,
  10 chauffes, puis 50 mesures. **16 sessions, 2 400 requêtes mesurées**.
- `queryMs` mesure l'appel public ; `materializeMs` la création du GeoJSON via
  `toJSON()` ; `stringifyMs` la sérialisation. `totalMs` est leur somme par échantillon.
- Pas de profil CPU, GC forcé, test unitaire ou compilation pendant la collecte.
  Les validations ont été lancées après la campagne. Le poste n'est pas dédié.
- Sept checkpoints par condition archivent captures et réponses intégrales :
  **28 images et réponses**, hashes identiques entre versions/encodages.

Les comparaisons utilisent les médianes des sessions appariées à l'intérieur d'une
rotation. Les plages ci-dessous gardent les quatre résultats, pas seulement le meilleur.
Le total est la médiane des sommes par échantillon, pas la somme des médianes.

| Caméra / résultats par requête | `queryMs` MLT avant | `queryMs` MLT après | Gain apparié requête | Gain apparié avec GeoJSON + JSON |
| --- | ---: | ---: | ---: | ---: |
| Initiale / 3 959 | 8,80–9,65 ms | 8,30–9,60 ms | 0–5,7 % | −5,2 à +3,2 % : pas de gain net |
| Surzoom 1 / 2 421 | 9,80–10,60 ms | 8,20–8,95 ms | 15,0–16,3 % | 4,1–9,3 % |
| Surzoom 2 / 1 135 | 6,90–7,30 ms | 5,50–5,90 ms | 16,9–20,3 % | 7,7–10,8 % |

Le témoin MVT met encore en évidence du bruit : une rotation présente +21 % sur
l'appel de requête en surzoom 1, et les comparaisons initiales sont dispersées.
Les gains MLT en surzoom restent présents dans **chacune des quatre rotations**.
On ne conclut ni à un gain précis indépendant du poste, ni à une supériorité globale
sur MVT : après changement, le coût complet MLT reste notamment 13–21 % supérieur
à MVT en surzoom 2. Le gain réduit ce retard, sans le supprimer.

Preuves : [résultats bruts](browser-intersections-20260906/results.json),
[analyse reproductible](browser-intersections-20260906/analysis.json),
build de référence conservé dans `browser-intersections-reference-20260906/`.

## Validation

Typecheck, lint et builds dev/prod/worker strict passent ; 32 tests ciblés réussis.

- **3 728/3 728 tests unitaires**, code 0 (4 workers, timeout 20 s).
- **750/750 tests de build**, code 0 ; référence de taille et quotas inchangés.
- **1 887/1 923 rendus GPU** sur Iris Xe, code 1 : exactement les mêmes 36 échecs
  que `MLT_EXTENSION_20260906.json`, aucun nouveau.
- **243/243 rendus MLT stricts en logiciel**, code 0 ; les compteurs interdits
  restent tous nuls en logiciel et GPU (817 couches, 3 273 colonnes décodées,
  156 796 506 octets cumulés de copies brutes, mêmes volumes que le lot précédent).
- **178/178 tests d'intégration**, code 0.

Le bundle partagé ajoute **318 octets bruts / 66 octets gzip** par rapport au build
figé ; main et worker sont identiques en taille. La validation unitaire et le GPU
ont été exécutés en parallèle après les chronométrages. Ni les références GeoJSON
actualisées au lot précédent ni les images/tolérances ne sont modifiées ici.
Les [rapports bruts et compteurs archivés](browser-intersections-20260906/validation.json)
vérifient les hashes des bundles et du banc, ainsi que le diff produit testé.

## Suite logique

Étendre le scénario navigateur aux symboles/glyphes avant d'extrapoler à des cartes
complètes. Le coût public de GeoJSON et les transferts worker→main restent des pistes
distinctes ; ni la mémoire GPU, ni les 300 cycles mémoire, ni les FPS du scénario
animé précédent ne sont re-mesurés dans ce lot.

```bash
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-lifecycle.ts --phase compare --runs 4 \
  --reference-dist test/bench/baselines/browser-intersections-reference-20260906 \
  --output <nouveau-dossier>
node test/bench/e2e/mlt-intersections-analyze.mjs <nouveau-dossier>
```
