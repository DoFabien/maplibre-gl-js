import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

assert.ok(process.argv[2] && process.argv[3], 'Pass a verified comparison JSON and a new report JSON');
const input = resolve(process.argv[2]); const output = resolve(process.argv[3]);
const result = JSON.parse(readFileSync(input, 'utf8')); assert.equal(result.status, 'passed');
const labels = {lan: 'Local gzip', '20mbps-40ms': '20 Mbit/s · 40 ms'};
const rows = result.aggregates.map(row => ({...row, reseau: labels[row.network], format: row.encoding.toUpperCase(), passage: row.phase === 'cold' ? 'Premier passage' : 'Passage chaud',
    rafP95Ms: round(row.rafP95Ms), rafP99Ms: round(row.rafP99Ms), initialMs: round(row.initialMs),
    tileLoadP50Ms: row.tileLoadP50Ms === null ? null : round(row.tileLoadP50Ms),
    tileLoadP95Ms: row.tileLoadP95Ms === null ? null : round(row.tileLoadP95Ms)}));
const cold = rows.filter(row => row.phase === 'cold');
assert.ok(rows.every(row => row.sessions === 6), 'This report describes the six-pair campaign');
const sources = [
    {id: 'verification', label: 'Navigation : vérification indépendante', path: input},
    {id: 'protocol', label: 'Protocole et limites du benchmark', path: resolve('test/bench/baselines/MLT_NAVIGATION_20260908.md')},
    {id: 'startup', label: 'Vue initiale : médianes des durées mesurées par session', path: resolve('test/bench/e2e/mlt-navigation-startup.sql'),
        query: {sql: result.startupSql, engine: 'SQLite', language: 'sql', executed_at: result.checkedAt,
            description: 'Médiane des durées observées dans les cartes neuves, par format et réseau, recalculée en SQL depuis les 24 sessions et comparée au calcul JavaScript. Aucune observation retirée.',
            tables_used: ['main.initial_sessions'], metric_definitions: {initialMs: 'Millisecondes entre création de carte et première soumission render déclarée chargée ; import JavaScript exclu, tuiles et ressources de style incluses. Médiane des six sessions.'}}},
    {id: 'statistics', label: 'Quantiles recalculés depuis les horodatages bruts', path: resolve('test/bench/e2e/mlt-navigation-statistics.sql'),
        query: {sql: result.sql, engine: 'SQLite', language: 'sql', executed_at: result.checkedAt,
            description: 'Recalcul des intervalles RAF et des délais de chargement depuis les horodatages bruts, puis quantiles R7 par session. Le vérificateur compare ces résultats aux agrégats JavaScript et calcule la médiane des six sessions. Les données de démarrage et de trafic proviennent des mêmes sessions archivées.',
            tables_used: ['main.raw_raf', 'main.motion_windows', 'main.raw_tile_events', 'main.raw_render'],
            filters: ['Six sessions indépendantes par format et profil réseau, premier passage puis même parcours à chaud.',
                'Intervalles RAF entièrement dans les mouvements ; aucun profilage, aucune requête GeoJSON ou capture dans les mesures.'],
            metric_definitions: {tileLoadP50Ms: 'Médiane de six médianes par session du délai dataloading vers première soumission render suivant sourcedata ; préparations de surzoom incluses.',
                rafP95Ms: 'Médiane des p95 R7 des intervalles RAF à l’intérieur des fenêtres de mouvement ; pas des durées GPU ou de présentation.'}}}
];
const arrivalSentences = ['lan', '20mbps-40ms'].map(network => {
    const a = cold.find(row => row.network === network && row.encoding === 'mvt');
    const b = cold.find(row => row.network === network && row.encoding === 'mlt');
    const paired = result.rows.filter(row => row.network === network && row.phase === 'cold' && row.encoding === 'mvt').map(row => {
        const other = result.rows.find(candidate => candidate.network === network && candidate.phase === 'cold' && candidate.encoding === 'mlt' && candidate.run === row.run);
        return (other.tileLoadP50Ms / row.tileLoadP50Ms - 1) * 100;
    });
    return `**${labels[network]} :** ${number(a.tileLoadP50Ms)} ms en MVT contre ${number(b.tileLoadP50Ms)} ms en MLT (${signed((b.tileLoadP50Ms / a.tileLoadP50Ms - 1) * 100)}). Les écarts appariés vont de ${signed(Math.min(...paired))} à ${signed(Math.max(...paired))} ; ${paired.filter(value => value < 0).length} paires sur ${paired.length} favorisent MLT.`;
});
const initialSentences = ['lan', '20mbps-40ms'].map(network => {
    const a = cold.find(row => row.network === network && row.encoding === 'mvt'); const b = cold.find(row => row.network === network && row.encoding === 'mlt');
    return `${labels[network]} : **${number(a.initialMs)} ms en MVT, ${number(b.initialMs)} ms en MLT** (${signed((b.initialMs / a.initialMs - 1) * 100)}).`;
});
const sameCadence = Math.max(...rows.map(row => row.rafP95Ms)) - Math.min(...rows.map(row => row.rafP95Ms)) < 1;
const netMvt = cold.find(row => row.network === '20mbps-40ms' && row.encoding === 'mvt');
const netMlt = cold.find(row => row.network === '20mbps-40ms' && row.encoding === 'mlt');
const lowerArrival = ['lan', '20mbps-40ms'].every(network => cold.find(row => row.network === network && row.encoding === 'mlt').tileLoadP50Ms < cold.find(row => row.network === network && row.encoding === 'mvt').tileLoadP50Ms);
const artifact = {surface: 'report', manifest: {version: 1, surface: 'report', title: 'MVT et MLT en navigation', generatedAt: result.checkedAt, sources,
    blocks: [
        {id: 'title', type: 'markdown', body: '# MVT et MLT en navigation'},
        {id: 'summary', type: 'markdown', sourceId: 'verification', body: `## Résumé technique\n\n**Le test porte bien sur l’affichage pendant un parcours, sans extraction GeoJSON.** Mêmes données, style avec labels et icônes, moteur identique, premier passage puis réutilisation des caches.\n\n${arrivalSentences.join('\n\n')}\n\n${sameCadence ? '**La cadence observée reste très proche entre les formats.** Le bénéfice se situe surtout dans la disponibilité des tuiles, pas dans un gain de FPS démontré.' : '**La cadence doit être lue séparément du délai d’arrivée des tuiles.** Les intervalles ci-dessous mesurent l’ordonnancement du navigateur, pas la présentation physique à l’écran.'}\n\nLa parité des ${result.checks.images} captures arrêtées et des ${result.checks.queryArchives} archives de requêtes est exacte. Ce contrôle est séparé des mesures et ne certifie pas chaque image transitoire des animations.`},
        {id: 'arrival', type: 'markdown', sourceId: 'verification', body: `## Disponibilité des tuiles pendant le premier parcours\n\nLe chronomètre part de l’événement de chargement et s’arrête à la première soumission de rendu suivant la réception des données préparées. Ce délai comprend téléchargement, travail worker et préparation du dessin, mais aussi les préparations de surzoom depuis un parent en cache. **Ce n’est pas une mesure de fin GPU ni une preuve de visibilité pixel par pixel.**\n\nLes barres comparent la médiane des six médianes de session, en millisecondes ; plus bas est meilleur.\n\n${arrivalSentences.join('\n\n')}`},
        {id: 'arrival-plot', type: 'chart', chartId: 'arrival'},
        {id: 'initial', type: 'markdown', sourceId: 'verification', body: `## Chargement de la vue initiale\n\nCréation d’une carte dans un contexte navigateur neuf jusqu’à sa première soumission de rendu déclarée chargée, tuiles et ressources du style incluses. L’import principal JavaScript est exclu. Le processus navigateur et les caches du pilote GPU ne redémarrent pas à chaque session : ce n’est pas un démarrage complet de l’application.\n\n${initialSentences.join('\n\n')}\n\nCes médianes sont distinctes de la vitesse d’apparition des nouvelles tuiles pendant le parcours. Le premier lancement est conservé dans les résultats ; sa sensibilité est discutée dans les notes techniques.`},
        {id: 'initial-table', type: 'table', tableId: 'initial'},
        {id: 'cadence', type: 'markdown', sourceId: 'verification', body: `## Cadence à froid et avec les caches\n\nLe tableau compare les p95/p99 des intervalles de callbacks navigateur, ainsi que le nombre d’intervalles supérieurs à 50 ms. Chaque cellule est une médiane de six sessions. Les pauses de lecture sont exclues. **Des callbacks réguliers ne garantissent pas que le GPU présente toutes les images à cette cadence.**\n\n${sameCadence ? 'Le p95 ne distingue pratiquement pas les formats sur ce matériel. Il serait trompeur de convertir les gains de chargement en une promesse d’augmentation des FPS.' : 'Les écarts de cadence et les valeurs extrêmes sont conservés séparément des gains de chargement.'}\n\nLes passages chauds ne génèrent aucune requête HTTP au serveur et aucune nouvelle préparation de tuile sur ce parcours ; leur délai d’arrivée est donc non applicable, pas artificiellement mis à zéro.`},
        {id: 'cadence-table', type: 'table', tableId: 'cadence'},
        {id: 'traffic', type: 'markdown', sourceId: 'verification', body: `## Trafic réellement transféré\n\nPendant le premier parcours, hors chargement initial, le serveur transmet **${number(netMvt.payloadBytes / 1000)} ko en MVT contre ${number(netMlt.payloadBytes / 1000)} ko en MLT**, soit ${signed((netMlt.payloadBytes / netMvt.payloadBytes - 1) * 100)}. Les réponses sont effectivement compressées en gzip ; les deux formats utilisent les mêmes règles de cache et le même budget réseau partagé.\n\nCe gain concerne les tuiles demandées par la trajectoire, pas la somme de tout le corpus. Le second passage reste à zéro octet réseau pour les deux formats.`},
        {id: 'method', type: 'markdown', sourceId: 'protocol', body: '## Périmètre et méthode\n\nCorpus OMT réel de Dortmund : 42 tuiles disponibles, niveaux 10 à 13, dont les octets MVT sont conservés. MLT est encodé avec triangles et contours fournis, sans FastPFOR. Style avec routes, bâtiments, occupation du sol, eau, lieux, labels de routes, POI et icônes.\n\nDix mouvements en temps réel, zoom 11,6–14,4 avec pan, surzoom, rotation et inclinaison, puis retour à la pose initiale. Pas d’attente de chargement au milieu d’un mouvement. Les transitions de labels et les caches ordinaires restent actifs pendant les chronométrages.\n\nChrome matériel Intel Iris Xe, un worker, 800 × 600, DPR 1. Six paires par profil, ordre MVT/MLT alterné ; premier passage puis même parcours chaud dans la même carte. Deux profils gzip : réseau local et modèle de 20 Mbit/s partagés avec 40 ms d’attente par requête. Les scripts du moteur restent servis localement sans bridage.\n\nLes tests, compilations, contrôles GeoJSON et captures sont hors des campagnes chronométrées. Les quantiles ont été recalculés indépendamment en SQLite depuis les horodatages bruts ; les fichiers, corpus et bundles sont identifiés par SHA-256.'},
        {id: 'limits', type: 'markdown', sourceId: 'protocol', body: '## Limites et robustesse\n\nIl s’agit d’un parcours scripté utilisant les animations ordinaires du moteur, pas d’un test de gestes physiques ou d’un trajet libre sur toute une planète. Le réseau est un modèle borné sans pertes ni TLS, pas une trace Internet réelle. La charge ambiante du bureau n’est pas contrôlée comme en laboratoire.\n\nLes intervalles RAF et les soumissions render sont des indicateurs côté navigateur, pas des durées GPU ni des images présentées. Les plages appariées sont des observations, pas des intervalles de confiance. L’étude ne mesure pas la RAM maximale ou la mémoire GPU.\n\nLa parité est exacte aux onze poses arrêtées, en GPU et logiciel. Les captures de validation désactivent les fades ; les mesures conservent les fades normaux. L’égalité de toutes les images transitoires, de tous les styles et de la suite GPU complète n’est pas revendiquée.\n\nUn ancien encodeur tronquait certains IDs du corpus. Il a été archivé puis reconstruit depuis les sources Java existantes. Le corpus final passe l’audit complet des 427 couches, sans modifier les données MVT ni le code du moteur. Les pilotes en échec restent archivés et ne contribuent à aucun chiffre final.'},
        {id: 'next', type: 'markdown', body: '## Ce que ce test permet de décider\n\nPour cet usage, il faut juger MLT sur la disponibilité des tuiles et la fluidité du parcours, pas sur l’extraction exhaustive de GeoJSON. Les deux dimensions sont maintenant mesurées séparément.\n\nLa généralisation reste à établir sur un écran plus grand, du matériel plus contraint et un second corpus urbain. Une mesure de présentation ou une trace GPU distincte serait nécessaire pour conclure précisément sur les images réellement affichées. FastPFOR n’a pas été retesté ni qualifié par cette campagne.'}
    ],
    charts: [{id: 'arrival', title: 'Délai de chargement jusqu’à la soumission suivante', subtitle: lowerArrival ? 'Le délai médian MLT est inférieur sur les deux profils testés.' : 'Le délai dépend du format et du profil réseau testés.', showDescription: true,
        type: 'bar', intent: 'comparison', question: 'Le format change-t-il la disponibilité des tuiles pendant le parcours ?',
        rationale: 'Deux profils réseau et deux formats : quatre barres groupées, avec les quantiles et volumes adjacents conservés dans le jeu de données.',
        dataset: 'cold', sourceId: 'statistics', encodings: {x: {field: 'reseau', type: 'nominal', label: 'Réseau'},
            y: {field: 'tileLoadP50Ms', type: 'quantitative', label: 'Délai (ms)'}, color: {field: 'format', type: 'nominal', label: 'Format'},
            tooltip: [{field: 'tileLoadP95Ms', type: 'quantitative', label: 'p95 de chargement (ms)'}, {field: 'tileLoadsCompleted', type: 'quantitative', label: 'Préparations par passage'},
                {field: 'sessions', type: 'quantitative', label: 'Sessions'}]}, palette: {kind: 'categorical'},
        legend: {position: 'bottom', sort: 'spec', title: 'Format'}, labels: {values: 'all'}, settings: {orientation: 'vertical', groupMode: 'grouped', sort: 'none'}, unit: 'ms', valueFormat: 'number', layout: 'full'}],
    tables: [
        {id: 'initial', title: 'Temps de chargement initial', subtitle: 'Médiane de six cartes neuves par format et profil ; millisecondes.', dataset: 'cold', sourceId: 'startup',
            defaultSort: {field: 'reseau', direction: 'asc'}, columns: [{field: 'reseau', label: 'Réseau', type: 'text'}, {field: 'format', label: 'Format', type: 'text'}, {field: 'initialMs', label: 'Vue initiale (ms)', format: 'number'}]},
        {id: 'cadence', title: 'Intervalles de callbacks pendant les mouvements', subtitle: 'Médiane des mesures par session ; p95/p99 en ms, pauses de lecture exclues.', dataset: 'passes', sourceId: 'statistics',
            defaultSort: {field: 'reseau', direction: 'asc'}, columns: [{field: 'reseau', label: 'Réseau', type: 'text'}, {field: 'passage', label: 'Passage', type: 'text'},
                {field: 'format', label: 'Format', type: 'text'}, {field: 'rafP95Ms', label: 'p95 (ms)', format: 'number'}, {field: 'rafP99Ms', label: 'p99 (ms)', format: 'number'},
                {field: 'rafOver50ms', label: 'Intervalles > 50 ms', format: 'number'}]}
    ]}, snapshot: {version: 1, status: 'ready', generatedAt: result.checkedAt, datasets: {cold, passes: rows}},
    sources, notes: {audience: 'technical', delivery: 'mcp-app', skills: ['design-kpis', 'validate-data', 'build-report', 'visualize-data'],
        chartContract: 'Comparison: one grouped bar chart, four rows with two non-neutral native palette roots (blue/orange), visible format legend and value labels, zero baseline; table for near-equal scheduling percentiles and distinct startup definition.',
        sourceFiles: [...result.timingPaths, ...result.parityPaths, input],
        structure: 'Title; technical summary; metric definitions before each finding; arrival visual; startup and cadence exact tables; traffic; scope/method; limits; next steps and remaining questions.'}};
writeFileSync(output, JSON.stringify(artifact, null, 2), {flag: 'wx'});
console.log(output);

function round(value) { return Math.round(value * 100) / 100; }
function number(value) { return new Intl.NumberFormat('fr-FR', {maximumFractionDigits: 1}).format(value); }
function signed(value) { return `${value >= 0 ? '+' : '−'}${number(Math.abs(value))} %`; }
