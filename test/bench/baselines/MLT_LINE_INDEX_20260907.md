# MLT — indexation des parties sans segment, 7 septembre 2026

## Correction

Le bucket de lignes colonnaire conserve désormais les bornes numériques d'une
partie non vide, même si elle ne peut produire aucun segment. Un point ou une
ligne réduite à un sommet reste ainsi interrogeable comme en MVT, sans créer de
sommets/triangles supplémentaires. Le cas multipartie conserve aussi l'emprise
de sa partie dégénérée, pas seulement celle de sa partie dessinable.

Le retour anticipé de `ColumnarLineBucket.addLine` ne concerne plus que les parties
vides. La boucle numérique existante calcule les bornes ; le contrôle de validité
suivant interdit toujours la tessellation d'une partie trop courte. Pas de
`Point`, de reconstruction de feature ni de fallback ajouté au worker.

Le test `worker_tile_line_query_parity.test.ts` passe par le vrai `WorkerTile`,
le transfert de l'index et ses intersections de requête. Il couvre points mixtes,
points constants, multipoint, ligne effondrée, partie dégénérée voisine d'une
ligne dessinable et partie vide. Avant correction, cinq cas échouent et le
contrôle vide passe ; après correction, les six passent, avec mêmes résultats
MVT/MLT et mêmes nombres de sommets/triangles. Les compteurs stricts restent nuls.

Les branches et HEAD restent ceux du lot précédent : GL JS
`restack/mlt-feature-state-native` / `cfb9f34ae37a0e3bc9696c2e251f54ac7ee0e77e`,
TileSpec `mlt-columnar/tile-spec-minimal` /
`1ec5c6b144c8ed5eca580c2ba406f323f240e45c`. Correction locale, aucun commit/push.

## Validation

Les campagnes [production Iris Xe](browser-arrival-production-v4-20260907/results.json),
[strict Iris Xe](browser-arrival-strict-gpu-v5-20260907/results.json) et
[strict SwiftShader](browser-arrival-strict-software-v4-20260907/results.json)
passent chacune : 8 sessions, 88 captures, 44 comparaisons MVT/MLT, 44 répétitions,
4 convergences finales exactes et 4 contrôles d'ordre de livraison discriminants.
Au total : **276 comparaisons positives exactes et 12 contrôles discriminants**.
Les 48 captures partiellement chargées par campagne sont incluses.

Les **69 tests ciblés**, **3 751 tests unitaires**, **759 tests de build** et
**178 tests d'intégration** passent, ainsi que le test du serveur HTTP,
le typecheck et le lint des fichiers modifiés. Les builds dev, production et
stricts dev/production sont reconstruits. Aucun changement des quotas ou de
la référence de taille : main/worker/partagé gardent leur taille brute ; le partagé
perd un octet gzip. Pas de mesure de performance déduite de ces tailles.

Le premier passage des tests de build échoue sur deux imports ESM dev au seuil
de 5 secondes pendant l'exécution parallèle des suites. Le passage complet isolé
réussit sans modifier délai, test ou assertion. Les deux rapports sont conservés.

La [vérification indépendante](browser-arrival-production-v4-20260907/validation.json)
termine avec le code 0, statut `verified-controlled-partial-arrivals`. États,
caméras, requêtes et événements sont également identiques entre configurations ;
les pixels ne sont pas comparés entre deux GPU différents.

Les **243/243 fixtures MLT strictes logiciel** passent à nouveau, avec tous les
compteurs interdits à zéro. Les 1 680 tests render hors filtre ne sont pas comptés
comme réussis ; la suite GPU complète n'est pas relancée dans ce lot.

L'[audit avant/après](browser-arrival-production-v4-20260907/line-index-audit.json)
termine aussi avec le code 0 (`verified-line-index-fix`) :

- **88/88 images inchangées** entre l'ancienne et la nouvelle production.
- Les **44 captures MVT** et toutes les requêtes de source restent inchangées.
- Exactement **20 captures MLT restaurent les deux points** attendus
  (`-29217319`, `-29276745`), soit 40 entrées restaurées. Aucun autre objet n'est
  ajouté, retiré ou modifié ; les multiplicités des résultats sont conservées.
