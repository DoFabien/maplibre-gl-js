# Navigation MVT / MLT — 8 septembre 2026

## Résultat

**Sur ce parcours, MLT charge les nouvelles tuiles plus vite que MVT, avec une
cadence de navigation observée équivalente.** Cela concerne le chemin courant
de rendu, avec labels, icônes et caches normaux, sans extraction GeoJSON pendant
les chronométrages. MLT utilise ici VARINT et les triangles/contours fournis,
**sans FastPFOR**. Le moteur de rendu n'a pas été modifié pour cette campagne.

Six paires par profil réseau, ordre alterné, chacune avec un premier passage
puis le même parcours en cache : **48 passages chronométrés**. Valeurs ci-dessous
en millisecondes, médianes des statistiques par session, plus bas = plus rapide.
Le délai de tuile s'arrête à la première soumission `render` après `sourcedata` :
ce n'est pas un chronométrage de présentation physique des pixels.

| Mesure | Profil gzip | MVT | MLT | Écart MLT |
| --- | --- | ---: | ---: | ---: |
| Vue initiale chargée | Local | 389,8 | 355,1 | −8,9 % |
| Vue initiale chargée | 20 Mbit/s · 40 ms | 503,8 | 453,5 | −10,0 % |
| Arrivée de tuile, p50 | Local | 68,9 | 52,4 | −23,9 % |
| Arrivée de tuile, p50 | 20 Mbit/s · 40 ms | 135,3 | 118,5 | −12,4 % |
| Arrivée de tuile, p95 | Local | 120,9 | 101,9 | −15,7 % |
| Arrivée de tuile, p95 | 20 Mbit/s · 40 ms | 260,4 | 201,4 | −22,6 % |

Le p50 d'arrivée favorise MLT dans les **12 paires sur 12** : écarts appariés
de −32,4 à −13,6 % en local, de −12,7 à −6,9 % sur réseau limité. Ce sont des
plages observées, pas des intervalles de confiance. Le p95 local est plus
variable : une paire sur six favorise MVT (MLT 167,5 ms contre MVT 121,1 ms),
tandis que les six paires réseau favorisent MLT. Aucune répétition n'est retirée.

Les mêmes 16 nouvelles tuiles sont demandées pendant chaque premier parcours,
après les quatre tuiles de la vue initiale. Corps HTTP du parcours :
**1 221 263 octets MVT contre 876 488 octets MLT, soit −28,2 %** après gzip.
Avec la vue initiale, les glyphes et les sprites : 1 667 982 contre
1 295 227 octets, soit −22,3 %. Les ressources demandées et leur multiplicité
sont vérifiées identiques entre formats et répétitions ; aucune réponse annulée.

Chaque premier passage produit 22 préparations de tuile appariées, surzoom
compris, sans demande incomplète. Au second passage : **aucune requête HTTP,
aucune nouvelle préparation** pour les deux formats. Le délai d'arrivée est
alors non applicable, pas zéro milliseconde.

Cadence : p95/p99 RAF proches de **16,8 ms** pour les deux formats, à froid
comme en cache. Aucun intervalle supérieur à 50 ms et aucune longue tâche
observée dans les mouvements. Un intervalle MLT local de 33,4 ms est conservé.
Cela n'établit pas un gain de FPS ni une garantie de présentation GPU à 60 Hz.
Le temps observé avec source encore en chargement passe de 2,85 à 2,20 % en
local et de 6,40 à 5,27 % sur réseau limité ; des parents peuvent être affichés
pendant ce temps, donc ces chiffres ne mesurent pas des trous blancs.

### Robustesse et vérifications finales

Les premiers démarrages MVT sont plus lents (673,9 ms en local, 935,9 ms avec
réseau limité). Ils restent dans les résultats. En retirant **la paire entière
numéro 0, pour les deux formats**, les médianes initiales sont encore de
388,3 / 352,9 ms en local et 501,1 / 450,6 ms sur réseau limité. Cette sensibilité
ne remplace pas les six paires de l'analyse principale et n'attribue pas la
cause de ces observations à un composant particulier.

