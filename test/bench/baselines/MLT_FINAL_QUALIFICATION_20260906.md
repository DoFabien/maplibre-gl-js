# Qualification du snapshot final MLT — 6 septembre 2026

**Lot terminé sans changement fonctionnel produit. Trois campagnes complètes :
les budgets restent en échec (5, 7 et 12 dépassements), sans modification des
seuils. Le heap absolu est dominé par le banc Vite ; les cycles prolongés se
stabilisent. Le coût géométrique étudié appartient à l'adaptateur public,
pas au chemin worker sans matérialisation.**

## Résultat des trois campagnes officielles

Chaque rapport contient 168 cas, 75 paires, 30 mesures et 10 warmups. Les
distributions ont été recalculées depuis les échantillons bruts. Les **143
compteurs exigés à zéro sont explicitement présents et nuls** dans les trois
rapports ; les autres contrôles de compteurs, volumes et nombres de sorties passent.

| Charge | Ratio médian MLT/MVT C1 | C2 | C3 | p95 des ratios : min–max des campagnes |
| --- | ---: | ---: | ---: | ---: |
| Décodage projeté réel | 0,225 | 0,232 | 0,247 | 0,334–0,345 |
| Pipeline worker complet réel | 0,647 | 0,658 | 0,652 | 0,730–0,765 |
| Symboles linéaires OMT | 0,913 | 0,874 | 0,885 | 0,990–1,167 |
| Adaptateur public, géométrie | 1,025 | 1,062 | 1,063 | 1,265–1,639 |
| Adaptateur public, énumération des propriétés | 1,567 | 1,609 | 1,623 | 1,872–2,270 |
| Query source, 10 000 résultats JSON | 1,005 | 1,000 | 1,010 | 1,123–1,250 |
| Query source, 10 000 résultats, une propriété | 2,168 | 2,197 | 2,161 | 2,341–2,397 |

Le gain worker est maintenu à environ **35 %** dans ce corpus. Les médianes
JSON source sont 28,99 / 36,75 / 36,07 ms par requête, contre 29,08 / 36,71 /
35,29 ms en MVT. Les deux côtés varient en durée absolue : ne pas transformer
la différence avec les 31,31 ms du précédent lot en gain ou régression isolée.
La quasi-parité médiane ne signifie pas une parité au p95. La lecture d'une seule
propriété reste environ 2,2 fois plus coûteuse que MVT sur ce scénario.

Les codes des trois contrôles de budgets valent **1**. Les logs intégraux sont
archivés ; les catégories en échec sont :

- C1, cinq seuils : énumération des propriétés, Bing (deux), symboles linéaires
  denses et heap de rechargement.
- C2, sept seuils : énumération des propriétés, géométrie publique, Bing,
  query source à 1 %, query source à 10 000 résultats (deux), heap de rechargement.
- C3, douze seuils : énumération des propriétés (trois), OMT bâtiments, Bing
  (deux), symboles linéaires clairsemés, quatre seuils de requêtes courtes et heap.

La géométrie échoue seulement en C2, avec un quotient des p95 de **1,426**
contre le plafond **1,35** ; C1 et C3 donnent 0,850 et 1,287. Aucun changement
de code géométrique n'est inclus dans ce lot, et l'adaptateur ainsi que
`geometry_traversal.ts` sont identiques à la référence historique `a236ec257`.
Le passage de deux contrôles ne démontre donc pas une correction de ce coût.

## Mémoire : ce que dit la campagne officielle

Les Mo ci-dessous sont décimaux. Le heap initial est déjà **80,775–80,779 Mo**,
au-dessus du plafond de rechargement de **77 Mo**. Le p95 de rechargement vaut
**81,449–81,455 Mo**. Le delta de heap conservé après GC, entre le début et la
fin des 30 mesures, est **177 456 / 197 192 / 185 728 octets**.

