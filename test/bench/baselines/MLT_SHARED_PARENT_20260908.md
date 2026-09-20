# MLT → rendu : parent partagé et vues de colonnes — 8 septembre 2026

## Décision et portée

Le partage du parent corrige une grande partie des coûts ajoutés par le premier
prototype de surzoom direct. Il reste utile de supprimer ensuite les copies de
colonnes des enfants : cette seconde modification est implémentée localement
et mesurée séparément. Elle réduit surtout le coût des requêtes et le stockage ;
elle n'établit pas une accélération significative du dessin.
L'objectif reste le pipeline complet MLT → rendu, à parité MVT, pas seulement
un meilleur cache de surzoom.

## Parent partagé : comparaison navigateur mesurée

La [campagne de production](browser-shared-parent-production-v2-20260908/results.json)
compare le premier prototype direct figé et le parent partagé, avant les vues
indexées. Trois répétitions des quatre variantes avant/après × MVT/MLT, chacune
avec cinq échauffements puis vingt rechargements par état d'URL. Chrome 152,
Iris Xe, 800 × 600, DPR 1, un worker, corpus local Berlin. Aucun autre test/build
n'a été lancé pendant ces mesures navigateur. Les comparaisons de requêtes,
captures et collectes mémoire sont hors des intervalles chronométrés.

L'[analyse reproductible](shared-parent-browser-comparison-20260908.json) vérifie
les empreintes des bundles, les signatures de requêtes et les douze PNG finaux.
Les requêtes complètes et pixels sont identiques dans toutes les variantes.

| MLT, médiane des médianes de session | Avant partage | Parent partagé |
| --- | ---: | ---: |
| Rechargement → premier dessin chargé, URL réutilisée | 70,10 ms | 62,95 ms |
| Première requête complète après ce rechargement | 91,40 ms | 52,00 ms |
| Rechargement → premier dessin chargé, URL nouvelle | 94,30 ms | 61,80 ms |
| Première requête complète après ce rechargement | 93,05 ms | 50,90 ms |
| Stockage externe V8 worker après GC et vingt paires | 61 150 153 octets | 2 562 183 octets |
| Stockage externe V8 main au même point | 6 819 155 octets | 4 403 733 octets |

Le témoin MVT reste proche sur les rechargements : 70,50 → 68,55 ms avec URL
réutilisée, 102,00 → 101,10 ms avec URL nouvelle. Les stockages externes MVT
restent respectivement autour de 13,13 Mo worker et 2,50 Mo main.

**URL nouvelle ne signifie plus cache de contenu froid.** Le parent partagé
reconnaît les mêmes octets à des URLs différentes. Les anciens champs `cold` et
`warm` du JSON désignent donc seulement l'état des URLs. L'analyse les renomme
`uniqueURL` et `reusedURL` ; aucun gain de décodage réellement froid n'en est déduit.

Une mesure séparée du premier surzoom est prise dans chaque carte/worker neuf,
après installation à zoom natif et avant les échauffements. Ses trois délais
MLT avant sont 177,8 / 159,9 / 156,1 ms ; après 176,0 / 202,9 / 154,4 ms.
La médiane passe de 159,9 à 176,0 ms : **pas de gain établi au premier surzoom**.
Les premières requêtes associées ont des médianes de 195,2 → 181,3 ms, mais ces
trois observations et leur dispersion ne justifient pas un gain robuste annoncé.

`render` mesure la soumission CPU du dessin, pas la fin du GPU ni la présentation
écran. La mémoire externe comprend les ArrayBuffers et chaînes externes V8,
pas la mémoire GPU ni un plafond global. Ce scénario ne démontre pas un plateau
mémoire à très long terme ni une accélération générale de tous les styles.

Le premier essai du banc a échoué avant toute session complète : il exigeait
un événement source `content` pendant le changement de caméra, contrairement
au comportement de chargement des tuiles. Cet essai est conservé séparément
dans `browser-shared-parent-production-20260908`; il n'est pas un résultat produit.

## Architecture conservée et raccourcissement suivant

- Un parent immuable par contenu, avec comparaison exacte des octets après le hash.
- Colonnes parent décodées à la demande et plans géométriques partagés entre
  enfants et styles ; caches bornés, sans ownership fort dans le registre main.
