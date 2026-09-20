# Gestes natifs et frames animées MVT/MLT — 7 septembre 2026

## Périmètre

Ce lot prolonge le [parcours globe/terrain](MLT_GEOGRAPHY_20260907.md) avec huit
gestes natifs et quatre animations. Il conserve le corpus Berlin/monde, les DEM
**synthétiques** non plats, les glyphes/sprites locaux, le canvas 800 × 600/DPR 1,
un worker et `fadeDuration: 0`.

Les événements souris/clavier sont produits par Puppeteer/CDP dans le navigateur,
avec `isTrusted: true`, et passent par les vrais gestionnaires de MapLibre.
Ce ne sont pas des gestes physiques sur un périphérique ni des événements DOM
fabriqués par `dispatchEvent` dans la campagne navigateur. Les tests unitaires
utilisent, eux, les événements synthétiques habituels de JSDOM.

| Parcours | Opération |
| --- | --- |
| Mercator local | Panoramique souris et molette |
| Terrain local | Panoramique puis rotation/inclinaison au bouton droit |
| Globe | Panoramique, molette et flèche clavier |
| Globe avec terrain | Rotation/inclinaison native |
| Mélange de projection | `easeTo`, Mercator → globe et retour |
| Terrain à zoom constant | `easeTo`, rotation/inclinaison |
| Vol avec terrain | `flyTo`, centre/zoom/rotation/inclinaison |

Le mélange animé utilise une expression de zoom de 2,5 à 3,5, afin de rendre ses
valeurs intermédiaires visibles sur le corpus mondial à faible zoom. Il n'essaie
pas de mesurer la transition automatique aux zooms 11–12.

## Comparer des images au bon état

Chaque geste est exécuté en MVT et en MLT. Les trajectoires natives ne sont pas
déclarées identiques : inertie, charge et cadence des événements varient. Le banc
archive l'image effectivement dessinée et sa pose, puis rejoue cette pose dans
l'autre encodage. Il ne remplace pas l'image originale par une capture après repaint.

Les six composantes de pose sont conservées : centre, zoom, pitch, bearing, roll
et élévation. Leur aller-retour par les setters publics est contrôlé à **1e-9**,
sans arrondir les valeurs archivées. La pose de référence fixe l'élévation observée
en désactivant son recalage au sol ; le geste original conserve le comportement
normal. Les images PNG et GeoJSON complets exigent, eux, une égalité **exacte**.

Les frames sont capturées dans `render`, avant présentation du buffer WebGL.
Pour chaque animation de deux secondes, trois frames distinctes, en mouvement et
signalées chargées par `map.loaded()`, sont requises après les repères 25/50/75 %.
Leur avancement réellement observé est archivé : il ne s'agit pas de trois instants
strictement identiques entre exécutions. Le facteur effectif de projection provient
de la couche custom 2D non dessinante du parcours géographique.

Les premières frames de repère encore en chargement sont archivées séparément
(`*-loading-*`). Elles ne sont pas comparées à une référence statique entièrement
chargée et ne sont pas comptées comme parité réussie. La première sonde avait bien
échoué sur ce mélange de deux états de chargement différents.

Les traces vérifient `movestart`/`moveend`/`idle`, les événements spécifiques au
geste, l'entrée native et son `originalEvent`, l'effet effectif sur la caméra,
l'identité des sources vectorielles, le feature-state et les compteurs worker.
Trois frames chargées manquantes sont une erreur de couverture, pas un succès.

## Défaut molette corrigé

Un cran isolé de delta -120 attend la classification roue/trackpad pendant 40 ms.
Le callback différé démarrait le zoom sans mémoriser cet événement dans
`_lastWheelEvent`. Les événements publics de mouvement/zoom perdaient alors
`originalEvent`, ou pouvaient conserver celui d'un geste précédent.

Le correctif mémorise l'événement au début du callback différé. Un test public
sur `Map` compare l'identité de l'événement pour le chemin immédiat et le chemin
différé : **1 succès/1 échec avant correction, 2/2 après**. La campagne navigateur
avait également échoué sur la molette MVT et vérifie maintenant la provenance
native des événements. Le correctif est commun à MVT et MLT ; il ne change pas
le décodeur ni le cache terrain.

