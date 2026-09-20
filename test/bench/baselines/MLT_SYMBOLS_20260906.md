# Qualification navigateur — symboles et glyphes, 6 septembre 2026

## Résultat

Le scénario `--scenario symbols` atteint la **parité exacte MVT/MLT aux dix
checkpoints**, pour les réponses GeoJSON complètes et les pixels. Il passe en
production sur Iris Xe et avec le worker strict sur Iris Xe et SwiftShader.
Les dix compteurs de matérialisation interdite, ainsi que `propertyProxyMisses`,
restent nuls. Les 160 cycles animés mesurés conservent les mêmes nombres de résultats.

Ce lot étend le banc et sa couverture, **sans nouveau changement produit** : les
SHA-256 des trois bundles de production et du CSS sont identiques au
[lot intersections](MLT_INTERSECTIONS_20260906.md), comme le diff `src/`.
GL JS reste à `cfb9f34ae` plus les corrections locales précédentes ; Tile Spec reste
à `1ec5c6b1`, propre. Aucun commit ni push dans ce lot.

Les chronométrages sont trop variables pour conclure à un avantage global MLT.
Le scénario ajoute une charge différente ; il ne remesure pas le gain de 15–20 %
du cache de topologie sur les requêtes fixes du lot précédent.

## Couverture ajoutée

Les quatre tuiles Berlin et les couches fill/line/circle/heatmap sont conservées.
Deux couches symbol s'ajoutent : noms des rues le long des lignes et noms/icônes de
POI, avec collisions actives, tri par rang, taille pilotée par propriété et choix
d'icône selon `maki`. Les POI nommés sont filtrés à `localrank <= 5` ; ce n'est pas
une couverture de tous les noms et alphabets du corpus.

Les ressources sont exclusivement locales : sprite JSON/PNG existant et trois blocs
PBF `0-255`, `256-511`, `8192-8447` de la pile
`Open Sans Semibold,Arial Unicode MS Bold`. Les cinq ressources sont effectivement
demandées dans chaque session de conformité et leurs hashes sont archivés.
Le fallback local des idéogrammes est désactivé. Le serveur ne sert qu'une liste
fixe de fichiers, sans cache HTTP ni compression ; CSP et contrôles réseau interdisent
le trafic distant. Les caches internes de glyphes restent actifs après chargement.

Les dix checkpoints sont : initial, sélection du symbole seul, rechargement de ce
symbole sélectionné, effacement de son état, sélection du bâtiment, rechargement du
bâtiment sélectionné, effacement, parcours avec retrait/recréation de source,
puis deux surzooms inclinés. La sélection du POI `-2935252601` change effectivement
l'image sans sélectionner le bâtiment ; le rechargement la conserve et l'effacement
rétablit exactement l'image initiale.

| Caméra | Résultats source | Résultats rendus | POI symboles | Rues symboles |
| --- | ---: | ---: | ---: | ---: |
| Initiale, zoom 14,5 | 12 530 | 4 051 | 87 | 5 |
| Surzoom 1, zoom 15,25 / pitch 35° | 5 304 | 2 483 | 58 | 4 |
| Surzoom 2, zoom 15,75 / pitch 45° | 4 917 | 1 191 | 49 | 7 |

Ce sont des occurrences de résultats des API, pas des glyphes ni des IDs uniques.
Les deux couches symbol doivent retourner des features à chaque checkpoint.

## Stabilisation du banc et essai écarté

Le canvas est maintenant fixé explicitement à **800×600, `pixelRatio: 1`**, avec
vérification de sa taille réelle. Le navigateur du poste annonce parfois
`devicePixelRatio = 1.0000000298023224`, ce qui déclenchait une demande de sprite
`@2x` absent. Le ratio explicite élimine cette ambiguïté, sans changer les assets.

Un premier passage production a été arrêté avant tout chronométrage : la vue
initiale MVT retournait 3 543 objets rendus, contre 4 051 après le parcours, alors
que les résultats source étaient identiques. La caméra n'était pas enregistrée
dans cet essai ; son origine exacte n'est donc pas démontrée.
L'[archive en échec](browser-symbols-production-20260906/results.json) est conservée
et n'est pas comptée comme validation réussie.

Le scénario piloté par API est désormais non interactif pour empêcher les gestes
du poste d'affecter la caméra. Centre, zoom, pitch et bearing sont contrôlés à
1e-9 près et consignés aux checkpoints ; aucune assertion de parité n'est assouplie.
Les campagnes finales `v2` sont toutes rejouées avec ce même banc, dont les hashes
sont vérifiés. Les premiers passages stricts préalables restent distincts des preuves finales.

## Validation finale

- Production Iris Xe : **10/10 checkpoints**, GeoJSON complet et zéro pixel différent.
- Worker strict Iris Xe : **10/10**, mêmes réponses que la production et zéro pixel différent MVT/MLT.
- Worker strict SwiftShader : **10/10**, zéro pixel différent MVT/MLT sur ce moteur.
- Scénario de base : **7/7** avec le banc final, parité exacte conservée.
- **91/91 tests unitaires ciblés** : symbol buckets, géométrie columnar des symboles,
  index cross-tile, tailles/styles des symboles, glyph manager et dessin des symboles.