- La réponse worker omet le parent uniquement si la requête confirme que le main
  conserve cette version pour cet acteur. Les premières requêtes simultanées
  peuvent encore transférer des copies ; elles sont mutualisées à réception.
- Une réponse à contenu différent ne remplace pas les données des anciennes
  tuiles vivantes. Les requêtes synchrones et leurs propriétés complètes restent disponibles.
- Le chemin local suivant utilise `IndexedVector` : les colonnes et identifiants
  des enfants référencent le parent avec les indices de lignes du plan, sans
  tableaux de valeurs intermédiaires ni reconstruction de dictionnaire.
- Les API autonomes de découpage conservent leur mode copie par défaut. L'encodeur
  accepte explicitement les vues en conservant le type scalaire, mais l'encodage
  enfant n'est pas utilisé dans le chemin de rendu.
- Un test contre le filtre MVT a révélé une exclusion incorrecte des absents
  dans le `!in` générique ; la correction couvre les sélections simples/composées.

L'ancien `MltOverzoomCacheEntry`, inutilisé depuis le partage, et son test sont
retirés. Ils restent récupérables dans les archives. Les garde-fous de rendu
et les images attendues ne sont pas assouplis.

## Traçabilité et travail restant

L'[archive du parent partagé mesuré](shared-parent-measured-20260908/workspace.tar.gz)
contient les deux arbres source et les bundles avant passage aux vues indexées.
SHA-256 : `3f169c9344c6db010221400fa4a5f323ef19fca8b46a1fdb51abede3e5cc26b2`.
La référence précédente est l'archive `direct-overzoom-final-20260908` décrite
dans le [rapport du prototype direct](MLT_DIRECT_OVERZOOM_20260908.md).

Les vues indexées passent les tests ciblés de nullabilité, grands IDs, chaînes
flat/dictionnaire/FSST, sélection imbriquée, projection de propriétés, encodage
explicite, filtres et feature-state. Le scénario styles strict GPU passe ses
25 checkpoints, pixels et requêtes exacts. Les 243 rendus MLT stricts logiciel
passent également, sans modification des images attendues. Cela ne remplace pas la qualification
globe/terrain, la suite GPU complète et les mesures avant/après de cette variante.

Six échecs supplémentaires ont été constatés dans les anciennes suites `.spec.ts`
de filtres, hors configuration unitaire habituelle : les mêmes six sont reproduits
sur le GL figé avant les vues, avec les mêmes dépendances installées. Ils restent
documentés dans `/tmp/mlt-indexed-filter-spec-before-20260908.json` et
`/tmp/mlt-indexed-filter-spec-20260908.json`, et ne sont pas transformés en succès.

## Vues indexées : premiers résultats, qualification encore partielle

Le [diagnostic worker isolé](indexed-columns-worker-isolated-20260908.json)
alterne dix échauffements et trente mesures par variante. Les buffers géométriques
et résultats publics restent identiques, mais **pas de gain worker net** :
MLT froid 11,219 → 11,747 ms ; chaud 3,188 → 3,199 ms. Ce diagnostic appelle le
worker directement, sans accusé de rétention du parent ni registre main : ses
requêtes utilisent le chemin indépendant et ne mesurent pas les vues partagées
du navigateur. Les octets bruts transférés y restent donc volontairement inchangés.

Le [passage navigateur pilote](indexed-parent-browser-pilot-comparison-20260908.json)
compare une session par variante, trois échauffements et huit mesures par état
d'URL. Les quatre PNG et les signatures complètes restent identiques. Médianes MLT :

| Pilote, parent partagé → vues indexées | Avant | Après |
| --- | ---: | ---: |
| Dessin chargé, URL réutilisée | 62,95 ms | 63,95 ms |
| Première requête après ce rechargement | 52,90 ms | 34,35 ms |
| Dessin chargé, URL nouvelle / contenu réutilisable | 59,60 ms | 62,05 ms |
| Première requête après ce rechargement | 48,35 ms | 32,70 ms |
| Stockage externe V8 main, après huit paires | 4 403 733 octets | 4 099 224 octets |
| Stockage externe V8 worker au même point | 2 562 183 octets | 2 472 907 octets |

