import minimist from 'minimist';
import MltWorkerParse, {mltLineSymbolMatrixCases, MltRealTileWorkerParse} from './lib/mlt_worker_parse.ts';

const benchmarkFactories: Record<string, () => MltWorkerParse | MltRealTileWorkerParse> = {
    MltWorkerParseProfileSyntheticMVT: () => new MltWorkerParse('mvt'),
    MltWorkerParseProfileSyntheticMLT: () => new MltWorkerParse('mlt'),
    MltWorkerParseProfileSyntheticLineMVT: () => new MltWorkerParse('mvt', 'line'),
    MltWorkerParseProfileSyntheticLineMLT: () => new MltWorkerParse('mlt', 'line'),
    MltWorkerParseProfileSyntheticSymbolMVT: () => new MltWorkerParse('mvt', 'symbol'),
    MltWorkerParseProfileSyntheticSymbolMLT: () => new MltWorkerParse('mlt', 'symbol'),
    MltWorkerParseProfileSyntheticLineSymbolMVT: () => new MltWorkerParse('mvt', 'symbol-line'),
    MltWorkerParseProfileSyntheticLineSymbolMLT: () => new MltWorkerParse('mlt', 'symbol-line'),
    MltWorkerParseProfileRealRoadMVT: () => new MltRealTileWorkerParse('mvt'),
    MltWorkerParseProfileRealRoadMLT: () => new MltRealTileWorkerParse('mlt'),
};

for (const matrixCase of mltLineSymbolMatrixCases) {
    const suffix = matrixCase.name.split('-').map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join('');
    const parsesPerIteration = matrixCase.name === 'sparse' || matrixCase.name === 'merge-short'
        ? 5
        : matrixCase.featureCount >= 2048 ? 1 : matrixCase.featureCount >= 1024 ? 2 : 3;
    benchmarkFactories[`MltWorkerParseProfileLineSymbolMatrix${suffix}MVT`] = () => new MltWorkerParse('mvt', 'symbol-line', parsesPerIteration, matrixCase);
    benchmarkFactories[`MltWorkerParseProfileLineSymbolMatrix${suffix}MLT`] = () => new MltWorkerParse('mlt', 'symbol-line', parsesPerIteration, matrixCase);
}

const defaultBenchmarks = [
    'MltWorkerParseProfileSyntheticLineMVT',
    'MltWorkerParseProfileSyntheticLineMLT',
    'MltWorkerParseProfileSyntheticLineSymbolMVT',
    'MltWorkerParseProfileSyntheticLineSymbolMLT',
    'MltWorkerParseProfileRealRoadMVT',
    'MltWorkerParseProfileRealRoadMLT',
] as const;

const argv = minimist(process.argv.slice(2), {
    default: {iterations: 50},
});
const iterations = Number(argv.iterations);
if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error(`Invalid --iterations value: ${argv.iterations}`);
}

const benchmarkNames = argv._.length > 0 ? argv._ : defaultBenchmarks;
for (const benchmarkName of benchmarkNames) {
    const factory = benchmarkFactories[benchmarkName];
    if (!factory) {
        throw new Error(`Unknown benchmark: ${benchmarkName}. Available benchmarks: ${Object.keys(benchmarkFactories).join(', ')}`);
    }

    const benchmark = factory();
    await benchmark.setup();
    const rows = await benchmark.profile(iterations);

    console.log(`\n${benchmarkName} (${iterations} iterations)`);
    console.table(rows.map(row => ({
        phase: row.phase,
        kind: row.kind,
        encoding: row.encoding ?? '',
        layerType: row.layerType ?? '',
        layerId: row.layerId ?? '',
        detail: row.detail ?? '',
        mean: row.mean.toFixed(3),
        percent: row.percent.toFixed(1),
        calls: row.calls,
        features: row.features ?? '',
    })));
}