## Limite du rejeu statique pendant le vol terrain

L'image intermédiaire du vol diffère du rejeu statique malgré une pose et des
requêtes identiques. Le contrôle **MVT → MVT** reproduit l'écart ; le contrôle
MLT → MLT également. À zoom constant, les images intermédiaires du contrôle
terrain sont exactes.

Le cache [`RenderToTexture`](../../../src/webgl/render_to_texture.ts) conserve intentionnellement une texture dont seul le
zoom a changé pendant que le zoom évolue (`equalsIgnoringZoom`). Une frame de
suivi la rafraîchit lorsque le zoom se stabilise. L'image dépend donc aussi de
l'historique de ce cache ; rejouer seulement la pose efface cette dimension.

Ce résultat **ne prouve ni une régression MLT ni la parité de ces frames MVT/MLT**.
Le banc conserve leurs écarts exacts et reste en échec si une comparaison diverge,
même après avoir collecté toutes les autres comparaisons. Aucun seuil de pixels
n'est ajouté ; l'optimisation terrain n'est pas supprimée pour satisfaire un oracle
statique qui ne reproduit pas son historique.

## Campagnes de mouvement — qualification partielle

| Campagne | Images finales exactes | Frames intermédiaires exactes | Limite |
| --- | --- | --- | --- |
| [Production Iris Xe](browser-motion-production-v3-20260907/results.json) | 24/24 | 18/24 | Six frames du vol terrain non exactes |
| [Worker strict Iris Xe](browser-motion-strict-gpu-v3-20260907/results.json) | 24/24 | 18/24 | Mêmes six comparaisons non exactes |
| [Worker strict SwiftShader](browser-motion-strict-software-v3-20260907/results.json) | 21 comparées, exactes | 15 comparées, exactes | Campagne interrompue : couverture insuffisante |
| [Contrôle même encodage Iris Xe](browser-motion-self-gpu-v3-20260907/results.json) | 4/4 | 6/12 | Orbite exacte ; six frames du vol non exactes |

Les deux campagnes GPU parcourent chacune les douze scénarios dans les deux
encodages : **42/48 comparaisons exactes**, requêtes/états conformes aux 48 poses.
Les huit gestes natifs aboutissent tous à une image finale exacte ; les deux
transitions de projection et l'orbite terrain ont chacune trois frames chargées
exactes par encodage. Cela ne certifie pas l'identité des trajectoires natives.

Le logiciel était programmé pour deux passages, mais s'arrête au 22e mouvement
du premier : l'orbite MLT n'a que **deux** frames chargées au lieu de trois.
Même isolée, elle n'a produit que six événements `render` en deux secondes, dont
deux avec chargement en cours et une image finale. Ses captures existent, mais
leur comparaison n'est pas effectuée après l'échec de couverture. Le vol terrain
et le deuxième passage logiciel ne sont pas exécutés. Les **36 comparaisons déjà
effectuées sont exactes** ; ce n'est pas une qualification complète SwiftShader.

Les compteurs interdits et `propertyProxyMisses` restent nuls dans tous les workers
stricts observés ; le témoin MVT ne décode aucune couche MLT. L'instrumentation
intrusive et le chargement rendent ce banc de deux secondes insuffisant pour
garantir trois observations en logiciel. Ni durée ni assertions n'ont été changées
pour obtenir un résultat vert. Toutes ces commandes terminent avec le **code 1**.

## Validation

- **3 745/3 745 tests unitaires**, **759/759 tests de build**, builds dev/production/
  strict, typecheck et lint ciblé réussis. Le main gagne 23 octets bruts/4 gzip ;
  worker et partagé sont inchangés. Référence de taille et quotas non modifiés.
- **1 887/1 923 rendus GPU complets**, exactement les mêmes 36 échecs que le lot
  géographique. Aucun nouveau ni disparu ; la commande garde son code 1.