Ce pilote suggère un gain de requête et une baisse de stockage, **pas un gain de
dessin**. Une seule session ne permet pas de conclure sur les petits écarts ; la
campagne répétée reste à faire. Aucun bénéfice du parent partagé n'est attribué
une seconde fois aux vues indexées.

Le [contrôle worker du partage lui-même](shared-parent-worker-isolated-v2-20260908.json)
montre aussi le compromis à froid : 10,568 → 11,345 ms ; chaud 3,264 → 3,276 ms.
Ce passage est isolé. Le premier fichier sans suffixe `v2` avait démarré pendant
la compression de l'archive de référence ; il n'est pas utilisé pour ces chiffres.

Le [checkpoint](indexed-columns-checkpoint-20260908/checkpoint.json) archive les
contrôles terminés : 3 764 tests unitaires GL, 2 619 TileSpec, 759 build, 178
intégration et 243 rendus MLT stricts logiciel, plus les 25 paires styles GPU.
Typecheck réussi ; lint ciblé sans erreur, avec 27 avertissements dans les anciens
helpers de filtres. La suite unitaire précédente comptait 3 765 tests avant retrait
du test du cache inutilisé. Deux relances sous charge avaient atteint le délai
de 5 s dans un test de zoom et deux imports ESM ; les relances finales isolées
passent sans modifier délais, assertions ou quotas. Un premier sélecteur de
tests render incorrect n'avait sélectionné aucun test ; seul le passage `v2`
de 243 tests est retenu.

Prochaine décision : profiler le coût du premier chargement et la production
des buffers. Les gains de requêtes ne
doivent pas détourner la priorité MLT → rendu. La qualification complète GPU et
globe/terrain, le zoom natif, les intermédiaires géométriques et les premières
copies simultanées restent ouverts. Le checkpoint n'affirme pas que l'objectif
global est atteint et n'hérite pas automatiquement des anciennes validations GPU.
Ces points décrivent l'état du checkpoint partiel ; les sections suivantes
consignent les campagnes terminées depuis sur les mêmes sources.

## Vues indexées : campagne navigateur répétée

La [comparaison répétée](indexed-parent-browser-comparison-20260908.json) utilise
le parent partagé figé comme référence, sans lui réattribuer son gain antérieur.
Trois sessions par variante, cinq échauffements et vingt rechargements par état
d'URL, sans autres tests ou builds concurrents. Les douze PNG et toutes les
signatures de requêtes complètes sont identiques.

| MLT, médiane des médianes de session | Parent partagé | Vues indexées |
| --- | ---: | ---: |
| Dessin chargé, URL réutilisée | 59,00 ms | 57,40 ms |
| Première requête après ce rechargement | 49,45 ms | 32,10 ms |
| Dessin chargé, URL nouvelle / contenu réutilisable | 61,10 ms | 58,80 ms |
| Première requête après ce rechargement | 51,75 ms | 33,75 ms |
| Stockage externe V8 main, après vingt paires | 4 403 733 octets | 4 099 224 octets |
| Stockage externe V8 worker au même point | 2 562 183 octets | 2 472 907 octets |

Le gain sur les requêtes est retrouvé dans chacune des trois sessions. Les petits
écarts de dessin restent dans une plage trop étroite pour annoncer un gain net :
le témoin MVT varie lui aussi, 70,25 → 69,55 ms (URL réutilisée) et
102,60 → 99,85 ms (URL nouvelle). Premier surzoom MLT :
154,2 / 195,2 / 153,1 ms avant, 162,3 / 148,8 / 152,8 ms après ; trois
observations ne suffisent pas à démontrer une amélioration à froid.

La prochaine optimisation doit donc viser un coût de production des buffers ou
de préparation du rendu identifié par profil CPU, et être mesurée séparément.
Ni ces chronométrages ni le profil CPU ne mesurent la fin d'exécution du GPU.

## Profil du chemin de rendu et décision suivante