- Build production, build strict production, typecheck et lint réussis, codes 0.
- Vérificateur indépendant : code 0 ; recomposition des signatures depuis les
  GeoJSON compressés, comparaison des PNG, contrôle des assets, hashes, compteurs
  et charges des cycles. **60 PNG et 60 réponses complètes** dans les trois campagnes finales.

Chaque parcours MLT strict comptabilise 228 couches, 1 290 colonnes et 824 434 valeurs
décodées, 15 102 features découpées en surzoom, 6 226 261 octets cumulés de copies
brutes. Les compteurs sont identiques entre les deux moteurs et les dix interdits
sont présents et nuls : wrappers de compatibilité, dictionnaires de propriétés,
`Point`, géométries matérialisées, fallback/réencodage MVT, etc.
Les 15 844 858 octets de colonnes décodées sont cumulés, pas une mesure de rétention.

La contrainte porte sur les frontières instrumentées du **worker**. Les résultats
GeoJSON explicitement demandés au main thread sont matérialisés par `toJSON()` ;
les compteurs de requête nuls dans le worker ne prouvent pas le contraire.

La suite complète n'est pas relancée pour ce lot de banc sans changement produit.
Son dernier passage reste celui du cache de topologie : 3 728 unitaires, 750 builds,
178 intégrations, 243 rendus MLT stricts logiciel ; **1 887/1 923 rendus GPU, mêmes
36 échecs connus**. Ce rapport ne transforme pas cette suite GPU en succès global.

## Mesures descriptives, séparées des garde-fous

Chrome 152.0.7977.75 / Node 24.18.1, Iris Xe ANGLE, un worker. Quatre paires alternées
MVT→MLT puis MLT→MVT : huit pages/workers distincts, un cycle animé de chauffe puis
20 cycles mesurés chacun, soit **160 cycles**. Chaque cycle comprend trois mouvements
de 300 ms, les requêtes source/rendues avec GeoJSON/JSON, deux sélections d'état,
rechargement, retrait et recréation de source. Chaque cycle mesuré retourne
**22 751 résultats source et 7 725 résultats rendus**.

Pas de tests lourds, build, profil CPU ni GC forcé pendant les chronométrages.
Le poste n'est toutefois pas dédié. Les paires 1–2 sont nettement plus lentes que
3–4 dans **les deux encodages**, sans cause système identifiée.

| Paire | Temps JSON source MLT relatif à MVT | Temps JSON rendu MLT relatif à MVT |
| --- | ---: | ---: |
| 1 | −23,2 % | −7,3 % |
| 2 | −34,9 % | −13,8 % |
| 3 | −11,2 % | +14,9 % |
| 4 | −9,9 % | +14,8 % |

Ces rapports comparent les **médianes des sessions appariées**, sans regrouper les
échantillons. Le JSON source favorise MLT dans les quatre paires, mais l'amplitude
n'est pas stable ; les requêtes rendues changent de sens. Aucun gain global ni
avant/après n'est donc établi. Le temps mouvement→idle MLT est 3–7 % supérieur,
malgré des intervalles RAF médians de 16,7 ms dans les deux formats : cette attente
n'est pas du temps GPU. Aucun des 9 244 intervalles RAF mesurés ne dépasse 33,34 ms ;
les tâches longues observées peuvent chevaucher les requêtes aux frontières du suivi.
Ce n'est ni un test de saturation GPU, ni une mesure de marge de FPS.

Pas de nouvelle campagne mémoire : les chiffres des 300 cycles historiques ne sont
pas attribués au scénario symboles. Les glyphes CJK/RTL, les changements de style à
chaud, globe/terrain et les gestes réels restent hors de cette qualification navigateur.

## Preuves et reproduction

- [Production : résultats](browser-symbols-production-v2-20260906/results.json),
  [analyse](browser-symbols-production-v2-20260906/analysis.json),
  [validation indépendante](browser-symbols-production-v2-20260906/validation.json).
- [Worker strict GPU](browser-symbols-strict-gpu-v2-20260906/results.json) et
  [worker strict logiciel](browser-symbols-strict-software-v2-20260906/results.json).
- Rapports unité/base et sources du banc compressés dans l'archive production finale.

```bash
npm run build-prod
npm run build-css
BUILD=production npx rolldown -c rolldown.config.mlt-validation.ts
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-lifecycle.ts --scenario symbols --phase timing \
  --runs 4 --cycles 20 --output <nouveau-dossier-production>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-lifecycle.ts --scenario symbols --strict --phase correctness \
  --output <nouveau-dossier-strict-gpu>
PUPPETEER_GPU=software \
  node test/bench/e2e/mlt-lifecycle.ts --scenario symbols --strict --phase correctness \
  --output <nouveau-dossier-strict-logiciel>
```

La suite logique est de couvrir **`setStyle` et les changements de style à chaud**
avec les mêmes contrôles d'état, de glyphes, de parité et de non-matérialisation,
avant d'élargir le scénario au globe/terrain. Une décision d'optimisation fondée sur
ces chronométrages exige d'abord un poste plus stable ou une nouvelle campagne isolée.
