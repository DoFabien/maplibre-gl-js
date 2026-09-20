# MLT — mesures post-merge du 6 septembre 2026

## État de la campagne

**Trois campagnes initiales et trois campagnes ciblées après optimisation terminées. L'extension ultérieure des filtres et de la heatmap est validée séparément dans [MLT_VALIDATION.md](../../integration/MLT_VALIDATION.md).**

Le snapshot final `cfb9f34ae` a depuis fait l'objet de trois nouvelles campagnes
complètes et d'un diagnostic mémoire/géométrie : voir la
[qualification finale](./MLT_FINAL_QUALIFICATION_20260906.md).
Les chiffres ci-dessous restent ceux des snapshots historiques indiqués.

Pour la référence initiale, le code produit GL JS est figé au commit `ff84d746697d772efab8f07e4a55f59ab5c2072c`
sur `restack/mlt-feature-state-native`, après consolidation du merge `e1ce7e58c3`
qui intègre l'upstream `32e555b2c1`. Le dépôt voisin MLT est sur
`mlt-columnar/tile-spec-minimal`, commit `1ec5c6b1` ; la dépendance est
`file:../maplibre-tile-spec/ts`.

Node **26.7.0**, Intel Core i7-1260P, Linux. Le Node 24 de la session n'est pas
utilisé pour ces mesures : Node 26.7.0 est aussi le runtime exact de la référence
historique `mlt-next-observability-a236ec257.json`.

Les anciens artefacts non suivis ont été conservés ; les rapports indiquent donc
`worktreeDirty: true`. Les modifications de documentation et les tests préparés
pendant cette campagne ne changent ni les sources mesurées ni le runner ; les
fichiers de test ne sont pas importés par les benchmarks. Ne pas déduire un checkout vierge
du seul SHA enregistré dans les rapports.

## Protocole reproductible

Depuis la racine GL JS, avec Node 26.7.0 actif :

```bash
npm run bench:mlt-campaigns -- --campaigns 3 --iterations 30 --warmup 10 \
  --suite extended --skip-check \
  --output-dir test/bench/results/mlt-post-merge-ff84d7466-node26
```

Chaque campagne exécute 168 cas isolés et 75 paires MVT/MLT dans des processus
dédiés. Les paires alternent leur ordre d'exécution. Les percentiles utilisent
l'interpolation R7 ; le ratio médian est la médiane des 30 ratios appariés,
pas le quotient de deux médianes indépendantes.

Les budgets ne sont pas modifiés. `--skip-check` permet de collecter les trois
campagnes même en cas d'échec ; chaque rapport doit ensuite subir le contrôle
complet `npm run bench:mlt-check -- --report <rapport>`.

Deux démarrages préliminaires sous Node 24 ont été interrompus avant de produire
un rapport complet et ne font pas partie des résultats. Un navigateur de tests
headless orphelin, identifié dans ce checkout et consommant près de huit cœurs,
a été arrêté avant le lancement sous Node 26. Les applications de bureau de
l'utilisateur restent ouvertes ; il ne s'agit pas d'une machine dédiée.

## Référence initiale — trois campagnes

Les trois rapports bruts sont archivés dans [post-merge-ff84d7466](./post-merge-ff84d7466/) :
[campagne 1](./post-merge-ff84d7466/campaign-1.json),
[campagne 2](./post-merge-ff84d7466/campaign-2.json),
[campagne 3](./post-merge-ff84d7466/campaign-3.json).
Chaque ligne ci-dessous conserve les trois ratios médians ; la dernière colonne
donne l'intervalle entre les p95 des ratios des campagnes, pas un p95 agrégé.
Toutes les distributions publiées ont été recalculées depuis les échantillons
bruts, et le nombre d'opérations par paire a été contrôlé.

| Charge | Médiane C1 | Médiane C2 | Médiane C3 | p95 : min–max |
| --- | ---: | ---: | ---: | ---: |
| Décodage projeté, corpus réel | 0,228 | 0,230 | 0,230 | 0,337–0,358 |
| Parse worker, routes réelles | 0,712 | 0,738 | 0,729 | 0,827–0,847 |
| Pipeline worker complet, corpus réel | 0,653 | 0,642 | 0,642 | 0,726–0,734 |
| Symboles linéaires OMT | 0,878 | 0,909 | 0,890 | 0,916–0,989 |
| Query source, 10 000 sorties non lues | 0,312 | 0,326 | 0,277 | 0,319–0,340 |
| Query rendered, 10 000 sorties, intersection réelle | 0,834 | 0,857 | 0,829 | 0,889–0,920 |
| Query source, 10 000 sorties sérialisées JSON | 2,615 | 2,684 | 2,683 | 2,680–2,858 |
| Query rendered, 10 000 sorties JSON, intersection simulée | 2,200 | 2,229 | 2,255 | 2,350–2,466 |

