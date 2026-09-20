import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import minimist from 'minimist';
import {exceedsBudget, getNumberAtPath, MLT_BENCHMARK_PERCENTILE_METHOD, summarizeRatios} from './lib/mlt_benchmark_statistics.ts';

type Distribution = {median: number; p95: number; min: number; max: number};
type BenchmarkResult = {
    benchmark: string;
    iterations: number;
    warmup: number;
    durationSamplesMs?: number[];
    durationMs: Distribution;
    memoryBytes: Record<string, number>;
    measurements?: Record<string, unknown>;
    materializations: {perIteration: Record<string, number>; estimatedBytesPerQueryResult?: number};
};
type BenchmarkComparison = {
    reference: string;
    candidate: string;
    iterations: number;
    warmup: number;
    executionOrder: string;
    referenceDurationMs: Distribution;
    candidateDurationMs: Distribution;
    referenceDurationSamplesMs?: number[];
    candidateDurationSamplesMs?: number[];
};
type BenchmarkReport = {
    commit: string;
    node: string;
    cpu: string;
    iterations: number;
    warmup: number;
    statistics?: {
        percentileMethod?: string;
        minimumIterations?: number;
        minimumWarmup?: number;
    };
    benchmarks: BenchmarkResult[];
    comparisons?: BenchmarkComparison[];
};
type RelativePair = {
    name: string;
    reference: string;
    candidate: string;
    medianMultiplier?: number;
    p95Multiplier?: number;
    maxMedianRatio?: number;
    maxP95Ratio?: number;
    maxAbsoluteMedianRatio?: number;
    maxAbsoluteP95Ratio?: number;
};
type MaterializationInvariant = {
    zero?: string[];
    exact?: Record<string, number>;
    maximum?: Record<string, number>;
    equal?: Record<string, string>;
};
type BudgetConfig = {
    baseline: string;
    minimumIterations: number;
    minimumWarmup: number;
    comparisonRelativeTolerance: number;
    defaultMedianMultiplier: number;
    defaultP95Multiplier: number;
    relativePairs: RelativePair[];
    materializations: Record<string, MaterializationInvariant>;
    exactMeasurements?: Record<string, Record<string, number>>;
    maximumMeasurements: Record<string, Record<string, number>>;
};

const argv = minimist(process.argv.slice(2), {string: ['report', 'baseline', 'budgets']});
if (!argv.report) {
    throw new Error('Usage: check-mlt-budgets.ts --report <report.json> [--baseline <baseline.json>] [--budgets <budgets.json>]');
}

const budgetPath = resolve(String(argv.budgets ?? 'test/bench/baselines/mlt-budgets.json'));
const config = readJson<BudgetConfig>(budgetPath);
const baselinePath = resolve(String(argv.baseline ?? config.baseline));
const reportPath = resolve(String(argv.report));
const baseline = readJson<BenchmarkReport>(baselinePath);
const report = readJson<BenchmarkReport>(reportPath);
const baselineByName = indexBenchmarks(baseline);
const reportByName = indexBenchmarks(report);
const baselineComparisons = indexComparisons(baseline);
const reportComparisons = indexComparisons(report);
const failures: string[] = [];

validateSampling('baseline', baseline, config.minimumIterations, config.minimumWarmup, failures);
validateSampling('report', report, config.minimumIterations, config.minimumWarmup, failures);

if (nodeMajor(report.node) !== nodeMajor(baseline.node)) {
    failures.push(`Node major mismatch: report=${report.node}, baseline=${baseline.node}`);
}

console.log(`MLT budget check: ${report.commit} (${report.node}, ${report.cpu})`);
console.log(`Baseline: ${baseline.commit} (${baseline.node}, ${baseline.cpu})`);
console.log('');
console.log('Normalized MLT/MVT duration ratios:');

for (const pair of config.relativePairs) {
    const baselineReference = requireBenchmark(baselineByName, pair.reference, 'baseline', failures);
    const baselineCandidate = requireBenchmark(baselineByName, pair.candidate, 'baseline', failures);
    const reportReference = requireBenchmark(reportByName, pair.reference, 'report', failures);
    const reportCandidate = requireBenchmark(reportByName, pair.candidate, 'report', failures);
    const baselineComparison = requireComparison(baselineComparisons, pair, 'baseline', failures);
    const reportComparison = requireComparison(reportComparisons, pair, 'report', failures);
    if (!baselineReference || !baselineCandidate || !reportReference || !reportCandidate || !baselineComparison || !reportComparison) continue;

    const median = checkNormalizedMetric(
        pair,
        'median',
        baselineComparison,
        reportComparison,
        pair.medianMultiplier ?? config.defaultMedianMultiplier,
        config.comparisonRelativeTolerance,
        failures,
    );
    const p95 = checkNormalizedMetric(
        pair,
        'p95',
        baselineComparison,
        reportComparison,
        pair.p95Multiplier ?? config.defaultP95Multiplier,
        config.comparisonRelativeTolerance,
        failures,
    );
    checkOptionalMaximum(`${pair.name} median ratio`, median.current, pair.maxMedianRatio, config.comparisonRelativeTolerance, failures);
    checkOptionalMaximum(`${pair.name} p95 ratio`, p95.current, pair.maxP95Ratio, config.comparisonRelativeTolerance, failures);
    const absoluteMedianRatio = reportComparison.candidateDurationMs.median / reportComparison.referenceDurationMs.median;
    const absoluteP95Ratio = reportComparison.candidateDurationMs.p95 / reportComparison.referenceDurationMs.p95;
    checkOptionalMaximum(`${pair.name} absolute median ratio`, absoluteMedianRatio, pair.maxAbsoluteMedianRatio, config.comparisonRelativeTolerance, failures);
    checkOptionalMaximum(`${pair.name} absolute p95 ratio`, absoluteP95Ratio, pair.maxAbsoluteP95Ratio, config.comparisonRelativeTolerance, failures);
    console.log(`- ${pair.name}: median ${formatRatio(median.current)} (baseline ${formatRatio(median.baseline)}), p95 ${formatRatio(p95.current)} (baseline ${formatRatio(p95.baseline)}), absolute p95 ${formatRatio(absoluteP95Ratio)}`);
}