- Corpus : 42 tuiles, 427 couches ; IDs publics, propriétés, types et coordonnées
  ordonnées identiques avant rendu.
- Parité : **66 captures et 66 archives de requêtes complètes identiques**,
  aux onze poses arrêtées, sur GPU matériel et en rendu logiciel. Les fades
  sont désactivés uniquement pour ce contrôle ; pas de revendication d'égalité
  de toutes les images transitoires pendant le chargement.
- Chemin strict : les dix compteurs interdits et `propertyProxyMisses` restent
  à zéro ; `pretriangulatedFillFeatures` vaut 10 777 par session MLT de parité.
- Vérificateur indépendant : 64 413 horodatages RAF, 60 543 événements `render`,
  **216 quantiles SQL recalculés depuis les données brutes**, égaux aux résultats
  JavaScript, plus les quatre médianes de chargement initial recalculées en SQL
  depuis les durées de session. Hashes des sources, bundles, corpus et outils
  archivés vérifiés.
- Tests du banc : **4/4**, lint des nouveaux outils : **OK**. La suite complète
  du moteur n'a pas été relancée ; aucun code du moteur n'a été changé ici.

Conclusion : le coût des requêtes GeoJSON exhaustives ne représente pas ce
parcours d'affichage. Ici MLT réduit la latence de préparation et le trafic,
sans différence notable de cadence sur cet Iris Xe à 800 × 600. Il faut encore
élargir à un second corpus et à un matériel ou une résolution plus contraignants
pour généraliser. Cette campagne ne qualifie pas FastPFOR et ne mesure pas la RAM.

Sources finales :

- [Comparaison et vérification indépendante](navigation-comparison-final-20260908.json).
- [Mesures locales](navigation-timing-final-lan-20260908/results.json) et
  [mesures réseau limité](navigation-timing-final-network-20260908/results.json).
- [Parité GPU](navigation-parity-final-gpu-20260908/results.json) et
  [parité logicielle](navigation-parity-final-software-20260908/results.json).
- [Audit du corpus](navigation-corpus-final-20260908/manifest.json).
- [Rapport interactif : données et définition validées](navigation-report-final-20260908.json).

## Protocole fixé avant la campagne finale

Objectif : comparer l'affichage pendant une navigation réelle du moteur, sans
extraction de features ni conversion GeoJSON dans les fenêtres chronométrées.
Les mouvements sont des `easeTo` exécutés en temps réel, pas une horloge figée
ni des captures successives. Ce n'est pas un essai de gestes physiques.

Le corpus est extrait en lecture seule de `maplibre-tile-spec/test/omt-ref.mbtiles` :
42 tuiles OMT voisines des niveaux 10 à 13 autour de Dortmund. Les lignes MBTiles
sont TMS ; les URLs utilisent leur véritable Y XYZ. Le parcours ne demande pas
nécessairement les 42 tuiles : les téléchargements réellement effectués sont archivés.
Le style comprend occupation du sol, eau, bâtiments, routes, voies ferrées,
noms le long des routes, lieux, POI et icônes. Les collisions restent actives.

Le moteur production existant est inchangé. Un worker (valeur par défaut de
cette version hors Safari), Chrome matériel Intel
Iris Xe, 800 × 600, DPR 1, projection Mercator. Le parcours comporte dix mouvements
(panoramique, zoom 11,6–14,4, surzoom, rotation et inclinaison), des pauses de
lecture fixes de 300 ms, puis revient à sa pose initiale. Aucune attente de tuile
n'est introduite au milieu du déplacement. Les transitions de labels de 300 ms
restent normales pendant les mesures.

Environnement archivé : Intel Core i7-1260P, Linux x64 `7.0.0-30-generic`,
Node `v24.18.1`, Chrome `152.0.7977.75`, ANGLE/Mesa Intel Iris Xe.

