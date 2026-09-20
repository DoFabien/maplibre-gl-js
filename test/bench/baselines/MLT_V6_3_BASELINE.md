# Baseline MLT — MapLibre GL JS 6.3

Cette baseline mesure le commit `ffb19ff3e37aed79c06326592ad2247667cca351` avec Node 24.14.0 sur un Intel Core i7-1260P. Chaque cas s'exécute dans un processus isolé, avec 5 warmups et 20 itérations.

Commande :

```bash
npm run bench:mlt-isolated -- --iterations 20 --warmup 5
```

Résultats complets : [`mlt-v6.3-ffb19ff3e.json`](./mlt-v6.3-ffb19ff3e.json).

| Phase | MVT médiane / p95 | MLT médiane / p95 | Ratio médiane MLT/MVT | Heap max MVT / MLT |
| --- | ---: | ---: | ---: | ---: |
| Scan | 2,720 / 3,952 ms | 0,187 / 0,244 ms | 0,07 | 125,8 / 72,8 Mio |
| Decode projeté | 2,723 / 3,558 ms | 1,132 / 2,554 ms | 0,42 | 125,6 / 94,7 Mio |
| Parse-only | 7,574 / 13,793 ms | 6,082 / 9,285 ms | 0,80 | 128,7 / 129,8 Mio |
| End-to-end | 11,569 / 17,495 ms | 8,666 / 14,354 ms | 0,75 | 127,5 / 130,5 Mio |

Le decode et l'end-to-end MLT projettent quatre layers, soit 24 colonnes, 14 610 valeurs logiques et environ 188 137 octets de buffers décodés par itération. Le chemin natif mesuré ne crée aucun wrapper, objet de propriétés, `Point` ou fallback worker.

## Lecture

- Le « scan » MLT ne force aucun getter de layer ; il mesure uniquement l'indexation des blocs. Le constructeur MVT fait davantage de travail immédiatement, donc ce ratio ne représente pas à lui seul un gain fonctionnel de format.
- Le parse MLT réduit la médiane d'environ 20 %, mais son pic mémoire est encore équivalent à MVT : les prochains commits doivent cibler la topologie, les buffers temporaires et les symboles.
- L'end-to-end réduit la médiane d'environ 25 %, mais la p95 et la mémoire restent les gardes principales.
- Le corpus courant est limité aux quatre tuiles réelles `14-8802-5374` à `14-8803-5375` et au style `road`. Les matrices 5/50/200 colonnes, queries, `feature-state`, overzoom et symboles lignes doivent compléter cette baseline avant d'établir des seuils CI définitifs.

## Baseline des queries avant chemin columnar

Les queries ont été mesurées au commit `42779c48be446b5dfd62eddb5657bf39780faa16`, après suppression du fallback worker. Le corpus synthétique contient 640 points. Chaque cas s'exécute dans un processus isolé avec 3 warmups et 10 itérations :

```bash
npm run bench:mlt-isolated -- --iterations 10 --warmup 3 \
  MltQueryRendered0MVT MltQueryRendered0MLT \
  MltQueryRendered1MVT MltQueryRendered1MLT \
  MltQueryRendered10MVT MltQueryRendered10MLT \
  MltQueryRenderedManyMVT MltQueryRenderedManyMLT \
  MltQuerySource1PctMVT MltQuerySource1PctMLT \
  MltQuerySource10PctMVT MltQuerySource10PctMLT \
  MltQuerySource100PctMVT MltQuerySource100PctMLT
```

Résultats complets : [`mlt-query-v6.3-42779c48b.json`](./mlt-query-v6.3-42779c48b.json).

| Query | Résultats | MVT médiane / p95 | MLT médiane / p95 | Ratio médiane MLT/MVT | Wrappers MLT / itération |
| --- | ---: | ---: | ---: | ---: | ---: |
| Rendered 0 | 0 | 0,591 / 0,729 ms | 1,754 / 2,062 ms | 2,97 | 640 |
| Rendered 1 | 1 | 0,696 / 0,938 ms | 2,018 / 2,460 ms | 2,90 | 640 |
| Rendered 10 | 10 | 0,727 / 0,943 ms | 1,871 / 2,511 ms | 2,57 | 640 |
| Rendered many | 640 | 1,240 / 1,474 ms | 4,014 / 4,976 ms | 3,24 | 640 |
| Source 1 % | 6 | 0,389 / 0,562 ms | 1,700 / 1,969 ms | 4,37 | 640 |
| Source 10 % | 64 | 0,346 / 0,513 ms | 1,947 / 2,292 ms | 5,63 | 640 |
| Source 100 % | 640 | 0,201 / 0,237 ms | 2,406 / 2,988 ms | 11,95 | 640 |

Cette baseline rend le défaut résiduel explicite : les deux APIs MLT créent actuellement 640 wrappers et 640 objets de propriétés, indépendamment de la sélectivité. `queryRenderedFeatures` ne charge en revanche la géométrie qu'après le filtre : 0, 1, 10 puis 640 géométries pour les quatre cas. La cible du Lot 2 est donc de conserver cette propriété tout en faisant tomber les wrappers intermédiaires à zéro et les objets de sortie au nombre exact de résultats.