Les volumes du cycle sont constants sur les trois campagnes : **217 632 octets
transférés**, **93 966 octets de buffers explicitement comptés**. Ce dernier
compteur n'est pas une estimation de tout le heap. Les ArrayBuffers reviennent
à leur valeur initiale de 854 349 octets après GC dans chaque processus.

Le dépassement absolu reste un échec du budget. Il ne suffit pas à démontrer
une fuite : le runner, ses modules et leur compilation font partie du heap.
Les mesures complémentaires ci-dessous cherchent à distinguer ce coût fixe
d'une accumulation au fil des cycles.

### Même scénario, deux modes de chargement

Le diagnostic de 100 cycles compare le runner chargé par Vite à un bundle Node
sans tree-shaking ni minification. Les métriques fonctionnelles restent celles
du même benchmark ; ce contrôle ne remplace pas le budget officiel.

| Heap après GC, Mo | Vite | Bundle Node |
| --- | ---: | ---: |
| Avant import du registre de benchmarks | 44,30 | 4,79 |
| Après import du registre | 78,46 | 8,15 |
| Après 10 warmups | 80,44 | 10,08 |
| Après 100 cycles | 80,70 | 10,33 |
| Après libération de l'instance | 80,61 | 10,24 |

L'instance de benchmark est effectivement collectée dans les deux cas, vérifiée
par `WeakRef`. Les ArrayBuffers reviennent exactement à leur niveau d'avant
setup après libération : 774 023 octets sous Vite et 148 227 dans le bundle.
L'écart d'environ **70 Mo** entre les deux modes montre la dépendance du heap
absolu au chargeur et à la représentation des modules. Ce n'est pas un gain
mémoire nouveau dans le navigateur produit.

Les 100 premiers cycles gardent une petite hausse de heap : environ 775–783
octets par cycle sur leur dernière moitié. Le prolongement à 1 000 cycles
montre ensuite une stabilisation :

| Heap médian après GC, Mo | Vite | Bundle Node |
| --- | ---: | ---: |
| Cycles 701–800 | 81,266 | 10,815 |
| Cycles 801–900 | 81,250 | 10,789 |
| Cycles 901–1 000 | 81,259 | 10,789 |
| Après libération, valeur finale | 80,962 | 10,497 |

Les ArrayBuffers sont constants pendant ces 300 derniers cycles dans chaque
mode, puis reviennent au niveau pré-setup. Les **1 000 cycles** conservent
chacun 64 résultats, 217 632 octets transférés et 93 966 octets de buffers
comptés. Aucun empilement continu n'est observé sur la fin de ce scénario.
Cela ne démontre pas l'absence de toute fuite, ni celle de fuites dans une carte
réelle, les caches GPU ou d'autres opérations.

Les différences après setup incluent les caches et la compilation, pas seulement
les tuiles. Le heap baisse aussi à la sortie de la boucle : V8 peut collecter les
objets devenus inutiles avant l'affectation explicite qui libère l'instance.
Les échantillons numériques ont été préalloués avant la mesure ; les tableaux
JSON du rapport sont construits après les snapshots finaux.

### Diagnostic géométrie

Le profil CPU MLT, 100 itérations après 10 warmups, donne en **temps propres** :
`loadFeatureGeometry` 31,61 %, décodage varint 64 bits 9,42 %, construction de
`MLTVectorTileFeature` 5,50 %, varint 32 bits 4,15 %, GC 3,22 %.
Ce sont des échantillons CPU exclusifs, pas des durées imbriquées. Le coût du
profilage lui-même est conservé dans le dénominateur ; les lignes des profils
renvoient au code transformé par Vite, pas nécessairement aux lignes TS originales.

Le benchmark géométrie décode par défaut **443 colonnes** alors qu'il ne lit
pas les propriétés. Trois comparaisons diagnostiques MLT/MLT, avec 100 warmups
et 100 mesures alternées, isolent l'option existante `deferPropertyColumns: true` :

