# MLT prétriangulé → buffers de remplissage — 8 septembre 2026

Le [recontrôle du 13 septembre](MLT_OVERZOOM_RECHECK_20260913.md) trouve une petite
vérification de maillage répétée inutilement en surzoom et la supprime. Il ne
confirme pas un ralentissement stable de 7,1 % avec le protocole diagnostic ;
la répétition du protocole historique reste incomplète et sa cause exacte
n'est pas établie. Les mesures originales ci-dessous restent inchangées.

## Point de retour

Les travaux précédents ont été commités **avant** le prototype :

- GL JS : `4ac9eb198`, branche `restack/mlt-feature-state-native`.
- TileSpec : `ddf28400`, branche `mlt-columnar/tile-spec-minimal`.

Les empreintes des 846 fichiers source GL et 143 fichiers source MLT
correspondaient au certificat `owned-indices-checkpoint-20260908/checkpoint.json`.
Les archives brutes précédentes (6,5 Go) restent locales ; les sources, tests,
outils, rapports et le dernier certificat sont versionnés. Aucun push.
La référence exécutable vient de son `workspace.tar.gz`, extrait dans
`/tmp/mlt-pretriangulation-before-XFOIWe` ; les nouveaux bundles ne remplacent
pas cette référence.

## Découverte sur le corpus

Les quatre tuiles Berlin existantes sont **déjà prétriangulées** pour leurs
couches polygonales. Le réencodage Java avec `--tessellate --outlines ALL
--nomorton` reproduit leurs SHA-256 exactement. Les descriptions antérieures
parlant de nouvelles tuiles à produire ne s'appliquent donc pas à ce corpus.
Il ne faut pas confondre « lecteur ignorant les triangles » et « tuile sans
triangles ». Les coordonnées, attributs et octets d'entrée avant/après restent
identiques ; aucun surcoût réseau supplémentaire n'est introduit ici.

`generate-mlt-pretriangulated.mjs` conserve l'empreinte du JAR, les commandes,
tailles brutes/gzip, empreintes et inventaires des couches dans
`pretriangulated-encoding-audit-20260908/final/manifest.json`. Les copies
réencodées servent seulement d'audit ; les tests utilisent les fixtures
historiques `test/integration/assets/tiles/mlt/gl-js/`.

## Chemin ajouté

`appendPretriangulatedFill` consomme les buffers numériques de `GpuVector`.
Les offsets comptent des **triangles** et les indices sont relatifs à la
**feature entière**, multipolygones compris. Il écrit coordonnées Int16,
triangles et contours directement dans les tableaux finaux du bucket, avec
correction d'orientation et indices relatifs à chaque segment de dessin.
Il n'appelle pas Earcut et ne crée ni coordonnées aplaties intermédiaires,
ni liste intermédiaire de triangles, ni `Point[][]`.

L'éligibilité est volontairement étroite : pas de surzoom, pas de subdivision
même au zoom zéro, pas de tuile touchant les pôles, contours disponibles,
échelle entière positive, coordonnées sans clamp et feature de moins de
65 535 sommets. Les anneaux dégénérés et indices/offsets inutilisables sont
refusés avant toute écriture. Les cas inéligibles gardent la triangulation
**colonnaire numérique** existante, sans fallback vers les objets MVT.
Les MLT ordinaires, extrusions et autres buckets ne changent pas de chemin.

Les contours, bornes par polygone, sélection, paint et feature-state restent
pris en charge. Il subsiste des réservations de tableaux, l'adaptation Int32
→ Int16, le transfert worker et `bufferData`. Ce n'est ni un décodage GPU,
ni du zéro-copie de bout en bout, ni un nouveau backend WebGPU.

## Validation et mesures