Le [profil production main + worker](browser-indexed-render-profile-20260908/results.json)
contient deux sessions MVT et deux MLT, en ordre alterné, sur le scénario avec
symboles. Chaque carte commence au zoom natif ; cinq rechargements natifs,
un premier surzoom puis cinq rechargements en surzoom sont profilés séparément.
Les requêtes et captures sont hors profil. Les pixels et signatures sont exacts
entre les quatre sessions, à chacune des trois étapes. Les profils bruts compressés,
empreintes des bundles et sourcemaps sont conservés dans le même répertoire.

Ce sont des échantillons CPU de diagnostic à intervalle demandé de 250 µs,
**pas des mesures de performance non instrumentées**. L'installation initiale
de carte/style/glyphes est exclue. Une trame inclusive contient ses descendants :
ses coûts ne s'ajoutent pas à ceux des descendants.

- Au zoom natif, préparation/placement des symboles et fabrication des polygones
  occupent davantage le profil que le décodage MLT. Dans les deux profils MLT,
  `populatePolygon` représente respectivement environ 155 et 189 ms inclusifs
  pour cinq rechargements ; ce n'est pas le temps total d'une image.
- Au premier surzoom, `sliceGeometryVector` représente environ 44 et 42 ms
  inclusifs. Le clipping transforme les coordonnées puis compte et écrit les
  sorties X/Y avant de construire le vecteur enfant : ces intermédiaires restent
  une cible, même sans réencodage MLT. Le hash/comparaison du contenu est également
  visible ; il ne faut pas supprimer la vérification exacte pour gagner du temps.
- En cache, le clipping ne réapparaît pas dans les échantillons ; le travail
  se concentre sur les buckets, symboles, transferts et placement.

**Prochain changement ciblé : réutiliser le remappage des sommets déjà calculé.**
`subdivideFlattenedPolygonInternal` appelle `_initializeVertices`, qui produit
`oldToNewIndices`, puis `_convertIndices` refait une recherche par coordonnées
pour chaque indice de triangle. Le remappage existant peut servir directement
aux triangles et aux listes de contours. C'est une suppression de travail dans
la production des buffers, applicable au zoom natif comme au surzoom, sans
changer triangulation, arrondi, déduplication, winding, gestion des pôles ou GPU.
La décision de conserver l'optimisation dépendra des buffers/tests identiques
et d'une mesure avant/après isolée. La fusion des intermédiaires de clipping vient
ensuite, avec un risque de parité géométrique plus élevé.

## Suite GPU complète des vues indexées

Le nouveau passage strict GPU exécute les 1 923 fixtures : 1 887 succès et les
36 mêmes noms de tests en échec que le prototype direct qualifié ; aucun test
ignoré et aucun nouveau nom en échec. Les onze compteurs contrôlés sont présents
et nuls sur les snapshots des 1 923 fixtures. Il s'agit des opérations
instrumentées, pas d'une preuve d'absence de toute allocation dans les dépendances.
Les 36 échecs restent des échecs ; l'identité des noms ne prouve pas que leur
écart pixel est inchangé. Aucun attendu ni seuil n'a été modifié pour ce passage.

## Qualification consolidée de ce lot

La [qualification reproductible](indexed-columns-qualified-20260908/qualification.json)
vérifie les empreintes de toutes les sources des deux dépôts, les suites archivées
au checkpoint, les bundles et la campagne navigateur répétée. Elle recalcule
les signatures de GeoJSON complets et les comparaisons pixel de 144 paires :
23 globe/terrain + 25 styles, dans chacun des trois modes production GPU,
strict GPU et strict logiciel. Les checkpoints géographiques répétés sont aussi
vérifiés. Les 24 profils main/worker et les douze captures associées sont contrôlés.
Les résultats GPU, compteurs, métadonnées et images actuelles des 36 fixtures
en échec sont archivés, pour permettre une comparaison pixel au prochain lot.

Commande : `node test/bench/e2e/mlt-indexed-qualify.mjs <nouveau-répertoire>`.
Typecheck du nouveau profil réussi et lint des deux nouveaux outils sans erreur.
Les anciens certificats restent inchangés. Ce lot ne clôt pas les échecs GPU,
les six anciens tests de filtres, la parité de tous les styles ni l'objectif global.
