export const mltMaterializationCounterNames = [
    'workerFilterFallbackFeatures',
    'vectorTileFeatureWrappers',
    'propertyObjects',
    'propertyProxyMisses',
    'pointObjects',
    'geometryPartsMaterialized',
    'queryCandidates',
    'queryResults',
    'estimatedQueryResultBytes',
    'queryGeometriesLoaded',
    'overzoomFeaturesClipped',
    'overzoomPointObjects',
    'mvtReencodes',
    'rawTileBytesCopied',
    'rawTileMainThreadDecodes',
    'decodedLayers',
    'decodedColumns',
    'decodedValues',
    'decodedColumnBytes',
    'temporaryScalarBuffers',
    'temporaryScalarValues',
    'coordinateTuples',
    'propertyDescriptors',
    'pretriangulatedFillFeatures',
    'pretriangulatedFillTriangles',
] as const;

// Shallow retained-size estimates used by the benchmark instrumentation. They
// deliberately exclude lazily materialized properties and geometry, which are
// counted separately, and must not be interpreted as exact V8 heap sizes.
export const MLT_ESTIMATED_GEOJSON_QUERY_RESULT_BYTES = 96;
export const MLT_ESTIMATED_RENDERED_QUERY_WRAPPER_BYTES = 48;

export type MltMaterializationCounter = typeof mltMaterializationCounterNames[number];

export type MltMaterializationContext = {
    sourceLayerId?: string;
    layerId?: string;
    layerType?: string;
    detail?: string;
};

export type MltMaterializationEvent = MltMaterializationContext & {
    counter: MltMaterializationCounter;
    amount: number;
};

export type MltMaterializationStats = {
    counters: Record<MltMaterializationCounter, number>;
    strict: boolean;
    forbiddenCounters: ReadonlySet<MltMaterializationCounter>;
    events?: MltMaterializationEvent[];
};

export type MltMaterializationStatsOptions = {
    strict?: boolean;
    captureEvents?: boolean;
    forbiddenCounters?: Iterable<MltMaterializationCounter>;
};

const defaultForbiddenCounters: ReadonlySet<MltMaterializationCounter> = new Set([
    'workerFilterFallbackFeatures',
    'vectorTileFeatureWrappers',
    'propertyObjects',
    'pointObjects',
    'geometryPartsMaterialized',
    'overzoomPointObjects',
    'mvtReencodes',
    'rawTileMainThreadDecodes',
    'coordinateTuples',
    'propertyDescriptors',
]);

let activeStats: MltMaterializationStats | undefined;

function emptyCounters(): Record<MltMaterializationCounter, number> {
    return Object.fromEntries(
        mltMaterializationCounterNames.map((counter) => [counter, 0])
    ) as Record<MltMaterializationCounter, number>;
}

export function createMltMaterializationStats(options: MltMaterializationStatsOptions = {}): MltMaterializationStats {
    return {
        counters: emptyCounters(),
        strict: options.strict ?? false,
        forbiddenCounters: new Set(options.forbiddenCounters ?? defaultForbiddenCounters),
        events: options.captureEvents ? [] : undefined,
    };
}

/**
 * Enables MLT instrumentation in the current JavaScript realm. The returned cleanup
 * callback restores the previously active collector, which keeps nested tests safe.
 */
export function activateMltMaterializationStats(stats: MltMaterializationStats): () => void {
    const previousStats = activeStats;
    activeStats = stats;
    return () => {
        activeStats = previousStats;
    };
}

export function isMltMaterializationStatsActive(): boolean {
    return activeStats !== undefined;
}

export function recordMltMaterialization(
    counter: MltMaterializationCounter,
    amount = 1,
    context?: MltMaterializationContext,
): void {
    const stats = activeStats;
    if (!stats || amount === 0) return;

    stats.counters[counter] += amount;
    stats.events?.push(context ? {counter, amount, ...context} : {counter, amount});

    if (stats.strict && amount > 0 && stats.forbiddenCounters.has(counter)) {
        const detail = context?.detail ? ` (${context.detail})` : '';
        throw new Error(`Forbidden MLT materialization: ${counter} += ${amount}${detail}`);
    }
}
