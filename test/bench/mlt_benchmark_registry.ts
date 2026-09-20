import MltWorkerParse, {
    MltRealTileDecode,
    MltRealTileEndToEnd,
    MltRealTileScan,
    MltRealTileWorkerParse,
    MltColumnProjectionMatrix,
    MltBingDecode,
    MltFastPforDecode,
    MltMemoryLifecycle,
    MltOmtCorpusDecode,
    MltOmtLineSymbols,
    MltOverzoom,
    MltPublicQueryAggregation,
    MltQueryTemperature,
    MltRenderedQuery,
    MltRepeatedFeatureState,
    MltSourceQuery,
    MltTransferStrategy,
    mltLineSymbolMatrixCases,
    type Benchmark,
    type DecodeTraversal,
    type QueryIdMode,
    type QueryResultAccess,
} from './lib/mlt_worker_parse.ts';

export type MltBenchmarkFactory = () => Benchmark;

export type MltBenchmarkComparisonPair = {
    reference: string;
    candidate: string;
};

export const mltBenchmarkComparisonPairs: MltBenchmarkComparisonPair[] = [
    {reference: 'MltWorkerParseOnlyMVT', candidate: 'MltWorkerParseOnlyMLTNative'},
    {reference: 'MltWorkerParseOnlySyntheticLineMVT', candidate: 'MltWorkerParseOnlySyntheticLineMLT'},
    {reference: 'MltWorkerParseOnlySyntheticFillMVT', candidate: 'MltWorkerParseOnlySyntheticFillMLT'},
    {reference: 'MltWorkerParseOnlySyntheticCircleMVT', candidate: 'MltWorkerParseOnlySyntheticCircleMLT'},
    {reference: 'MltWorkerParseOnlySyntheticFillExtrusionMVT', candidate: 'MltWorkerParseOnlySyntheticFillExtrusionMLT'},
    {reference: 'MltRealTileScanMVT', candidate: 'MltRealTileScanMLT'},
    {reference: 'MltRealTileDecodeMVT', candidate: 'MltRealTileDecodeMLTProjected'},
    {reference: 'MltRealTileDecodeMetadataMVT', candidate: 'MltRealTileDecodeMetadataMLT'},
    {reference: 'MltRealTileDecodePropertiesOneMVT', candidate: 'MltRealTileDecodePropertiesOneMLT'},
    {reference: 'MltRealTileDecodePropertiesEnumerateMVT', candidate: 'MltRealTileDecodePropertiesEnumerateMLT'},
    {reference: 'MltRealTileDecodeGeometryMVT', candidate: 'MltRealTileDecodeGeometryMLT'},
    {reference: 'MltRealTileDecodeToGeoJSONMVT', candidate: 'MltRealTileDecodeToGeoJSONMLT'},
    {reference: 'MltRealTileDecodeFullAccessMVT', candidate: 'MltRealTileDecodeFullAccessMLT'},
    {reference: 'MltRealTileParseOnlyMVT', candidate: 'MltRealTileParseOnlyMLTNative'},
    {reference: 'MltRealTileEndToEndMVT', candidate: 'MltRealTileEndToEndMLT'},
    {reference: 'MltOmtBuildingDecodeMVT', candidate: 'MltOmtBuildingDecodeMLT'},
    {reference: 'MltOmtRoadLabelsDecodeMVT', candidate: 'MltOmtRoadLabelsDecodeMLT'},
    {reference: 'MltOmtLowZoomLabelsDecodeMVT', candidate: 'MltOmtLowZoomLabelsDecodeMLT'},
    {reference: 'MltOmtLineSymbolsMVT', candidate: 'MltOmtLineSymbolsMLT'},
    {reference: 'MltBingDecodeMVT', candidate: 'MltBingDecodeMLT'},
    {reference: 'MltWorkerParseOnlySyntheticSymbolMVT', candidate: 'MltWorkerParseOnlySyntheticSymbolMLT'},
    {reference: 'MltWorkerParseOnlySyntheticLineSymbolMVT', candidate: 'MltWorkerParseOnlySyntheticLineSymbolMLT'},
    {reference: 'MltQueryRendered0MVT', candidate: 'MltQueryRendered0MLT'},
    {reference: 'MltQueryRendered1MVT', candidate: 'MltQueryRendered1MLT'},
    {reference: 'MltQueryRendered10MVT', candidate: 'MltQueryRendered10MLT'},
    {reference: 'MltQueryRenderedManyMVT', candidate: 'MltQueryRenderedManyMLT'},
    {reference: 'MltQuerySource1PctMVT', candidate: 'MltQuerySource1PctMLT'},
    {reference: 'MltQuerySource10PctMVT', candidate: 'MltQuerySource10PctMLT'},
    {reference: 'MltQuerySource100PctMVT', candidate: 'MltQuerySource100PctMLT'},
];