console.log('');
console.log('Materialization invariants:');
for (const [benchmarkName, invariant] of Object.entries(config.materializations)) {
    const benchmark = requireBenchmark(reportByName, benchmarkName, 'report', failures);
    if (!benchmark) continue;
    const counters = benchmark.materializations.perIteration;

    for (const counter of invariant.zero ?? []) {
        checkEqual(`${benchmarkName}.${counter}`, counters[counter] ?? 0, 0, failures);
    }
    for (const [counter, expected] of Object.entries(invariant.exact ?? {})) {
        checkEqual(`${benchmarkName}.${counter}`, counters[counter] ?? 0, expected, failures);
    }
    for (const [counter, maximum] of Object.entries(invariant.maximum ?? {})) {
        checkMaximum(`${benchmarkName}.${counter}`, counters[counter] ?? 0, maximum, config.comparisonRelativeTolerance, failures);
    }
    for (const [left, right] of Object.entries(invariant.equal ?? {})) {
        checkEqual(`${benchmarkName}.${left}`, counters[left] ?? 0, counters[right] ?? 0, failures, right);
    }
    console.log(`- ${benchmarkName}: checked`);
}

console.log('');
console.log('Observability, memory, and transfer budgets:');
for (const [benchmarkName, exactValues] of Object.entries(config.exactMeasurements ?? {})) {
    const benchmark = requireBenchmark(reportByName, benchmarkName, 'report', failures);
    if (!benchmark) continue;
    for (const [path, expected] of Object.entries(exactValues)) {
        const value = getNumberAtPath(benchmark, path);
        if (value === undefined) {
            failures.push(`${benchmarkName}.${path} is missing`);
            continue;
        }
        checkEqual(`${benchmarkName}.${path}`, value, expected, failures);
    }
    console.log(`- ${benchmarkName}: exact observability metrics checked`);
}
for (const [benchmarkName, maximums] of Object.entries(config.maximumMeasurements)) {
    const benchmark = requireBenchmark(reportByName, benchmarkName, 'report', failures);
    if (!benchmark) continue;
    for (const [path, maximum] of Object.entries(maximums)) {
        const value = getNumberAtPath(benchmark, path);
        if (value === undefined) {
            failures.push(`${benchmarkName}.${path} is missing`);
            continue;
        }
        checkMaximum(`${benchmarkName}.${path}`, value, maximum, config.comparisonRelativeTolerance, failures);
    }
    console.log(`- ${benchmarkName}: checked`);
}