La sérialisation complète de 10 000 résultats source prend environ 87,15 ms par
requête en MLT contre 33,74 ms en MVT. Elle produit 100 000 descripteurs de
propriétés par requête, soit 200 000 par échantillon de deux requêtes. Le surcoût
source JSON reste compris entre 53,41 et 54,64 ms par requête sur les trois
passages. Il constitue la première cible d'optimisation retenue.
Ces objets sont des sorties publiques demandées explicitement ; ils ne sont
pas des matérialisations cachées du chemin de rendu worker.

### Budgets : aucun passage entièrement vert

Les sorties intégrales des contrôles inchangés sont archivées à côté des rapports
(`campaign-1-budget.log`, `campaign-2-budget.log`, `campaign-3-budget.log`).
Les trois commandes se terminent avec le code **1**, respectivement pour **4,
5 et 13 violations de seuils**. Plusieurs seuils peuvent concerner un même cas.

La campagne 1 échoue sur quatre budgets :

- Énumération des propriétés réelles : ratio médian 1,665 contre plafond 1,6.
- Géométrie publique réelle : quotient des p95 MLT/MVT 1,646 contre plafond 1,35.
- Query source à 1 % : p95 des ratios 0,151589 contre budget historique 0,128039.
- Cycle mémoire, heap au rechargement : p95 81 396 532 octets contre 77 000 000.

Les invariants de matérialisation contrôlés passent dans les trois campagnes.
Une vérification supplémentaire confirme 143 compteurs attendus à zéro présents
explicitement dans chaque rapport, répartis sur 38 scénarios : un compteur absent
n'a pas été assimilé à zéro. Pour le cycle mémoire de la première campagne,
le heap initial vaut déjà 80 731 400 octets, contre 75 869 024 dans la référence
historique. Le heap conservé après GC augmente de 176 384 octets au cours du
cycle, contre 150 712 historiquement. Le dépassement absolu ne démontre donc
pas à lui seul une fuite ; il reste un échec du budget, non exempté.

Les transferts du cycle valent 217 632 octets, comme dans la référence ; les
buffers conservés explicitement par le scénario passent de 93 246 à 93 966
octets. Les heap/RSS du processus comprennent le runner et les modules chargés.

La campagne 2 confirme les observations principales : ratio médian worker complet
0,642 ; source 10 000 résultats JSON 2,684 (85,64 ms MLT contre 32,02 ms MVT) ;
rendered 10 000 résultats JSON 2,229. Le contrôle échoue cette fois sur cinq
budgets : géométrie publique p95 absolu (1,530), Bing décodage complet médiane
et p95 normalisés (0,642777 et 0,711890), accès complet pseudo-aléatoire p95
(2,217), et heap au rechargement (81 422 447 octets). Les invariants de
matérialisation passent à nouveau. Ces différences de dépassements entre
campagnes interdisent de sélectionner uniquement les passages favorables.

La campagne 3 échoue sur cinq seuils de géométrie publique, trois seuils de
requêtes courtes, quatre seuils d'accès complet inversé, et le heap au
rechargement (81 393 031 octets). La géométrie publique et le heap absolu
dépassent un plafond sur les trois passages.

Le ratio Bing de la campagne 2 doit être interprété avec ses durées brutes : la
médiane MLT reste proche de celle de la campagne 1 (183,90 contre 187,30 ms par
échantillon), mais la médiane MVT passe de 792,38 à 289,06 ms. Les six premiers
échantillons MVT de la campagne 2 sont plus lents que les suivants. Une transition
JIT est une hypothèse non confirmée ; le contrôle reste en échec et ces données
ne démontrent pas un ralentissement MLT.

## Optimisation du coût confirmé

Un profil CPU de `MltQuerySource100Pct10000JsonMLT`, avec 10 warmups exclus du
profil puis 100 itérations, attribue 16,42 % du temps propre à
`createColumnarPropertiesFromColumns`, 12,39 % aux getters de chaque propriété,
9,05 % au getter de l'objet `properties`, et 8,90 % au ramasse-miettes. Les
pourcentages sont des temps propres, regroupés par fonction, non des durées
imbriquées à additionner avec leurs parents.

La modification prépare les colonnes une seule fois par `FeatureTable` via un
`WeakMap`, puis crée les valeurs de propriétés uniquement lors de l'accès
public à `.properties`. Elle ne partage aucun objet de valeurs entre sorties.
Les noms particuliers comme `__proto__` restent des propriétés propres,
énumérables et modifiables. Aucun changement de géométrie n'est inclus.

Le nouveau test a été exécuté avant modification (un échec attendu), puis les
65 tests ciblés de propriétés/requêtes passent après modification. Typecheck et
lint des sources concernées passent. L'optimisation est isolée dans le commit
`babea70db5ebe8b21f85739684d58b312f5e29a0`, mesuré sans autre modification produit.

### Avant/après — trois répétitions ciblées