- **178/178 tests d'intégration** à la reprise complète isolée. Le premier passage
  sous charge avait **177/178**, avec le test Marker/terrain dépendant du réseau
  externe déjà instable ; aucune fixture ni référence n'a changé. Contrairement
  au corpus de mouvement local, cette suite native n'est pas entièrement hors ligne.
- Régression géographique stricte logiciel : **23/23 checkpoints exacts**, neuf
  mutations supplémentaires, état et compteurs conservés.
- **243/243 rendus MLT stricts logiciel**, compteurs interdits nuls.

La [vérification indépendante](browser-motion-production-v3-20260907/validation.json)
est terminée avec le statut `verified-partial-motion-qualification` et le **code 1**.
Elle recalcule les PNG et signatures des GeoJSON complets, vérifie les poses,
événements, états, compteurs, bundles/ressources et empreintes du code source.
Elle confirme explicitement les six écarts par campagne GPU et le préfixe incomplet
SwiftShader ; elle ne les transforme pas en succès. Les rapports de suites,
compteurs/métadonnées render et sources du banc sont archivés avec leurs empreintes.
Les archives de premières tentatives restent inchangées : défaut molette avant
correction, sondes de chargement et couverture insuffisante sous charge concurrente.
Les reprises isolées utilisent les mêmes durées et assertions ; l'échec de couverture
logiciel persiste aussi dans cette configuration isolée.

Premières preuves conservées, distinctes des campagnes finales :

- [Sonde de chargement](browser-motion-loading-probe-20260907/results.json) :
  nombre de features différent du rejeu entièrement chargé ; aucune parité déduite.
- [Sonde chargée](browser-motion-loaded-probe-20260907/results.json) et
  [contrôle MVT→MVT](browser-motion-self-probe-20260907/results.json) : écarts terrain
  reproduits, requêtes identiques.
- [Contrôle orbite/vol initial](browser-motion-self-probe-v2-20260907/results.json) :
  orbite exacte, vol intermédiaire non exact dans les deux encodages, avant correctif molette.
- [Échec navigateur molette](browser-motion-production-20260907/results.json) :
  provenance manquante avant correction.
- [Couverture insuffisante sous charge](browser-motion-strict-gpu-v2-20260907/results.json) :
  deux frames chargées au lieu de trois ; campagne rejetée, sans réduire l'exigence.

## Reproduction

Construire les bundles puis lancer les campagnes **séquentiellement**, sans suite
GPU lourde simultanée. Les captures/GeoJSON dans `render` sont intrusifs : ce ne
sont pas des mesures de FPS ou de latence.

```bash
npm run build-prod
BUILD=production npx rolldown -c rolldown.config.mlt-validation.ts
PUPPETEER_GPU=hardware PUPPETEER_HEADLESS=false \
  node test/bench/e2e/mlt-motion.ts --output <nouveau-dossier>
```

Répéter avec `--strict`, puis `PUPPETEER_GPU=software --strict --runs 2`.
`--only mercator-wheel,projection-forward` réduit le parcours. Le diagnostic
`--self-reference --only globe-terrain-orbit,globe-terrain-flight` rejoue les poses
dans le même encodage et ne constitue pas une comparaison MVT/MLT.

`mlt-motion-validate.mjs` reçoit les dossiers production, strict GPU, strict logiciel,
contrôle même encodage, puis les rapports unit/build/intégration/GPU, les compteurs
GPU, le test molette avant correction, le dossier de régression géographique et le
rapport render MLT strict logiciel. Il recalcule PNG et signatures GeoJSON, vérifie
le préfixe effectivement parcouru en logiciel et son échec à deux frames, conserve
les écarts et termine avec le code 1 tant que la qualification reste partielle.
Un treizième argument optionnel archive aussi le premier rapport d'intégration en échec.

## Suite

La prochaine étape est un oracle de rejeu **avec historique de rendu et de tuiles**
pour le vol terrain, avant de comparer ses frames intermédiaires entre encodages.
Il devra aussi garantir les observations en logiciel sans confondre cadence et
parité : les phases de chargement restent non certifiées. Une mesure isolée du
coût de subdivision viendra ensuite ; ni la mémoire GPU, ni le tactile/pinch, ni
tous les pilotes ou styles ne sont qualifiés ici.