if (failures.length > 0) {
    console.error('');
    console.error(`MLT budgets failed (${failures.length}):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
} else {
    console.log('');
    console.log('All MLT performance, memory, and materialization budgets passed.');
}

function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function indexBenchmarks(reportToIndex: BenchmarkReport): Map<string, BenchmarkResult> {
    return new Map(reportToIndex.benchmarks.map((benchmark) => [benchmark.benchmark, benchmark]));
}

function comparisonKey(reference: string, candidate: string): string {
    return `${reference}\0${candidate}`;
}

function indexComparisons(reportToIndex: BenchmarkReport): Map<string, BenchmarkComparison> {
    return new Map((reportToIndex.comparisons ?? []).map((comparison) => [
        comparisonKey(comparison.reference, comparison.candidate),
        comparison,
    ]));
}

function requireBenchmark(
    benchmarks: Map<string, BenchmarkResult>,
    name: string,
    source: string,
    errors: string[],
): BenchmarkResult | undefined {
    const benchmark = benchmarks.get(name);
    if (!benchmark) errors.push(`${source} is missing benchmark ${name}`);
    return benchmark;
}

function requireComparison(
    comparisons: Map<string, BenchmarkComparison>,
    pair: RelativePair,
    source: string,
    errors: string[],
): BenchmarkComparison | undefined {
    const comparison = comparisons.get(comparisonKey(pair.reference, pair.candidate));
    if (!comparison) errors.push(`${source} is missing paired comparison ${pair.reference} / ${pair.candidate}`);
    return comparison;
}

function validateSampling(source: string, benchmarkReport: BenchmarkReport, minimumIterations: number, minimumWarmup: number, errors: string[]): void {
    if (benchmarkReport.iterations < minimumIterations) {
        errors.push(`${source} has ${benchmarkReport.iterations} iterations; at least ${minimumIterations} are required`);
    }
    if (benchmarkReport.statistics?.percentileMethod !== MLT_BENCHMARK_PERCENTILE_METHOD) {
        errors.push(`${source} must use percentile method ${MLT_BENCHMARK_PERCENTILE_METHOD}`);
    }
    if (benchmarkReport.warmup < minimumWarmup) {
        errors.push(`${source} has ${benchmarkReport.warmup} warmups; at least ${minimumWarmup} are required`);
    }
    for (const benchmark of benchmarkReport.benchmarks) {
        if (benchmark.iterations !== benchmarkReport.iterations) {
            errors.push(`${source}.${benchmark.benchmark} has ${benchmark.iterations} iterations; expected ${benchmarkReport.iterations}`);
        }
        if (benchmark.warmup !== benchmarkReport.warmup) {
            errors.push(`${source}.${benchmark.benchmark} has ${benchmark.warmup} warmups; expected ${benchmarkReport.warmup}`);
        }
        if (benchmark.durationSamplesMs?.length !== benchmark.iterations) {
            errors.push(`${source}.${benchmark.benchmark} must retain all ${benchmark.iterations} duration samples`);
        }
    }
    for (const comparison of benchmarkReport.comparisons ?? []) {
        const label = `${source}.${comparison.reference}/${comparison.candidate}`;
        if (comparison.iterations !== benchmarkReport.iterations) {
            errors.push(`${label} has ${comparison.iterations} iterations; expected ${benchmarkReport.iterations}`);
        }
        if (comparison.warmup !== benchmarkReport.warmup) {
            errors.push(`${label} has ${comparison.warmup} warmups; expected ${benchmarkReport.warmup}`);
        }
        if (comparison.executionOrder !== 'alternating') {
            errors.push(`${label} must alternate reference and candidate execution order`);
        }
        if (comparison.referenceDurationSamplesMs?.length !== comparison.iterations ||
            comparison.candidateDurationSamplesMs?.length !== comparison.iterations) {
            errors.push(`${label} must retain both sets of ${comparison.iterations} duration samples`);
        }
    }
}

function checkNormalizedMetric(
    pair: RelativePair,
    metric: 'median' | 'p95',
    baselineComparison: BenchmarkComparison,
    reportComparison: BenchmarkComparison,
    multiplier: number,
    relativeTolerance: number,
    errors: string[],
): {baseline: number; current: number} {
    const baselineRatios = pairedRatioDistribution(baselineComparison);
    const currentRatios = pairedRatioDistribution(reportComparison);
    const baselineRatio = baselineRatios[metric];
    const currentRatio = currentRatios[metric];
    const maximum = baselineRatio * multiplier;
    if (exceedsBudget(currentRatio, maximum, relativeTolerance)) {
        errors.push(`${pair.name} ${metric} normalized ratio ${formatPreciseRatio(currentRatio)} exceeds ${formatPreciseRatio(maximum)} (${multiplier.toFixed(2)}x baseline ratio)`);
    }
    return {baseline: baselineRatio, current: currentRatio};
}

function pairedRatioDistribution(comparison: BenchmarkComparison): Distribution {
    const references = comparison.referenceDurationSamplesMs;
    const candidates = comparison.candidateDurationSamplesMs;
    if (!references || !candidates || references.length !== candidates.length || references.length === 0) {
        return {median: Number.NaN, p95: Number.NaN, min: Number.NaN, max: Number.NaN};
    }
    return summarizeRatios(candidates, references);
}

function checkEqual(label: string, actual: number, expected: number, errors: string[], expectedLabel?: string): void {
    if (actual !== expected) {
        errors.push(`${label}=${actual} must equal ${expectedLabel ? `${expectedLabel}=${expected}` : expected}`);
    }
}

function checkMaximum(label: string, actual: number, maximum: number, relativeTolerance: number, errors: string[]): void {
    if (exceedsBudget(actual, maximum, relativeTolerance)) {
        errors.push(`${label}=${actual} exceeds ${maximum}`);
    }
}

function checkOptionalMaximum(label: string, actual: number, maximum: number | undefined, relativeTolerance: number, errors: string[]): void {
    if (maximum !== undefined) checkMaximum(label, actual, maximum, relativeTolerance, errors);
}

function nodeMajor(version: string): number {
    return Number(/^v?(\d+)/.exec(version)?.[1]);
}

function formatRatio(value: number): string {
    return Number.isFinite(value) ? value.toFixed(3) : String(value);
}

function formatPreciseRatio(value: number): string {
    return Number.isFinite(value) ? value.toFixed(6) : String(value);
}
