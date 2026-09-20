export type BenchmarkDistribution = {
    median: number;
    p95: number;
    min: number;
    max: number;
};

export const MLT_BENCHMARK_PERCENTILE_METHOD = 'linear-interpolation-r7';
export const MLT_BENCHMARK_MINIMUM_ITERATIONS = 30;
export const MLT_BENCHMARK_MINIMUM_WARMUP = 10;

export function percentile(sortedValues: number[], fraction: number): number {
    if (sortedValues.length === 0) throw new Error('Cannot calculate a percentile without samples.');
    if (fraction < 0 || fraction > 1) throw new Error(`Percentile fraction must be between 0 and 1: ${fraction}`);

    const position = (sortedValues.length - 1) * fraction;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    const lower = sortedValues[lowerIndex];
    const upper = sortedValues[upperIndex];
    return lower + (upper - lower) * (position - lowerIndex);
}

export function summarizeNumbers(values: number[]): BenchmarkDistribution {
    const sortedValues = [...values].sort((a, b) => a - b);
    return {
        median: percentile(sortedValues, 0.5),
        p95: percentile(sortedValues, 0.95),
        min: sortedValues[0],
        max: sortedValues[sortedValues.length - 1],
    };
}

export function summarizeRatios(numerators: number[], denominators: number[]): BenchmarkDistribution {
    if (numerators.length !== denominators.length) {
        throw new Error(`Cannot summarize ${numerators.length} numerators against ${denominators.length} denominators.`);
    }
    return summarizeNumbers(numerators.map((numerator, index) => numerator / denominators[index]));
}

export function exceedsBudget(actual: number, maximum: number, relativeTolerance: number): boolean {
    if (!Number.isFinite(actual) || !Number.isFinite(maximum)) return true;
    const scale = Math.max(1, Math.abs(actual), Math.abs(maximum));
    const floatingPointTolerance = Number.EPSILON * scale * 32;
    const configuredTolerance = Math.abs(maximum) * relativeTolerance;
    return actual - maximum > Math.max(floatingPointTolerance, configuredTolerance);
}

/** Resolves dotted paths while preserving literal object keys that contain dots. */
export function getNumberAtPath(value: unknown, path: string): number | undefined {
    if (value === null || typeof value !== 'object') return undefined;
    const object = value as Record<string, unknown>;
    if (Object.hasOwn(object, path)) {
        const exactValue = object[path];
        return typeof exactValue === 'number' ? exactValue : undefined;
    }

    for (let separator = path.lastIndexOf('.'); separator >= 0; separator = path.lastIndexOf('.', separator - 1)) {
        const prefix = path.slice(0, separator);
        if (!Object.hasOwn(object, prefix)) continue;
        const resolved = getNumberAtPath(object[prefix], path.slice(separator + 1));
        if (resolved !== undefined) return resolved;
    }
    return undefined;
}