Chaque session démarre dans un contexte navigateur neuf, sans cache partagé.
Le chargement initial est mesuré séparément. Le premier parcours intervient
après ce chargement : seule la vue initiale est donc déjà chaude. Le deuxième
parcours conserve la même carte, le même worker et les caches ordinaires.
Aucune URL n'est modifiée et aucune source n'est rechargée artificiellement.

Deux profils sont prévus : gzip local sans bridage et gzip avec un modèle de
20 Mbit/s partagés et 40 ms d'attente initiale par requête. Les octets sont
effectivement compressés sur HTTP, avec des en-têtes de cache. Le débit est
partagé entre les tuiles, glyphes et sprites, et non attribué à chaque requête.
Le limiteur distribue des tranches de débit toutes les 10 ms, sans crédit
accumulé pendant les périodes inactives. Les fichiers sont précompressés avant
les mesures : le coût de compression serveur n'est pas mesuré.
Ce modèle n'inclut ni TLS, ni pertes, ni une trace de réseau mobile réel.
Six paires MVT/MLT par profil, ordre alterné, chacune avec passage froid puis chaud.
Les mesures sont séquentielles, sans compilation ni suite de tests concurrente.

### Mesures retenues et limites

- Chargement initial : création de la carte jusqu'au premier événement `render`
  pour lequel `map.loaded()` est vrai. Imports JavaScript exclus, tuiles et
  ressources de style incluses. C'est une soumission CPU, pas une présentation.
- Arrivée de tuile : `dataloading` jusqu'au premier `render` suivant son
  `sourcedata`, en distinguant les niveaux de surzoom d'un même parent.
  Comprend aussi les préparations depuis un cache ; ce n'est pas le seul réseau.
  Les demandes sans fin appariée sont conservées, pas transformées en zéros.
- Cadence : intervalles RAF entièrement inclus dans les fenêtres de mouvement,
  p50/p95/p99, maximum, nombre au-dessus de 33,33 et 50 ms. Les pauses de lecture
  sont exclues. Cela observe la disponibilité du thread navigateur, pas les
  images réellement présentées à l'écran ou le temps d'exécution GPU.
- Longues tâches : intersection temporelle des tâches ≥ 50 ms avec les fenêtres
  de mouvement. Une tâche chevauchant une pause n'est comptée que pour sa part active.
- Disponibilité de la source : temps entre soumissions pour lequel
  `isSourceLoaded` est faux, rapporté au temps observé pendant les mouvements.
  Le moteur peut afficher une tuile parent pendant ce temps : ce n'est pas un
  pourcentage de pixels blancs.
- Octets et requêtes : corps des réponses HTTP réellement servis, y compris
  annulations ; les en-têtes et les couches TCP/IP ne sont pas comptés.
  Le passage chaud doit ne générer aucune requête au serveur sur ce parcours.

Les agrégats sont les médianes des valeurs par session. Les p95 de session ne
sont pas un p95 calculé sur toutes les images mises en commun. Les paires et
plages observées sont conservées pour éviter une fausse précision statistique.
La charge ambiante du bureau n'est pas contrôlée comme en laboratoire.

### Parité et essais pilotes

La parité est contrôlée dans des processus distincts, sans utiliser leurs temps :
onze poses arrêtées, pixels et résultats GeoJSON complets, avec des transitions
désactivées pour ces captures seulement. Cela ne certifie pas les images
transitoires des fades ou l'ordre d'arrivée réseau. Le parcours de production
chronométré conserve ses transitions et n'appelle aucune API de requête.

L'ancien `encode.jar`, daté de mars, tronquait 66 IDs publics sur ce corpus.
Il est conservé sous `navigation-corpus-20260908/encoder-previous.jar`
(SHA-256 `807ad0761eb90e9381c7aeb50cdc017a6904adada2439dfc5da694d9eff99bdc`).
Les essais diagnostiques correspondants restent en échec de parité d'IDs.
Ils ne font pas partie de la campagne finale.

