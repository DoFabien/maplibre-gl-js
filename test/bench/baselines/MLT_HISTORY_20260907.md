# Parité animée avec historique contrôlé — 7 septembre 2026

## Ce que ce lot change

Le [lot précédent](MLT_MOTION_20260907.md) comparait une image effectivement animée
à un rejeu statique de sa pose. Pendant le vol terrain, cela ne reproduisait pas
l'historique des textures. En logiciel, la capture intrusive ne garantissait pas
non plus trois frames chargées pendant une animation de deux secondes.

Ce lot ajoute un **banc distinct**, sans modification du code produit, des bundles,
du cache terrain, des fixtures ou des anciens bancs. Il exécute les vrais `easeTo`
et `flyTo` avec la même horloge et la même séquence de dessins entre encodages.
Les anciens résultats, notamment leurs échecs, restent des preuves historiques :
ce nouveau protocole ne rejoue pas exactement les anciennes traces natives.

## Protocole

- Corpus Berlin/monde existant, glyphes/sprite locaux, DEM synthétique non plat,
  canvas 800 × 600, DPR 1, un worker ; aucune ressource réseau externe.
- Quatre animations : mélange Mercator→globe et retour, orbite terrain à zoom
  constant, vol terrain avec centre/zoom/rotation/inclinaison.
- Carte neuve par session ; deux passages, ordre MVT/MLT inversé au second.
  Les mélanges partent d'une vue Mercator chargée commune avant la configuration
  de l'expression de projection. La source mondiale est ensuite rechargée avec
  ses URLs inchangées via `setTiles()` à la pose de départ : les anciens éléments
  hors vue sont invalidés avant la trace. L'objet source et les états sont conservés.
  Aucun rechargement ou effacement de cache n'est effectué pendant l'animation.
- `setNow()` fixe l'horloge publique de MapLibre. Le banc retient les callbacks
  `requestAnimationFrame` du navigateur puis en exécute exactement un par étape.
  Il ne remplace ni le renderer, ni les animations, ni les gestionnaires de tuiles.
- Seize dessins aux instants logiques 125, 250… 2 000 ms. Avant et après chacun,
  `areTilesLoaded()` et `isSourceLoaded()` doivent confirmer la fin des chargements
  engagés. L'attente ne dessine rien et n'avance pas l'horloge : elle ne rafraîchit
  donc pas les textures à une pose intermédiaire.
- Chaque frame est capturée dans `render`, y compris celle qui vient de demander
  de nouvelles tuiles encore absentes. PNG bruts et GeoJSON complets sont archivés.
  Les frames de stabilisation demandées par MapLibre sont ensuite exécutées au
  même instant logique final, jusqu'à `idle` et une file de callbacks vide.
- **Égalité exacte** des pixels, caméras observées, GeoJSON, états et flags de
  chargement entre MVT/MLT et entre répétitions. Seul le contrôle de la destination
  demandée utilise 1e-9 pour les conversions de caméra ; les preuves ne sont pas
  arrondies. Les événements source doivent appartenir aux mêmes intervalles entre
  dessins : ordre des arrivées dans un intervalle non imposé, multiensemble complet
  et numéros de frames identiques. L'ordre brut est aussi conservé.
- Comme les bancs précédents, les signatures GeoJSON canonisent les clés d'objet
  et trient la collection de features. Coordonnées, propriétés et ordre interne
  des géométries restent exacts ; l'ordre de retour de la collection n'est pas certifié.
- Vérification du feature-state, de l'identité des sources, du facteur effectif de
  projection, des altitudes et des dix compteurs worker interdits, plus
  `propertyProxyMisses`. Le témoin MVT ne décode aucune couche MLT.
- À la destruction : zéro canvas/callback restant, horloge et ordonnanceur du
  navigateur restaurés.

Ce protocole garantit les repères 500/1 000/1 500 ms même si SwiftShader prend
beaucoup plus de temps réel. Il **ne mesure pas les FPS**, la latence ou la mémoire.

## Contrôle discriminant de l'historique

Deux sessions supplémentaires, MVT et MLT, rejouent les quatre premiers dessins
du vol. Leurs images doivent d'abord correspondre exactement au parcours normal.
Un cinquième dessin est ensuite inséré **au même instant 500 ms**.

La caméra, les requêtes et les flags de chargement doivent rester identiques,
mais les pixels doivent différer : le zoom inchangé laisse le renderer rafraîchir
la texture terrain. Le banc échoue si ce contrôle ne distingue plus les deux
historiques. Il ne transforme pas une différence MVT/MLT en écart toléré ; il teste
séparément, dans le même encodage, deux historiques délibérément différents.

La [sonde du contrôle](browser-history-control-probe-v2-20260907/results.json)
retrouve **15 488 pixels différents, delta maximal 22**, identiquement en MVT et
MLT ; les quatre images précédentes et les états sont exacts.

## Évidence et validation