Les [rapports bruts et le comparatif détaillé](./public-properties-babea70db/)
couvrent chacun 40 cas et 20 paires : source/rendered, 640/10 000 sorties,
sans lecture, lecture d'une propriété, énumération, géométrie et JSON.
Le protocole reste Node 26.7.0, 10 warmups et 30 mesures, processus isolés et ordre
MVT/MLT alterné. Les cas « sans lecture, 640 sorties » portent les noms historiques
`MltQuerySource100Pct` et `MltQueryRenderedMany`, sans suffixe `640None`.

Les durées ci-dessous sont les médianes des trois médianes par requête ; les p95
sont les médianes des trois p95, pas un percentile calculé en mélangeant les séries.
Les ratios MLT/MVT sont calculés à partir des échantillons appariés.

| 10 000 sorties | MLT avant, ms | MLT après, ms | Gain | p95 avant → après, ms | Ratio médian MLT/MVT avant → après |
| --- | ---: | ---: | ---: | ---: | ---: |
| Source, JSON | 86,40 | 31,31 | 63,8 % | 91,52 → 41,96 | 2,683 → 0,986 |
| Rendered, JSON, intersection simulée | 96,49 | 43,01 | 55,4 % | 113,30 → 49,32 | 2,229 → 0,979 |
| Source, toutes les propriétés | 61,17 | 18,87 | 69,2 % | 64,81 → 19,98 | 3,983 → 1,339 |
| Rendered, toutes les propriétés, intersection simulée | 68,00 | 26,85 | 60,5 % | 72,80 → 32,13 | 2,842 → 1,123 |
| Source, une propriété | 32,61 | 14,73 | 54,8 % | Voir rapport brut | 4,213 → 2,182 |

Les trois médianes source JSON après modification sont 31,31 / 31,31 / 32,08 ms ;
les témoins MVT restent entre 31,70 et 31,97 ms. Pour le même scénario, les p95
des ratios restent entre 1,185 et 1,246 : la quasi-parité médiane ne signifie pas
une égalité dans la queue de distribution. La lecture d'une seule propriété
reste un coût à améliorer, malgré le gain obtenu.

À 640 sorties, les gains JSON sont de 65,0 % en source et 59,1 % en rendered.
Les modes sans lecture et géométrie seule sont stables à environ ±1 % en médiane
des campagnes, sauf rendered 10 000 sorties non lues, amélioré de 4,3 %.
Aucun gain de géométrie n'est attribué à cette optimisation de propriétés.

### Allocations et mémoire

Les compteurs sont contrôlés explicitement pour les 20 cas MLT et les trois
campagnes. Les nombres de résultats, objets publics demandés et géométries
produites restent identiques. Les descripteurs de propriétés passent de
100 000 à **0 par requête source JSON de 10 000 résultats** ; les sorties non
lues conservent zéro objet de propriétés, zéro Point et zéro partie matérialisée.
Les compteurs de fallback worker, wrappers, copies/décodages de tuile brute,
réencodage MVT, tuples et accès proxy manqués restent à zéro. Ces scénarios de
query n'effectuent aucun transfert worker : le cycle de transferts complet
de la référence initiale n'est pas re-mesuré par ce sous-ensemble.

Pour source JSON, la médiane des maximums de heap observés passe de **363,07 à
101,06 Mo** et celle des maximums RSS de **718,12 à 492,81 Mo** (Mo décimaux).
Le gain est nettement plus faible en rendered JSON : heap 390,62 → 337,56 Mo.
Le heap conservé après GC en source JSON monte de 78,33 à 80,02 Mo : les mesures
montrent surtout moins de pression d'allocation, pas une baisse démontrée de la
mémoire retenue. Ces processus incluent Vite/Node et leurs caches ; ces chiffres
ne sont ni un pic échantillonné en continu ni une mesure du navigateur produit.

Les scripts `summarize.mjs` et `compare.mjs`, archivés avec les données après,
recalculent les distributions R7 depuis les échantillons et vérifient le runtime,
les SHAs, les charges, les comptes d'opérations et les invariants ci-dessus.
`summarize.mjs` prend les trois rapports d'un même snapshot puis `--output` ;
`compare.mjs` prend les deux résumés et un chemin de sortie JSON.
Les archives conservent les métadonnées de collecte originales, y compris les
chemins locaux et `worktreeDirty: true`.

La suite unitaire complète du commit d'optimisation a également été exécutée
(quatre workers, timeout de 20 secondes) : **3 693/3 693 tests passent**.

Ce sous-ensemble ne constitue pas un passage vert du budget global : les trois
contrôles complets initiaux restent en échec, conservés sans modification de seuil.

## Suite de l'expérimentation

- `zoom`, `is-supported-script` et `heatmap` ont ensuite été ajoutés et validés
  séparément ; les chiffres de performance ci-dessus restent ceux du snapshot
  d'optimisation, pas une nouvelle mesure de ces fonctionnalités.
- Restent à consolider les budgets non conformes et le coût résiduel des lectures
  publiques partielles, sans fallback worker silencieux ni relèvement arbitraire des seuils.