export const mltDefaultBenchmarkNames = [
    'MltWorkerParseOnlyMVT',
    'MltWorkerParseOnlyMLTNative',
    'MltWorkerParseOnlySyntheticLineMVT',
    'MltWorkerParseOnlySyntheticLineMLT',
    'MltWorkerParseOnlySyntheticFillMVT',
    'MltWorkerParseOnlySyntheticFillMLT',
    'MltWorkerParseOnlySyntheticCircleMVT',
    'MltWorkerParseOnlySyntheticCircleMLT',
    'MltWorkerParseOnlySyntheticFillExtrusionMVT',
    'MltWorkerParseOnlySyntheticFillExtrusionMLT',
    'MltRealTileScanMVT',
    'MltRealTileScanMLT',
    'MltRealTileDecodeMVT',
    'MltRealTileDecodeMLTProjected',
    'MltRealTileDecodeMetadataMVT',
    'MltRealTileDecodeMetadataMLT',
    'MltRealTileDecodePropertiesOneMVT',
    'MltRealTileDecodePropertiesOneMLT',
    'MltRealTileDecodePropertiesEnumerateMVT',
    'MltRealTileDecodePropertiesEnumerateMLT',
    'MltRealTileDecodeGeometryMVT',
    'MltRealTileDecodeGeometryMLT',
    'MltRealTileDecodeToGeoJSONMVT',
    'MltRealTileDecodeToGeoJSONMLT',
    'MltRealTileDecodeFullAccessMVT',
    'MltRealTileDecodeFullAccessMLT',
    'MltRealTileParseOnlyMVT',
    'MltRealTileParseOnlyMLTNative',
    'MltRealTileEndToEndMVT',
    'MltRealTileEndToEndMLT',
    'MltOmtBuildingDecodeMVT',
    'MltOmtBuildingDecodeMLT',
    'MltOmtRoadLabelsDecodeMVT',
    'MltOmtRoadLabelsDecodeMLT',
    'MltOmtLowZoomLabelsDecodeMVT',
    'MltOmtLowZoomLabelsDecodeMLT',
    'MltOmtLineSymbolsMVT',
    'MltOmtLineSymbolsMLT',
    'MltBingDecodeMVT',
    'MltBingDecodeMLT',
    'MltFastPforDecodeMLT',
    'MltWorkerParseOnlySyntheticSymbolMVT',
    'MltWorkerParseOnlySyntheticSymbolMLT',
    'MltWorkerParseOnlySyntheticLineSymbolMVT',
    'MltWorkerParseOnlySyntheticLineSymbolMLT',
    'MltQueryRendered0MVT',
    'MltQueryRendered0MLT',
    'MltQueryRendered1MVT',
    'MltQueryRendered1MLT',
    'MltQueryRendered10MVT',
    'MltQueryRendered10MLT',
    'MltQueryRenderedManyMVT',
    'MltQueryRenderedManyMLT',
    'MltQuerySource1PctMVT',
    'MltQuerySource1PctMLT',
    'MltQuerySource10PctMVT',
    'MltQuerySource10PctMLT',
    'MltQuerySource100PctMVT',
    'MltQuerySource100PctMLT',
    'MltFeatureStateRepeatedMLT',
    'MltMemoryLifecycleMLT',
    'MltTransferRawCopyMLT',
    'MltTransferRawSharedMLT',
    'MltTransferQuerySnapshotMLT',
    'MltTransferFeatureTablesMLT',
    'MltOverzoomZPlus1MLT',
    'MltOverzoomZPlus2MLT',
    'MltOverzoomZPlus4MLT',
    'MltColumns5ReadFew',
    'MltColumns5ReadMany',
    'MltColumns50ReadFew',
    'MltColumns50ReadMany',
    'MltColumns200ReadFew',
    'MltColumns200ReadMany',
] as const;

