# Changements de style à chaud — 7 septembre 2026

## Résultat : couverture ajoutée, qualification logiciel encore en échec

Le parcours `--scenario styles --phase correctness` couvre maintenant `setStyle`
et les setters paint/layout/filter sur des sources MVT/MLT avec symboles et glyphes.
**25/25 checkpoints sont exactement conformes sur Iris Xe**, en production et
avec le worker strict. Les réponses GeoJSON, la durée de vie du feature-state et
les compteurs interdits passent également dans les deux campagnes logiciel.

**La qualification complète n'est pas verte** : SwiftShader présente un petit écart
au dernier checkpoint, après le retour du surzoom. Le premier passage diffère sur
38 pixels MVT/MLT, le second sur 19, avec un écart maximal d'un niveau par canal.
Le témoin MVT varie lui aussi au second passage. Aucune tolérance n'est augmentée,
aucune image attendue modifiée et aucun essai en échec écarté des conclusions.

Aucun changement produit dans ce lot : le diff `src/`, les trois bundles production
et le CSS ont les mêmes hashes que le [lot symboles](MLT_SYMBOLS_20260906.md).
GL JS reste à `cfb9f34ae` plus les corrections locales précédentes ; Tile Spec à
`1ec5c6b1`. Seuls le banc, ses preuves et la documentation sont étendus, sans commit/push.

## Parcours et contrats vérifiés

Les dix checkpoints du scénario symboles sont conservés, puis quinze sont ajoutés.
La caméra est contrôlée par API, les interactions désactivées, le canvas fixé à
800×600/DPR 1. Les assets, le corpus Berlin et le worker unique restent locaux.

| Opération | Contrôle attendu |
| --- | --- |
| `setPaintProperty`, `setLayoutProperty`, `setFilter` | Source identique, état conservé, changement visible |
| `setStyle` avec diff vers le même style alternatif | Même résultat que les setters directs, source et état conservés |
| Retour au style initial avec diff | Réponses et pixels de la sélection initiale restaurés |
| Changement des URL glyphs/sprite avec diff | Nouvelles requêtes effectives, source/état conservés, mêmes pixels |
| Reconstruction explicite `{diff: false}` | Nouvelle source, feature-state effacé |
| Remplacement de l'encodage vectoriel MVT↔MLT | Encodage effectif vérifié dans le style public, nouvelle source, état effacé |
| Style sans source puis réintroduction | Zéro résultat pendant l'absence, état vierge à la réintroduction |
| Style alternatif en surzoom puis restauration | Parité MVT/MLT, géométries et caméra conservées |

La variante change la couleur des routes, lit la nouvelle propriété `name_en` pour
les textes, agrandit les labels et réduit le rang POI admissible de 5 à 2. À la vue
initiale, le nombre de POI rendus passe de **87 à 61** et revient à 87 après restauration.
Les collisions restent actives ; les assertions ne se limitent pas à la présence d'une couche.

Les routes alternatives de glyphes/sprites servent les **mêmes octets** : elles
testent l'invalidation et le rechargement des ressources, pas une nouvelle police.
Les trois blocs PBF et les deux fichiers sprite sont effectivement redemandés.
L'identité des sources et leurs états sont vérifiés avec les API publiques, sans
inspection des champs privés du moteur.

Après les 25 captures, **cinq cycles supplémentaires** rejouent chacun diff,
restauration, reconstruction, changement d'encodage et restauration. Chaque étape
compare les signatures GeoJSON complètes à un checkpoint de référence. Cela donne
**37 étapes de mutation par session**, dont 25 dans les répétitions. Les répétitions
n'ajoutent pas de screenshots et ne constituent pas une mesure de performance/mémoire.

## Validation et limite reproductible

- Production Iris Xe : 25/25 checkpoints exacts, code 0.
- Worker strict Iris Xe : 25/25 checkpoints exacts, code 0.
- Worker strict SwiftShader : 25/25 réponses GeoJSON exactes, **24/25 comparaisons
  d'image exactes**, code 1. Même checkpoint en échec au rejeu isolé, code 1.
- **320/320 unitaires ciblés** : styles, feature-state, glyph manager, symbol buckets
  et géométrie columnar des symboles ; code 0.
- Régression du banc : scénario symboles **10/10**, scénario de base **7/7**, codes 0.
- Builds production/strict, typecheck et lint réussis ; aucun changement de bundle.

