# Baseline MLT 6.3 — pipeline natif complet

Cette baseline mesure le commit
`b3aa80ee81d9a7618ee670e02a38a72e016ecdca` avec Node 26.7.0 sur un Intel
Core i7-1260P. Le rapport complet et ses échantillons bruts sont conservés
dans `test/bench/baselines/mlt-v6.3-b3aa80ee8.json`.

## Corpus Bing et FastPFOR

Le corpus Bing standard n'est pas encodé avec FastPFOR. La fixture
`bing/4-12-6.mlt` contient uniquement les techniques physiques `NONE` et
`VARINT`. Le cas FastPFOR distinct utilise
`synthetic/props_u32_fpf_256.mlt`, qui contient `FAST_PFOR` et `NONE`.

Les deux setups inspectent les métadonnées physiques et échouent si Bing
contient FastPFOR ou si la fixture dédiée n'en contient pas. Le benchmark Bing
agrège 30 décodages par échantillon : ses 300 décodages de warmup stabilisent
les changements de tier JIT du décodeur protobuf avant les mesures.

## Protocole

- 62 cas individuels, chacun dans un nouveau processus ;
- 23 comparaisons MVT/MLT appariées et isolées ;
- ordre MVT/MLT alterné à chaque itération ;
- 10 warmups puis 30 mesures conservées ;
- percentiles R7 et ratios calculés échantillon par échantillon ;
- durées, débits, heap, ArrayBuffers, transfert et matérialisations mesurés.

Commande de reproduction :

```bash
npm run bench:mlt-isolated -- --iterations 30 --warmup 10 \
  --output test/bench/results/mlt-current.json
npm run bench:mlt-check -- --report test/bench/results/mlt-current.json
```

## Ratios MLT/MVT appariés

| Scénario | Médiane | p95 |
| --- | ---: | ---: |
| Synthétique, tous buckets | 0,872 | 1,018 |
| Bucket line | 0,713 | 0,900 |
| Bucket fill | 0,760 | 0,833 |
| Bucket circle | 0,981 | 1,245 |
| Bucket fill-extrusion | 0,706 | 1,045 |
| Scan tuiles réelles | 0,082 | 0,097 |
| Décodage réel projeté | 0,227 | 0,377 |
| Décodage réel avec accès public complet | 3,213 | 3,908 |
| Parse-only réel | 0,745 | 1,122 |
| End-to-end réel | 0,685 | 0,812 |
| OMT bâtiments | 0,278 | 0,342 |
| OMT routes et labels | 0,938 | 1,101 |
| OMT labels low-zoom | 0,296 | 0,478 |
| Bing standard, accès complet natif | 0,649 | 0,679 |
| Symboles points | 1,047 | 1,158 |
| Symboles lignes | 1,131 | 2,109 |
| Query rendered, 0 résultat | 0,990 | 1,062 |
| Query rendered, 1 résultat | 0,982 | 1,107 |
| Query rendered, 10 résultats | 0,946 | 1,015 |
| Query rendered, beaucoup | 1,186 | 1,293 |
| Query source, 1 % | 0,300 | 0,481 |
| Query source, 10 % | 0,584 | 0,647 |
| Query source, 100 % | 2,114 | 2,382 |

Le décodage projeté mesure le chemin natif columnar utilisé par le rendu. Le
cas `DecodeFullAccess` force au contraire `layer.feature()`, les propriétés et
la géométrie publiques de chaque feature. Son coût supérieur est attendu et
rend visible la frontière de compatibilité ; il ne représente pas une
matérialisation du chemin de rendu natif.

## Compteurs physiques et matérialisations

Par échantillon, Bing effectue 30 décodages complets : 300 layers, 1 590
colonnes, 16 410 valeurs et 29 914 770 octets de colonnes. Sa médiane est de
313,854 ms par lot, soit environ 95,6 tuiles/s.

FastPFOR effectue 100 décodages complets par échantillon : 100 layers, 200
colonnes, 51 200 valeurs et 208 800 octets de colonnes. Sa médiane est de
20,890 ms par lot, soit environ 4 787 tuiles/s.

Sur les chemins natifs contrôlés :

- les buckets `fill`, `line`, `circle`, `fill-extrusion` et `symbol` restent à
  zéro fallback, wrapper, objet `properties`, `Point` et range géométrique ;
- toutes les queries MLT restent à zéro wrapper intermédiaire ;
- les objets publics de query sont créés uniquement après sélection ;
- feature-state ne redécode pas le raw tile et ne matérialise aucune feature ;
- overzoom reste en MLT, sans `Point`, wrapper ni réencodage MVT ;
- la matrice 5/50/200 colonnes décode exactement les colonnes demandées ;
- le cycle `load → query → feature-state → overzoom → reload` respecte les
  plafonds de heap, ArrayBuffers, transfert et mémoire retenue.

`bench:mlt-check` contrôle les 23 ratios, 29 contrats de matérialisation et
tous les budgets mémoire/transfert à partir de cette référence.