export const mltBenchmarkFactories: Record<string, MltBenchmarkFactory> = {
    MltWorkerParseOnlyMVT: () => new MltWorkerParse('mvt'),
    MltWorkerParseOnlyMLTNative: () => new MltWorkerParse('mlt'),
    MltWorkerParseOnlySyntheticLineMVT: () => new MltWorkerParse('mvt', 'line'),
    MltWorkerParseOnlySyntheticLineMLT: () => new MltWorkerParse('mlt', 'line'),
    MltWorkerParseOnlySyntheticFillMVT: () => new MltWorkerParse('mvt', 'fill'),
    MltWorkerParseOnlySyntheticFillMLT: () => new MltWorkerParse('mlt', 'fill'),
    MltWorkerParseOnlySyntheticCircleMVT: () => new MltWorkerParse('mvt', 'circle'),
    MltWorkerParseOnlySyntheticCircleMLT: () => new MltWorkerParse('mlt', 'circle'),
    MltWorkerParseOnlySyntheticFillExtrusionMVT: () => new MltWorkerParse('mvt', 'fill-extrusion'),
    MltWorkerParseOnlySyntheticFillExtrusionMLT: () => new MltWorkerParse('mlt', 'fill-extrusion'),
    MltWorkerParseOnlySyntheticSymbolMVT: () => new MltWorkerParse('mvt', 'symbol'),
    MltWorkerParseOnlySyntheticSymbolMLT: () => new MltWorkerParse('mlt', 'symbol'),
    MltWorkerParseOnlySyntheticLineSymbolMVT: () => new MltWorkerParse('mvt', 'symbol-line', 5),
    MltWorkerParseOnlySyntheticLineSymbolMLT: () => new MltWorkerParse('mlt', 'symbol-line', 5),
    MltRealTileScanMVT: () => new MltRealTileScan('mvt'),
    MltRealTileScanMLT: () => new MltRealTileScan('mlt'),
    MltRealTileDecodeMVT: () => new MltRealTileDecode('mvt'),
    MltRealTileDecodeMLT: () => new MltRealTileDecode('mlt'),
    MltRealTileDecodeMLTProjected: () => new MltRealTileDecode('mlt', 'layers', 'style'),
    MltRealTileDecodeMetadataMVT: () => new MltRealTileDecode('mvt', 'metadata'),
    MltRealTileDecodeMetadataMLT: () => new MltRealTileDecode('mlt', 'metadata'),
    MltRealTileDecodePropertiesOneMVT: () => new MltRealTileDecode('mvt', 'properties-one'),
    MltRealTileDecodePropertiesOneMLT: () => new MltRealTileDecode('mlt', 'properties-one'),
    MltRealTileDecodePropertiesEnumerateMVT: () => new MltRealTileDecode('mvt', 'properties-enumerate'),
    MltRealTileDecodePropertiesEnumerateMLT: () => new MltRealTileDecode('mlt', 'properties-enumerate'),
    MltRealTileDecodeGeometryMVT: () => new MltRealTileDecode('mvt', 'geometry'),
    MltRealTileDecodeGeometryMLT: () => new MltRealTileDecode('mlt', 'geometry'),
    MltRealTileDecodeToGeoJSONMVT: () => new MltRealTileDecode('mvt', 'to-geojson'),
    MltRealTileDecodeToGeoJSONMLT: () => new MltRealTileDecode('mlt', 'to-geojson'),
    MltRealTileDecodeFullAccessMVT: () => new MltRealTileDecode('mvt', 'full'),
    MltRealTileDecodeFullAccessMLT: () => new MltRealTileDecode('mlt', 'full'),
    MltRealTileParseOnlyMVT: () => new MltRealTileWorkerParse('mvt'),
    MltRealTileParseOnlyMLTNative: () => new MltRealTileWorkerParse('mlt'),
    MltRealTileEndToEndMVT: () => new MltRealTileEndToEnd('mvt'),
    MltRealTileEndToEndMLT: () => new MltRealTileEndToEnd('mlt'),
    MltOmtBuildingDecodeMVT: () => new MltOmtCorpusDecode('mvt', 'building'),
    MltOmtBuildingDecodeMLT: () => new MltOmtCorpusDecode('mlt', 'building'),
    MltOmtRoadLabelsDecodeMVT: () => new MltOmtCorpusDecode('mvt', 'roads-labels'),
    MltOmtRoadLabelsDecodeMLT: () => new MltOmtCorpusDecode('mlt', 'roads-labels'),
    MltOmtLowZoomLabelsDecodeMVT: () => new MltOmtCorpusDecode('mvt', 'lowzoom-labels'),
    MltOmtLowZoomLabelsDecodeMLT: () => new MltOmtCorpusDecode('mlt', 'lowzoom-labels'),
    MltOmtLineSymbolsMVT: () => new MltOmtLineSymbols('mvt'),
    MltOmtLineSymbolsMLT: () => new MltOmtLineSymbols('mlt'),
    MltBingDecodeMVT: () => new MltBingDecode('mvt'),
    MltBingDecodeMLT: () => new MltBingDecode('mlt'),
    MltFastPforDecodeMLT: () => new MltFastPforDecode(),
    MltColumns5ReadFew: () => new MltColumnProjectionMatrix(5, 'few'),
    MltColumns5ReadMany: () => new MltColumnProjectionMatrix(5, 'many'),
    MltColumns50ReadFew: () => new MltColumnProjectionMatrix(50, 'few'),
    MltColumns50ReadMany: () => new MltColumnProjectionMatrix(50, 'many'),
    MltColumns200ReadFew: () => new MltColumnProjectionMatrix(200, 'few'),
    MltColumns200ReadMany: () => new MltColumnProjectionMatrix(200, 'many'),
    MltFeatureStateRepeatedMLT: () => new MltRepeatedFeatureState(),
    MltMemoryLifecycleMLT: () => new MltMemoryLifecycle(),
    MltTransferRawCopyMLT: () => new MltTransferStrategy('raw-copy'),
    MltTransferRawSharedMLT: () => new MltTransferStrategy('raw-shared'),
    MltTransferQuerySnapshotMLT: () => new MltTransferStrategy('query-snapshot'),
    MltTransferFeatureTablesMLT: () => new MltTransferStrategy('feature-tables'),
    MltOverzoomZPlus1MLT: () => new MltOverzoom(1),
    MltOverzoomZPlus2MLT: () => new MltOverzoom(2),
    MltOverzoomZPlus4MLT: () => new MltOverzoom(4),
    MltQueryRendered0MVT: () => new MltRenderedQuery('mvt', '0'),
    MltQueryRendered0MLT: () => new MltRenderedQuery('mlt', '0'),
    MltQueryRendered1MVT: () => new MltRenderedQuery('mvt', '1'),
    MltQueryRendered1MLT: () => new MltRenderedQuery('mlt', '1'),
    MltQueryRendered10MVT: () => new MltRenderedQuery('mvt', '10'),
    MltQueryRendered10MLT: () => new MltRenderedQuery('mlt', '10'),
    MltQueryRenderedManyMVT: () => new MltRenderedQuery('mvt', 'many'),
    MltQueryRenderedManyMLT: () => new MltRenderedQuery('mlt', 'many'),
    MltQuerySource1PctMVT: () => new MltSourceQuery('mvt', '1pct'),
    MltQuerySource1PctMLT: () => new MltSourceQuery('mlt', '1pct'),
    MltQuerySource10PctMVT: () => new MltSourceQuery('mvt', '10pct'),
    MltQuerySource10PctMLT: () => new MltSourceQuery('mlt', '10pct'),
    MltQuerySource100PctMVT: () => new MltSourceQuery('mvt', '100pct'),
    MltQuerySource100PctMLT: () => new MltSourceQuery('mlt', '100pct'),
};