Les premières campagnes production/GPU strict/logiciel ont tourné en parallèle,
uniquement pour la conformité. Le logiciel a ensuite été rejoué seul, sans modifier
le banc ni ses seuils. Le défaut de restauration est reproduit, mais les pixels
concernés ne sont pas identiques entre passages :

| Comparaison au checkpoint `style-final` | Logiciel 1 | Logiciel 2, isolé |
| --- | ---: | ---: |
| MVT contre MLT | 38 pixels | 19 pixels |
| MVT final contre MVT initial | 0 | 38 pixels |
| MLT final contre MLT initial | 38 pixels | 19 pixels |
| Écart maximal de canal | 1 | 1 |

Les images font 480 000 pixels. Ces faibles écarts restent des **échecs** du critère
exact. Ils apparaissent après la séquence style alternatif en surzoom → restauration
du style → retour à la vue initiale ; les réponses et les métadonnées de caméra
contrôlées restent identiques. Le même type d'écart côté MVT interdit de conclure
à une régression propre à MLT. Une différence de précision de rendu est une
hypothèse, pas une cause démontrée ; aucun correctif produit n'est appliqué sans isolation.

Les dix compteurs worker interdits et `propertyProxyMisses` sont présents et nuls
à chaque relevé. Les sessions démarrées en MVT passent temporairement en MLT :
elles **ne sont pas des témoins purement MVT** pour les compteurs. Les totaux sont
identiques entre les campagnes strictes aux mêmes étapes :

| Session démarrée en… | Couches MLT décodées | Colonnes | Features découpées en surzoom | Octets cumulés de copies brutes |
| --- | ---: | ---: | ---: | ---: |
| MVT, puis passages MLT | 144 | 576 | 0 | 6 332 958 |
| MLT, puis passages MVT | 604 | 2 827 | 15 102 | 21 349 965 |

Ces volumes cumulés ne mesurent pas la mémoire retenue. La contrainte de
non-matérialisation vise les frontières instrumentées du worker ; le GeoJSON demandé
par l'API publique est toujours volontairement matérialisé côté main thread.

La suite complète n'est pas relancée pour ce changement de banc. Son dernier état
reste celui du lot intersections : 3 728 unitaires, 750 builds, 178 intégrations,
243 rendus MLT stricts logiciel ; **1 887/1 923 rendus GPU**, 36 échecs connus.
Le nouvel écart SwiftShader ci-dessus reste distinct de ces échecs historiques.

## Preuves, commandes et suite

- [Production](browser-styles-production-20260907/results.json),
  [GPU strict](browser-styles-strict-gpu-20260907/results.json).
- [Logiciel en échec](browser-styles-strict-software-20260907/results.json),
  [rejeu logiciel isolé en échec](browser-styles-strict-software-repeat-20260907/results.json).
- [Vérification indépendante](browser-styles-production-20260907/validation.json) :
  signatures recalculées depuis les GeoJSON, PNG comparés, vérification des ressources,
  états, mutations et compteurs. Son statut est **`render-differences` et son code 1**.
  Les 200 PNG et 200 réponses des quatre campagnes sont conservés, ainsi que les
  rapports unité/base/symboles et les sources du banc compressés.

```bash
npm run build-prod
BUILD=production npx rolldown -c rolldown.config.mlt-validation.ts
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-lifecycle.ts --scenario styles --phase correctness \
  --style-cycles 5 --output <nouveau-dossier-production>
# Ajouter --strict pour le worker instrumenté ; utiliser PUPPETEER_GPU=software pour SwiftShader.
```

Le vérificateur rejette les différences par défaut. Son option
`--record-render-failures` permet d'archiver leur diagnostic tout en **gardant le
code d'échec**, sans introduire de tolérance. Un septième argument de chemin permet
d'inclure un second relevé logiciel.

**Suite prioritaire : réduire le cas SwiftShader à un petit scénario de retour de
caméra après changement de style, avec témoin MVT**, puis isoler la couche ou l'état
de rendu responsable. Ne pas élargir une affirmation de parité exacte au globe/terrain
tant que cet écart n'est pas expliqué. Styles chargés par URL, `transformStyle`,
`setStyle(null)`, nouvelles polices/RTL et globe/terrain restent hors de ce parcours.