Les 3 788 tests unitaires et 178 tests d'intégration passent. Les quinze tests
du nouveau chemin couvrent indices fournis (diagonale différente d'Earcut),
orientation, contours, non-mutation, passage de segment, exclusions et les
quatre tuiles Java réelles, multipolygones et trous compris. Ils comparent
surfaces triangulées, segments de contours et bornes par polygone, sans
exiger le même ordre ni le même empaquetage des triangles.

Le volume exact des tableaux de géométrie utilisés passe de **461 526 à
461 534 octets** pour toutes les couches maillées des quatre tuiles : deux
sommets dupliqués supplémentaires, soit huit octets. Cette mesure exclut
paint, capacité inutilisée et mémoire du driver GPU. Le lecteur ne réintroduit
pas de dictionnaire de déduplication pour économiser ces huit octets.

Le build production ajoute **2 009 octets bruts / 763 gzip** au module partagé ;
les modules main et worker restent de taille identique. Aucun shader, format
de vertex ou type d'index WebGL n'a changé.

### Performance navigateur, campagne isolée

`browser-pretriangulated-production-20260908` contient quatre rotations
équilibrées avant/après × MVT/MLT, vingt observations après cinq échauffements
par phase et session. Les **32 PNG et archives complètes de requêtes** sont
exacts. Le vérificateur indépendant recalcule les signatures et les médianes
dans `pretriangulated-browser-comparison-20260908.json`.

| Médiane des médianes de session, action → dessin chargé | Avant | Prototype |
| --- | ---: | ---: |
| MLT natif | 60,725 ms | 57,075 ms |
| MVT témoin natif | 67,775 ms | 68,325 ms |
| MLT surzoom chaud | 49,225 ms | 52,700 ms |
| MVT témoin surzoom chaud | 83,400 ms | 83,025 ms |

Le natif MLT est plus rapide dans chacune des quatre rotations : environ
**−6 %** au total. En revanche le surzoom est plus lent dans trois rotations
sur quatre, environ **+7,1 %** sur les médianes agrégées. Ce signal défavorable
est conservé, pas attribué arbitrairement au bruit. Le chemin maillé n'est
pas destiné au surzoom ; une répétition/profil doit départager effet indirect
et variabilité avant de revendiquer un bénéfice global. Les requêtes natives
55,150 → 55,450 ms ne montrent pas de gain ; le surzoom 27,100 → 26,650 ms non plus.

Le tas worker conservé après GC au natif passe d'environ 3,70 à 3,26 Mo, contre
3,35 → 3,35 Mo pour MVT. Ce n'est ni la mémoire maximale ni le volume alloué.
Le chronomètre s'arrête à la soumission CPU du dessin chargé, **pas** à la fin
GPU ou à la présentation. Il ne mesure pas les FPS ni le chargement initial
de la carte. Une campagne locale ne démontre pas une accélération universelle.

### Rendu et qualification finale

Le rendu strict GPU ciblé retrouve **236/243** et les **sept mêmes échecs** que
le checkpoint avant : noms et images sont exactement identiques, vérifiés par
`mlt-pretriangulated-gpu-audit.mjs` et archivés avant le passage logiciel dans
`pretriangulated-checkpoint-20260908/gpu-comparison.json`. Les 1 680 fixtures
non sélectionnées ne sont pas comptées comme réussites. La suite GPU complète
de 1 923 fixtures n'est pas rejouée dans ce lot.

Le logiciel strict passe **243/243**. Les bundles finaux passent **23 paires
globe/terrain GPU + 23 logiciel**, avec 27 étapes répétées par format et par
configuration, ainsi que **25 paires de styles à chaud GPU** (trois cycles).
Les archives de requêtes complètes, images et signatures de géographie sont
recalculées par `mlt-pretriangulated-certify.mjs`. Les compteurs interdits et
`propertyProxyMisses` restent nuls. Au chargement initial, **4 925 features /
27 364 triangles** prennent le chemin direct, en GPU comme en logiciel.

Builds production/dev et stricts production/dev, typecheck et lint ciblé passent.
Le premier contrôle de taille échoue uniquement sur le module partagé (3/4) ;
ce résultat est conservé. Sa référence est actualisée aux tailles ci-dessus,
sans modifier les quotas. La suite complète de build, exécutée isolément,
passe ensuite **759/759**. Les 2 622 tests TileSpec du lot précédent ne sont
pas recomptés ici : aucun code TileSpec n'a changé depuis le commit de sauvegarde.
Aucune image de rendu attendue ni tolérance n'a été modifiée.

### Allocations, campagne distincte

`browser-pretriangulated-allocations-20260908` contient quatre rotations
équilibrées, dix rechargements natifs après cinq échauffements. Les profils
Poisson V8 incluent les objets déjà récupérés par les GC mineur et majeur.
Les seize PNG, requêtes complètes, profils bruts, sourcemaps et empreintes sont
revérifiés indépendamment. Aucun chronométrage sous ce profileur n'est utilisé.

| Médiane des allocations worker estimées pour dix rechargements | Avant | Prototype |
| --- | ---: | ---: |
| MLT | 258,53 Mio | 181,09 Mio |
| MVT témoin | 386,31 Mio | 385,26 Mio |

La baisse MLT est d'environ **30 %**, présente dans les quatre rotations.
Il s'agit d'estimations d'allocations, pas de comptes exacts, de mémoire GPU,
de maximum du tas ou de mémoire conservée. Les coûts inclusifs des profils
se recouvrent et ne doivent pas être additionnés.

## Bilan et suite

Au terme de la campagne du 8 septembre, le prototype était conservé localement,
non commité, après les deux commits de sauvegarde. Le trajet vers les buffers finaux est effectivement plus direct,
à parité sur le corpus exécuté, avec moins d'allocations et un gain natif observé.
Cela ne certifie pas tous les styles/tuiles et ne démontre pas un gain global.
La priorité suivante est de répéter/profiler le signal de surzoom chaud avant
d'étendre le raccourci aux grandes features, au clipping ou à d'autres buckets.

Le [certificat](pretriangulated-checkpoint-20260908/checkpoint.json) rassemble
empreintes des sources, builds, requêtes/images, suites et mesures, ainsi que
les hashes des archives de workspace et de validation. Les sorties volumineuses
restent dans les répertoires locaux de campagne. Le premier passage géographique
GPU sans le garde-fou des anneaux dégénérés est conservé séparément ; **seul**
`browser-pretriangulated-geography-final-gpu-20260908` qualifie la version finale.

## Versionnement du 13 septembre

Le code, ses quinze tests, les outils, la comparaison navigateur, les tailles
de buffers et le certificat sont désormais versionnés. Les 991 empreintes des
sources GL/MLT correspondent au certificat du 8 septembre ; les 366 preuves
encore présentes et les deux archives correspondent aussi. Les quatorze rapports
temporaires absents de `/tmp` sont intacts dans `validation-artifacts.tar.gz`.
Les nouvelles vérifications de tests ne constituent pas une nouvelle campagne
de performance ou de rendu GPU.

Les archives, bundles, images et profils bruts restent conservés localement hors
Git. Le certificat en conserve les chemins et empreintes : leurs liens exigent
ce workspace, ou la restauration des archives correspondantes.

Vérifications relancées le 13 septembre : **3 788 tests unitaires**, lint ciblé
sur les quatre fichiers source concernés et contrôle TypeScript réussis.
Les **759 tests de build passent avec `--maxWorkers 1`**. Les deux passages
parallèles précédents ont chacun un timeout à cinq secondes sur l'import ESM
du bundle de développement (758/759) ; aucun timeout ou test n'a été modifié.
Les 178 intégrations et les campagnes de rendu ci-dessus restent les résultats
archivés du 8 septembre, sans nouveau passage revendiqué.