const extendedQueryAccessModes: QueryResultAccess[] = [
    'none',
    'metadata',
    'property-one',
    'properties',
    'geometry',
    'json',
];

function queryAccessSuffix(access: QueryResultAccess): string {
    return access.split('-').map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join('');
}

/**
 * The extended matrix is opt-in because the 10k/full-serialization cases are
 * deliberately expensive. Run it with `bench:mlt-isolated -- --suite extended`.
 */
export const mltExtendedBenchmarkNames: string[] = [];

for (const matrixCase of mltLineSymbolMatrixCases) {
    const suffix = matrixCase.name.split('-').map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join('');
    const reference = `MltLineSymbolMatrix${suffix}MVT`;
    const candidate = `MltLineSymbolMatrix${suffix}MLT`;
    mltExtendedBenchmarkNames.push(reference, candidate);
    mltBenchmarkComparisonPairs.push({reference, candidate});
    const parsesPerIteration = matrixCase.name === 'sparse' || matrixCase.name === 'merge-short'
        ? 5
        : matrixCase.featureCount >= 2048 ? 1 : matrixCase.featureCount >= 1024 ? 2 : 3;
    mltBenchmarkFactories[reference] = () => new MltWorkerParse('mvt', 'symbol-line', parsesPerIteration, matrixCase);
    mltBenchmarkFactories[candidate] = () => new MltWorkerParse('mlt', 'symbol-line', parsesPerIteration, matrixCase);
}

