# Baseline MLT 6.3 — sorties query columnar directes

Cette baseline mesure le chemin MLT sans adaptateur intermédiaire au commit
`c4512bbe862b1e9d5382f19bfd34afdfeffcd19c`, avec Node 26.7.0 sur un Intel
Core i7-1260P. Le rapport complet et ses échantillons bruts sont conservés dans
`test/bench/baselines/mlt-v6.3-c4512bbe8.json`.

## Protocole

- 47 cas individuels exécutés chacun dans un nouveau processus ;
- 16 comparaisons MVT/MLT appariées, elles aussi isolées par processus ;
- ordre MVT/MLT alterné à chaque itération ;
- 10 warmups puis 30 mesures conservées ;
- percentiles R7 et ratios calculés par paire avant médiane et p95 ;
- mesure des durées, débits, heaps, octets transférés et compteurs de
  matérialisation.

Commande de reproduction :

```bash
npm run bench:mlt-isolated -- --iterations 30 --warmup 10 \
  --output test/bench/results/mlt-current.json
npm run bench:mlt-check -- --report test/bench/results/mlt-current.json
```

## Ratios MLT/MVT appariés

| Scénario | Médiane | p95 |
| --- | ---: | ---: |
| Scan tuiles réelles | 0,080 | 0,095 |
| Décodage réel projeté | 0,233 | 0,367 |
| Parse-only réel | 0,763 | 0,875 |
| End-to-end réel | 0,692 | 0,825 |
| OMT bâtiments | 0,282 | 0,329 |
| OMT routes et labels | 0,930 | 1,066 |
| OMT labels low-zoom | 0,296 | 0,481 |
| Symboles points | 1,058 | 1,196 |
| Symboles lignes | 1,209 | 1,360 |
| Query rendered, 0 résultat | 0,975 | 1,095 |
| Query rendered, 1 résultat | 0,987 | 1,080 |
| Query rendered, 10 résultats | 0,966 | 1,079 |
| Query rendered, beaucoup de résultats | 1,193 | 1,289 |
| Query source, 1 % | 0,292 | 0,491 |
| Query source, 10 % | 0,562 | 0,788 |
| Query source, 100 % | 2,164 | 2,446 |

Depuis la baseline `d9864c80c`, le ratio médian de la query rendered à forte
cardinalité passe de 6,001 à 1,193 et celui de la query source à 100 % de 7,520
à 2,164. La forte sélectivité source reste la principale dette CPU mesurée.

## Matérialisations et cycle de vie

- parse et symboles : zéro fallback, wrapper, objet de propriétés, `Point` ou
  partie géométrique matérialisée ;
- toutes les queries MLT : zéro `MLTVectorTileFeature` et zéro objet de
  propriétés tant que l'application ne lit pas `properties` ;
- query rendered rejetée : aucune géométrie chargée ;
- feature-state : aucun wrapper, objet de propriétés, objet géométrique ou
  redécodage du raw tile ;
- overzoom : aucun wrapper, `Point`, `Point[][]` ni réencodage MVT ;
- cycle `load → query → feature-state → overzoom → reload` : 64 objets de
  propriétés pour 64 sorties publiques, zéro wrapper intermédiaire, heap et
  ArrayBuffers revenus à leur niveau initial après GC.

Le contrôle `bench:mlt-check` valide les 22 contrats de matérialisation ainsi
que tous les budgets mémoire et transfert. Cette campagne devient la référence
des optimisations suivantes.