| Configuration, ms pour quatre tuiles | Essai 1 | Essai 2 | Essai 3 |
| --- | ---: | ---: | ---: |
| Adaptateur par défaut, médiane | 39,85 | 38,65 | 38,40 |
| Option différée, médiane | 31,45 | 30,30 | 29,46 |
| Médiane des ratios différé/défaut | 0,786 | 0,785 | 0,764 |
| p95 des ratios différé/défaut | 1,080 | 1,168 | 1,114 |

L'option réduit le nombre de colonnes décodées à **130** et les octets de
colonnes comptés de **2 457 682 à 1 316 732**, sans changer les **26 096
features**, **26 311 parties** et **82 647 objets Point** produits par échantillon.
L'égalité des géométries est vérifiée pour toutes les features, hors chronométrage.
Les compteurs sont collectés séparément après les mesures.

Le gain médian de **21–24 %** concerne cette configuration d'adaptateur : les
requêtes réelles utilisent **déjà** le décodage différé dans
`FeatureIndex.loadVTLayers()`. Il ne s'agit ni d'une optimisation nouvelle de
la carte, ni d'un passage vert du budget géométrie historique. Les Point ici sont
des sorties publiques demandées explicitement, pas une matérialisation worker.
Les p95 des ratios dépassent encore 1 dans ces essais ; le gain n'est pas uniforme
sur chaque échantillon. La cause précise de toute la variabilité des p95 reste à
isoler : ces profils ne suffisent pas à attribuer chaque écart au GC ou au JIT.

## Décisions et suite

1. Conserver les échecs des budgets actuels. Le seuil absolu de 77 Mo doit être
   complété par un contrôle de rétention en fin de cycle et de volumes, avec une
   référence de chargeur explicite ; le bundle Node n'est pas une exemption.
2. Qualifier maintenant un scénario navigateur MVT/MLT avec déplacements/zooms,
   requêtes, feature-state et retrait/rechargement des sources. Cette mesure
   doit porter sur le build produit et couvrir mémoire, fluidité et transferts.
3. Séparer, dans les futures mesures, l'adaptateur public par défaut et le
   chemin public différé réellement utilisé par la carte. Le commentaire
   trompeur du benchmark a été corrigé **après** les mesures, sans changer sa logique.
4. Pour les optimisations suivantes, garder en vue la lecture partielle des
   propriétés et la conversion géométrique publique, sans réintroduire de
   matérialisation worker. Les écarts Bing et de requêtes courtes restent suivis.

Les contrôles TypeScript et lint des nouveaux outils passent. Les scripts
`analyze.mjs` et `analyze-diagnostics.mjs` vérifient les échantillons, métadonnées,
volumes et égalités attendues avant de produire leurs résumés. Aucun seuil,
image de référence ou code fonctionnel produit n'a été modifié ; rien n'est poussé.

## Périmètre et protocole

Snapshot GL JS `cfb9f34ae`, branche `restack/mlt-feature-state-native` ; MLT
`1ec5c6b144c8ed5eca580c2ba406f323f240e45c`, via la dépendance locale
`file:../maplibre-tile-spec/ts`. Node **26.7.0**, V8 **14.6.202.34-node.28**,
Intel Core i7-1260P, Linux. `NODE_OPTIONS` n'est pas défini.

Trois campagnes complètes successives : 168 cas isolés et 75 comparaisons
appariées par campagne, 10 warmups et 30 mesures, ordre MVT/MLT alterné,
percentiles R7. La configuration historique `mlt-budgets.json` et sa référence
`mlt-next-observability-a236ec257.json` ne sont pas modifiées.

Les applications de bureau restent ouvertes : il ne s'agit pas d'une machine
dédiée. Aucun autre test lourd ni profil n'est lancé pendant les campagnes.
Les nouveaux outils de diagnostic ne sont pas importés par le runner mesuré.
Les artefacts non suivis préexistants sont conservés et expliquent notamment
`worktreeDirty: true` ; ce champ ne signifie pas que les sources produit ont changé.