for (const queryKind of ['Rendered', 'Source'] as const) {
    const benchmarkName = `MltPublic${queryKind}Aggregation10000`;
    mltExtendedBenchmarkNames.push(benchmarkName);
    mltBenchmarkFactories[benchmarkName] = () => new MltPublicQueryAggregation(queryKind === 'Rendered' ? 'rendered' : 'source');
}

for (const queryKind of ['Rendered', 'Source'] as const) {
    for (const temperature of ['First', 'Warm'] as const) {
        const reference = `MltQuery${queryKind}${temperature}MVT`;
        const candidate = `MltQuery${queryKind}${temperature}MLT`;
        mltExtendedBenchmarkNames.push(reference, candidate);
        mltBenchmarkComparisonPairs.push({reference, candidate});
        const queryKindValue = queryKind === 'Rendered' ? 'rendered' : 'source';
        const temperatureValue = temperature === 'First' ? 'first' : 'warm';
        mltBenchmarkFactories[reference] = () => new MltQueryTemperature('mvt', queryKindValue, temperatureValue);
        mltBenchmarkFactories[candidate] = () => new MltQueryTemperature('mlt', queryKindValue, temperatureValue);
    }
}

for (const featureCount of [640, 10_000] as const) {
    for (const access of extendedQueryAccessModes) {
        if (featureCount === 640 && access === 'none') continue;
        const accessSuffix = queryAccessSuffix(access);
        for (const queryKind of ['RenderedMany', 'Source100Pct'] as const) {
            const prefix = `MltQuery${queryKind}${featureCount}${accessSuffix}`;
            const reference = `${prefix}MVT`;
            const candidate = `${prefix}MLT`;
            mltExtendedBenchmarkNames.push(reference, candidate);
            mltBenchmarkComparisonPairs.push({reference, candidate});
            if (queryKind === 'RenderedMany') {
                mltBenchmarkFactories[reference] = () => new MltRenderedQuery('mvt', 'many', access, featureCount);
                mltBenchmarkFactories[candidate] = () => new MltRenderedQuery('mlt', 'many', access, featureCount);
            } else {
                mltBenchmarkFactories[reference] = () => new MltSourceQuery('mvt', '100pct', access, featureCount);
                mltBenchmarkFactories[candidate] = () => new MltSourceQuery('mlt', '100pct', access, featureCount);
            }
        }
    }
}