La [campagne production Iris Xe](browser-history-production-v3-20260907/results.json)
est conforme : 18 sessions, 282 captures, **136/136 comparaisons MVT/MLT** et
**136/136 répétitions exactes**, huit comparaisons de préfixe exactes et deux
contrôles discriminants réussis. Les 48 captures avec nouvelles tuiles encore
en chargement sont incluses dans les comparaisons, pas écartées.
La [campagne stricte Iris Xe](browser-history-strict-gpu-v3-20260907/results.json)
confirme exactement ces volumes et résultats, avec les compteurs interdits nuls.
La [campagne stricte SwiftShader](browser-history-strict-software-v3-20260907/results.json)
passe également les **136 comparaisons MVT/MLT, 136 répétitions, huit préfixes et
deux contrôles**, avec 282 captures dont 48 avec chargement. Le contrôle y retrouve
15 531 pixels différents (delta maximal 25), identiquement dans les deux encodages.
Les PNG ne sont pas exigés identiques entre GPU matériel et logiciel ; les paires
MVT/MLT le sont sur chacun. Aucun manque de couverture ne subsiste dans ce protocole.
La [vérification indépendante](browser-history-production-v3-20260907/validation.json)
est terminée, statut **`verified-controlled-history-parity`**, code **0**. Elle
reconstruit et recalcule les 840 comparaisons positives et les six contrôles des
trois campagnes. Caméras, états, signatures GeoJSON et événements par intervalle
sont aussi identiques entre production, strict GPU et strict logiciel, sans
imposer l'identité des pixels entre matériels de rendu différents.

Les empreintes des fichiers du banc, bundles, ressources, PNG/GeoJSON et rapports
sont archivées. Les sources du banc et le rapport des 336 tests sont conservés
compressés dans le dossier production. La validation précédente est également
référencée : aucun changement produit n'est nécessaire pour ce résultat.

- Premières sondes du vol : **17/17 images exactes**, en
  [strict GPU](browser-history-probe-v2-20260907/results.json) et
  [strict logiciel](browser-history-probe-software-20260907/results.json), dont les
  trois dessins initiant des chargements de nouvelles tuiles.
- La [première campagne complète](browser-history-production-20260907/results.json)
  est rejetée : son passage préalable par le globe laissait parfois deux tuiles
  différentes en cache avant les transitions de projection. Les images pouvaient
  être identiques mais pas les requêtes source. Le parcours de préparation a été
  repris, sans supprimer le contrôle des requêtes ni des événements.
- [Deuxième tentative](browser-history-production-v2-20260907/results.json) :
  partir de Mercator ne suffisait pas ; une ancienne tuile en cache variait encore,
  avec aussi des différences d'images au retour. D'où le rechargement explicite de
  la source à la pose de départ. Ce protocole à départ rechargé ne corrige ni ne
  certifie les parcours à cache chaud de ces tentatives, qui restent en échec.
- La [sonde après rechargement](browser-history-reset-probe-20260907/results.json)
  passe les deux transitions, dans les deux encodages et deux ordres : **136
  comparaisons exactes**, incluant les répétitions.
- **336/336 tests ciblés** : caméra, horloge, `RenderToTexture`, empreintes RTT.
  Typecheck et lint des nouveaux fichiers réussis.
- Le diff produit et les octets des bundles sont vérifiés contre le lot molette.
  Ses suites complètes restent des résultats antérieurs : 3 745 unitaires, 759 build,
  178 intégration, 243 rendus MLT logiciel ; GPU complet 1 887/1 923 avec les mêmes
  36 échecs connus. Elles ne sont pas réattribuées à une nouvelle exécution ici.

## Reproduction

Avec les bundles du snapshot documenté déjà construits, lancer **séquentiellement** :

```bash
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-history.ts --runs 2 --output <nouveau-dossier-production>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-history.ts --strict --runs 2 --output <nouveau-dossier-strict-gpu>
PUPPETEER_GPU=software \
  node test/bench/e2e/mlt-history.ts --strict --runs 2 --output <nouveau-dossier-strict-logiciel>
node test/bench/e2e/mlt-history-validate.mjs \
  <production> <strict-gpu> <strict-logiciel> <rapport-unitaire.json>
```

Utiliser Node directement, pas vite-node. `--only terrain-flight` réduit le corpus ;
`--no-controls` supprime les contrôles discriminants pour une sonde, pas pour la
qualification indépendante. Celle-ci exige deux passages des quatre parcours,
les contrôles dans les deux encodages et recalcule toutes les preuves brutes.

## Limites et suite

La disponibilité des ressources est contrôlée **entre** les dessins. Ce n'est pas
une certification de toutes les arrivées partielles possibles au milieu d'un
chargement, ni d'un cache chaud issu d'une préparation différente, de l'inertie
native, du tactile/pinch ou d'un pilote différent.
Les DEM sont synthétiques et le corpus mondial limité. La mémoire GPU n'est pas mesurée.

La suite est de contrôler aussi la préparation à cache chaud et de rendre les
livraisons de tuiles partiellement disponibles selon un calendrier reproductible,
avant de rapprocher ce banc des traces natives.
Le coût CPU/mémoire de subdivision reste une mesure séparée à réaliser.