Les [archives](./final-cfb9f34ae/) conservent les rapports bruts, les contrôles de
budgets et les analyses. `analyze.mjs` recalcule les distributions depuis les
échantillons et exige la présence explicite des compteurs attendus à zéro.
Son code de sortie indique la validité de l'analyse, pas le succès des budgets :
les codes de chaque contrôle figurent dans `analysis.json`.

## Commandes de reproduction

Depuis la racine GL JS, avec Node 26.7.0 actif, choisir un nouveau dossier de résultats :

```bash
npm run bench:mlt-campaigns -- --campaigns 3 --iterations 30 --warmup 10 \
  --suite extended --skip-check --output-dir <nouveau-dossier>
npm run bench:mlt-check -- --report <nouveau-dossier>/campaign-1.json
npm run bench:mlt-check -- --report <nouveau-dossier>/campaign-2.json
npm run bench:mlt-check -- --report <nouveau-dossier>/campaign-3.json
```

`--skip-check` permet de conserver les trois campagnes en cas de dépassement ;
il ne dispense pas des trois contrôles séparés.

Diagnostics complémentaires, après la collecte et avec des chemins de sortie nouveaux :

```bash
node --expose-gc node_modules/vite-node/dist/cli.mjs test/bench/run-mlt-diagnostics.ts \
  memory MltMemoryLifecycleMLT <nouveau-rapport-memoire.json> 100
node --expose-gc node_modules/vite-node/dist/cli.mjs test/bench/run-mlt-diagnostics.ts \
  profile MltRealTileDecodeGeometryMLT <nouveau-profil-mlt.json> 100
node --expose-gc node_modules/vite-node/dist/cli.mjs test/bench/run-mlt-diagnostics.ts \
  profile MltRealTileDecodeGeometryMVT <nouveau-profil-mvt.json> 100
node --expose-gc node_modules/vite-node/dist/cli.mjs test/bench/run-mlt-diagnostics.ts \
  geometry MltRealTileDecodeGeometryMLT <nouveau-rapport-geometrie.json> 100
node test/bench/build-mlt-diagnostics.mjs <nouveau-dossier-bundle>
node --expose-gc <nouveau-dossier-bundle>/diagnostics.mjs \
  memory MltMemoryLifecycleMLT <nouveau-rapport-memoire-bundle.json> 100
```

Le diagnostic mémoire prend deux GC explicites après retour à la boucle
d'événements et préalloue ses buffers de mesures ; il distingue le heap pendant
le cycle, après son retour et après libération de l'instance de benchmark.
Pour reproduire le prolongement, remplacer le dernier argument `100` par
`1000` dans les deux commandes mémoire, avec de nouveaux chemins JSON.
Le bundle Node conserve le même scénario, sans Vite, sans minification ni
tree-shaking ; ce n'est **pas** le build navigateur produit.

Le diagnostic géométrie compare l'adaptateur MLT par défaut à l'option existante
`deferPropertyColumns: true`, après 100 warmups. Il vérifie l'égalité des
géométries hors chronométrage. Les vraies requêtes utilisent déjà cette option
dans `FeatureIndex.loadVTLayers()` ; ce test ne mesure donc pas un nouveau gain
pour `queryRenderedFeatures`. Il ne remplace pas les campagnes officielles.

## Limites de cette qualification

- La matrice étendue existante tourne sur le code final, mais n'ajoute pas de
  workload de performance spécifique à la heatmap ou aux nouveaux filtres.
- Les profils CPU modifient les conditions de chronométrage ; leurs temps
  servent à localiser les coûts, pas à annoncer un gain de performance produit.
- La mémoire mesurée est celle de Node, pas celle d'une carte dans Chrome ;
  les cycles ne couvrent ni les caches GPU ni toutes les opérations dynamiques.
- Les tests navigateur d'interactions, la suite render/GPU et les tests unitaires
  produit ne sont pas rejoués dans ce lot de mesure sans modification produit.
  Leur état précédent reste documenté dans [MLT_VALIDATION.md](../../integration/MLT_VALIDATION.md).