for (const cardinality of ['0', '1', '10'] as const) {
    const reference = `MltQueryRendered${cardinality}10000MVT`;
    const candidate = `MltQueryRendered${cardinality}10000MLT`;
    mltExtendedBenchmarkNames.push(reference, candidate);
    mltBenchmarkComparisonPairs.push({reference, candidate});
    mltBenchmarkFactories[reference] = () => new MltRenderedQuery('mvt', cardinality, 'none', 10_000);
    mltBenchmarkFactories[candidate] = () => new MltRenderedQuery('mlt', cardinality, 'none', 10_000);
}

for (const featureCount of [640, 10_000] as const) {
    const reference = `MltQueryRenderedMany${featureCount}RealIntersectionMVT`;
    const candidate = `MltQueryRenderedMany${featureCount}RealIntersectionMLT`;
    mltExtendedBenchmarkNames.push(reference, candidate);
    mltBenchmarkComparisonPairs.push({reference, candidate});
    mltBenchmarkFactories[reference] = () => new MltRenderedQuery('mvt', 'many', 'none', featureCount, 'real');
    mltBenchmarkFactories[candidate] = () => new MltRenderedQuery('mlt', 'many', 'none', featureCount, 'real');
}

for (const selectivity of ['1pct', '10pct'] as const) {
    const suffix = selectivity === '1pct' ? '1Pct' : '10Pct';
    const reference = `MltQuerySource${suffix}10000MVT`;
    const candidate = `MltQuerySource${suffix}10000MLT`;
    mltExtendedBenchmarkNames.push(reference, candidate);
    mltBenchmarkComparisonPairs.push({reference, candidate});
    mltBenchmarkFactories[reference] = () => new MltSourceQuery('mvt', selectivity, 'none', 10_000);
    mltBenchmarkFactories[candidate] = () => new MltSourceQuery('mlt', selectivity, 'none', 10_000);
}

for (const idMode of ['int32', 'signed-int64', 'absent', 'promote-id'] as QueryIdMode[]) {
    const idSuffix = idMode.split('-').map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join('');
    const reference = `MltQuerySource100Pct10000Id${idSuffix}MVT`;
    const candidate = `MltQuerySource100Pct10000Id${idSuffix}MLT`;
    mltExtendedBenchmarkNames.push(reference, candidate);
    mltBenchmarkComparisonPairs.push({reference, candidate});
    mltBenchmarkFactories[reference] = () => new MltSourceQuery('mvt', '100pct', 'metadata', 10_000, idMode);
    mltBenchmarkFactories[candidate] = () => new MltSourceQuery('mlt', '100pct', 'metadata', 10_000, idMode);
}

for (const traversal of ['reverse', 'pseudo-random'] as DecodeTraversal[]) {
    const traversalSuffix = traversal.split('-').map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join('');
    const reference = `MltRealTileDecodeFullAccess${traversalSuffix}MVT`;
    const candidate = `MltRealTileDecodeFullAccess${traversalSuffix}MLT`;
    mltExtendedBenchmarkNames.push(reference, candidate);
    mltBenchmarkComparisonPairs.push({reference, candidate});
    mltBenchmarkFactories[reference] = () => new MltRealTileDecode('mvt', 'full', 'all', traversal);
    mltBenchmarkFactories[candidate] = () => new MltRealTileDecode('mlt', 'full', 'all', traversal);
}