- Les réponses rendues MLT correspondent intégralement à l'ancien oracle MVT,
  pas uniquement au nombre de résultats ou à leurs identifiants.
- Les rapports de tests, compteurs et métadonnées render, journaux de build et
  676 empreintes de sources sont archivés avec le diff produit et les sources
  non suivies par Git.

## Preuves et limites

Le runner d'arrivées, son style `line` sans filtre de géométrie, ses attentes,
le serveur HTTP, les assets et les tolérances restent inchangés. Les nouveaux
résultats sont archivés en `browser-arrival-production-v4-20260907`,
`browser-arrival-strict-gpu-v5-20260907` et
`browser-arrival-strict-software-v4-20260907`. Les anciens résultats
v3 restent en échec : ils décrivent le produit avant correction.

Le validateur d'arrivées vérifie toujours le diff produit actuel et les octets de
chaque bundle/asset, puis reconstruit les comparaisons depuis les PNG et GeoJSON
bruts. L'égalité avec les anciens bundles du lot gestes/animations a été retirée :
elle n'est plus une précondition pertinente après cette correction produit.
Les scripts archivés et certificats historiques ne sont pas réécrits.

`mlt-line-index-validate.mjs` complète cette vérification par une comparaison
avant/après, les rapports unitaires rouges/verts et les empreintes des sources
suivies ou non par Git. Il exige un certificat complet d'arrivées partielles,
des pixels inchangés et uniquement la restauration des deux points documentés.

L'essai strict GPU v4 a servi les anciens bundles production stricts : seule leur
variante développement venait d'être reconstruite. Ses quatre empreintes dist
correspondent exactement au lot cache chaud précédent et il retrouve l'ancien
écart de deux points. Cet essai échoué est conservé, pas compté comme validation
du correctif. La variante production stricte est ensuite reconstruite avec
`BUILD=production` pour la campagne GPU v5 et la campagne logiciel v4.

## Reproduction

Depuis la racine GL JS, reconstruire **les deux variantes strictes** : le banc
d'arrivées sert les fichiers production `.mjs`, tandis que le banc render utilise
les fichiers `-dev.mjs`. Garder les ports 2900/2901 pour le corpus render.

```bash
npm run build-dev
npm run build-prod
BUILD=dev npx rolldown -c rolldown.config.mlt-validation.ts
BUILD=production npx rolldown -c rolldown.config.mlt-validation.ts

PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-arrival.ts --runs 2 --output <production-neuf>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-arrival.ts --strict --runs 2 --output <strict-gpu-neuf>
PUPPETEER_GPU=software \
  node test/bench/e2e/mlt-arrival.ts --strict --runs 2 --output <strict-logiciel-neuf>
node test/bench/e2e/mlt-arrival-validate.mjs <production> <strict-gpu> <strict-logiciel>

PUPPETEER_GPU=software MLT_RENDER_STRICT=true RENDER_TEST_CONCURRENCY=3 \
  npm run test-render -- --run -t 'tests/mlt/'
```

L'audit spécialisé prend, dans l'ordre : ancienne/nouvelle production, rapports
Vitest avant correction/ciblés/unitaires/build/intégration/serveur/premier build,
rapport render, compteurs render, métadonnées render, puis journaux facultatifs.
Les rapports archivés sont les fichiers `line-index-*-tests.json.gz`,
`line-index-render-stats.json.gz` et `line-index-render-metadata.json.gz` de la
nouvelle production. Le rapport rouge correspond au produit avant correction ;
il ne doit pas être régénéré avec le produit corrigé ni remplacé par un succès.

Ce lot ne mesure pas la fluidité temps réel, les performances ou la mémoire GPU.
Il ne qualifie pas les annulations, les erreurs réseau, les livraisons DEM
partielles ou leur combinaison avec un vol globe/terrain. Les campagnes cache
chaud et render GPU complet des lots précédents restent historiques, pas de
nouvelles certifications implicites sur les nouveaux octets.