La reconstruction `./gradlew :mlt-cli:encode` emploie la correction unsigned-ID
déjà présente dans les sources Java, sans modification de code. Nouveau JAR :
`f2d8872f189961b5c19a4798910b43ea65eae3d9cfc969ad4b819c7f6c851b42`.
Le contrôle applique la conversion unsigned de l'API MapLibre aux vecteurs
BigInt64 signés : ce changement de représentation conserve les 64 bits,
contrairement à la troncature de l'ancien encodeur. La comparaison finale
porte sur les nombres publics MVT, dont la précision est elle-même limitée
au-delà de `Number.MAX_SAFE_INTEGER`.

Le corpus final conserve les octets MVT d'origine. MLT est réencodé avec
`--tessellate --outlines ALL --nomorton`, sans FastPFOR. Les 42 tuiles et
427 couches passent IDs publics, propriétés, types et coordonnées ordonnées.
Le JAR final, les tailles et SHA-256 sont archivés dans
`navigation-corpus-final-20260908`. Les artefacts précédents ne sont ni écrasés
ni requalifiés. Un premier parcours pilote débordait du corpus pendant une
transition de zoom ; l'échec HTTP est conservé, et le parcours final reste
dans la couverture réelle sans fabriquer de tuiles vides.

## Reproduction

Depuis `maplibre-gl-js`, utiliser de nouveaux dossiers de sortie :

```bash
node test/bench/generate-mlt-navigation.mjs <nouveau-corpus>
npx vitest run --config test/bench/vitest.mlt-navigation.config.ts
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false node test/bench/e2e/mlt-navigation.ts --mode parity --strict --runs 2 --fixtures <corpus> --output <parite-gpu>
PUPPETEER_GPU=software node test/bench/e2e/mlt-navigation.ts --mode parity --strict --runs 1 --fixtures <corpus> --output <parite-logicielle>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false node test/bench/e2e/mlt-navigation.ts --mode timing --runs 6 --network lan --fixtures <corpus> --output <temps-lan>
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false node test/bench/e2e/mlt-navigation.ts --mode timing --runs 6 --network 20mbps-40ms --fixtures <corpus> --output <temps-reseau>
node test/bench/e2e/mlt-navigation-verify.mjs --timing <temps-lan> --timing <temps-reseau> --parity <parite-gpu> --parity <parite-logicielle> --output <nouvelle-verification.json>
node test/bench/e2e/mlt-navigation-report.mjs <nouvelle-verification.json> <nouveau-rapport.json>
```

## Versionnement du 13 septembre

Les outils, tests, requêtes SQL, rapport, comparaison finale et manifeste du
corpus sont versionnés. Les captures, tuiles, JAR, profils et séries brutes
restent locaux hors Git ; les liens vers les dossiers de campagne nécessitent
ce workspace ou la restauration de ces preuves.

La préparation des commits corrige le typage du contexte navigateur et de la
capture PNG, et renseigne la version avec `getVersion()`. Les copies du harness
mesuré restent intactes dans les dossiers de campagne ; le vérificateur utilise
leurs empreintes. Les archives de `baselines` sont exclues du programme TypeScript
actif, car leurs imports relatifs décrivent leur emplacement d'origine. Ces
corrections ne sont pas une nouvelle mesure de navigation.

Le vérificateur relancé le 13 septembre confirme les 66 comparaisons d'images,
66 archives de requêtes, 64 413 horodatages RAF et 60 543 événements `render`.
Les quatre tests du banc passent, ainsi que le contrôle TypeScript après les
corrections. Une copie exacte du harness final mesuré est versionnée dans
`navigation-timing-final-lan-20260908/harness/` ; les résultats bruts restent
locaux. La capture PNG corrigée produit les mêmes octets sur le contrôle ciblé.
