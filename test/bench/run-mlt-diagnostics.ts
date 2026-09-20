import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {Session} from 'node:inspector/promises';
import {cpus} from 'node:os';
import {dirname, resolve} from 'node:path';

import type {Benchmark, MltRealTileDecode} from './lib/mlt_worker_parse.ts';

/** Diagnostic snapshots are taken after returning to the event loop and two explicit collections. */
async function settledMemory() {
    await new Promise<void>((done) => setImmediate(done));
    globalThis.gc();
    await new Promise<void>((done) => setImmediate(done));
    globalThis.gc();
    const {heapUsed, external, arrayBuffers, rss} = process.memoryUsage();
    return {heapUsed, external, arrayBuffers, rss};
}

/** R7 percentiles retain the same convention as the campaign runner without importing its harness. */
function percentile(values: number[], fraction: number): number {
    const sorted = values.toSorted((a, b) => a - b);
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

/** Ordinary least squares is descriptive here, not a statistical leak-detection threshold. */
function slope(values: number[]): number {
    const center = (values.length - 1) / 2;
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < values.length; i++) {
        numerator += (i - center) * (values[i] - mean);
        denominator += (i - center) ** 2;
    }
    return numerator / denominator;
}

/** Samples occupy preallocated numeric buffers so growing retained report objects cannot mimic a leak. */
async function measureMemory(factory: () => Benchmark, cycles: number) {
    const keys = ['heapUsed', 'external', 'arrayBuffers', 'rss'] as const;
    const phaseNames = ['load', 'query', 'feature-state', 'overzoom', 'reload'];
    const samples = Object.fromEntries(keys.map((key) => [key, new Float64Array(cycles)]));
    const phases = Object.fromEntries(phaseNames.map((phase) => [phase, new Float64Array(cycles)]));
    const transfers = new Float64Array(cycles);
    const retainedBuffers = new Float64Array(cycles);
    const queries = new Float64Array(cycles);
    const beforeSetup = await settledMemory();
    let benchmark = factory();
    const weakBenchmark = new WeakRef(benchmark);
    await benchmark.setup();
    for (let i = 0; i < 10; i++) await benchmark.bench();
    const afterWarmup = await settledMemory();
    for (let i = 0; i < cycles; i++) {
        await benchmark.bench();
        const metrics = benchmark.takeIterationMetrics();
        assert.equal(metrics.values.queryResults, 64);
        queries[i] = metrics.values.queryResults;
        transfers[i] = metrics.transferredBytes;
        retainedBuffers[i] = metrics.retainedBytes;
        for (const phase of phaseNames) phases[phase][i] = metrics.phaseMemoryBytes[phase].heapUsed;
        const memory = await settledMemory();
        for (const key of keys) samples[key][i] = memory[key];
    }
    const afterCycles = await settledMemory();
    benchmark = undefined;
    const afterRelease = await settledMemory();
    const benchmarkCollected = weakBenchmark.deref() === undefined;
    const heapSamples = Array.from(samples.heapUsed);
    const lastHalf = heapSamples.slice(Math.floor(cycles / 2));
    const windowSize = Math.min(10, Math.floor(cycles / 2));
    return {
        warmup: 10,
        cycles,
        beforeSetup,
        afterWarmup,
        afterCycles,
        afterRelease,
        benchmarkCollected,
        heapTrend: {
            allCyclesBytesPerCycle: slope(heapSamples),
            lastHalfBytesPerCycle: slope(lastHalf),
            lastHalfRangeBytes: Math.max(...lastHalf) - Math.min(...lastHalf),
            lastWindowMinusFirstWindowMedianBytes: percentile(heapSamples.slice(-windowSize), 0.5) - percentile(heapSamples.slice(0, windowSize), 0.5),
            afterReleaseMinusBeforeSetupBytes: afterRelease.heapUsed - beforeSetup.heapUsed,
        },
        settledSamples: Object.fromEntries(keys.map((key) => [key, Array.from(samples[key])])),
        inScopePhaseHeapSamples: Object.fromEntries(phaseNames.map((phase) => [phase, Array.from(phases[phase])])),
        transferredBytes: Array.from(transfers),
        retainedBufferBytes: Array.from(retainedBuffers),
        queryResults: Array.from(queries),
        note: 'Node diagnostic harness; one synthetic lifecycle, no browser or GPU. The launch command determines Vite versus bundled loading. Phase snapshots retain in-scope tile objects; settled samples are after bench() returns. Forced GC and warmup make this a retention diagnostic, not a timing benchmark. Numeric sample buffers are allocated before beforeSetup.',
    };
}

/** Profiles the unchanged registry workload after warmup, excluding setup and diagnostic report generation. */
async function measureProfile(factory: () => Benchmark, iterations: number, outputPath: string) {
    const benchmark = factory();
    await benchmark.setup();
    for (let i = 0; i < 10; i++) {
        await benchmark.bench();
        benchmark.takeIterationMetrics();
    }
    await settledMemory();
    const session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', {interval: 1000});
    await session.post('Profiler.start');
    for (let i = 0; i < iterations; i++) {
        await benchmark.bench();
        benchmark.takeIterationMetrics();
    }
    const {profile} = await session.post('Profiler.stop');
    session.disconnect();
    writeFileSync(`${outputPath}.cpuprofile`, JSON.stringify(profile));
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const selfTimes = new Map<string, {functionName: string; url: string; lineNumber: number; microseconds: number}>();
    let totalMicroseconds = 0;
    for (let i = 0; i < profile.samples.length; i++) {
        const frame = nodes.get(profile.samples[i]).callFrame;
        const key = JSON.stringify([frame.functionName, frame.url, frame.lineNumber]);
        const row = selfTimes.get(key) ?? {...frame, microseconds: 0};
        row.microseconds += profile.timeDeltas[i];
        totalMicroseconds += profile.timeDeltas[i];
        selfTimes.set(key, row);
    }
    return {
        iterations,
        warmup: 10,
        workload: benchmark.getWorkload(),
        totalProfileMs: totalMicroseconds / 1000,
        profileFile: `${outputPath}.cpuprofile`,
        selfTimeByFunction: [...selfTimes.values()].sort((a, b) => b.microseconds - a.microseconds).map((row) => ({
            functionName: row.functionName,
            url: row.url,
            lineNumber: row.lineNumber,
            milliseconds: row.microseconds / 1000,
            percent: row.microseconds / totalMicroseconds * 100,
        })),
        note: 'Exclusive CPU samples, not nested times. Profiling perturbs timings; campaign results remain authoritative. Materialization instrumentation is disabled, as in paired campaign timings.',
    };
}

/** Tests the existing deferred option, preserving the official default-configuration campaign unchanged. */
async function measureGeometryOption(factory: () => Benchmark, iterations: number) {
    const {MLTVectorTile} = await import('../../src/source/vector_tile_mlt.ts');
    const {activateMltMaterializationStats, createMltMaterializationStats} = await import('../../src/util/mlt_materialization_stats.ts');
    const current = factory() as MltRealTileDecode;
    const deferred = factory() as MltRealTileDecode;
    deferred.options = {deferPropertyColumns: true};
    await current.setup();
    await deferred.setup();
    let comparedFeatures = 0;
    for (const buffer of current.buffers) {
        const left = new MLTVectorTile(buffer);
        const right = new MLTVectorTile(buffer, {deferPropertyColumns: true});
        assert.deepEqual(Object.keys(left.layers), Object.keys(right.layers));
        for (const layerName of Object.keys(left.layers)) {
            const leftLayer = left.layers[layerName];
            const rightLayer = right.layers[layerName];
            assert.equal(leftLayer.length, rightLayer.length);
            for (let i = 0; i < leftLayer.length; i++) {
                assert.deepEqual(leftLayer.feature(i).loadGeometry(), rightLayer.feature(i).loadGeometry());
                comparedFeatures++;
            }
        }
    }
    for (let i = 0; i < 100; i++) {
        const order = i % 2 ? [deferred, current] : [current, deferred];
        for (const benchmark of order) benchmark.bench();
    }
    await settledMemory();
    const currentSamples: number[] = [];
    const deferredSamples: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const order = i % 2 ? [deferred, current] : [current, deferred];
        for (const benchmark of order) {
            const start = performance.now();
            benchmark.bench();
            const duration = performance.now() - start;
            (benchmark === current ? currentSamples : deferredSamples).push(duration);
            await new Promise<void>((done) => setImmediate(done));
        }
    }
    const counters = [];
    for (const benchmark of [current, deferred]) {
        const stats = createMltMaterializationStats();
        const deactivate = activateMltMaterializationStats(stats);
        try {
            benchmark.bench();
        } finally {
            deactivate();
        }
        counters.push(stats.counters);
    }
    for (const key of ['pointObjects', 'geometryPartsMaterialized', 'vectorTileFeatureWrappers'] as const) {
        assert.equal(counters[0][key], counters[1][key]);
    }
    const ratios = deferredSamples.map((value, i) => value / currentSamples[i]);
    return {
        warmup: 100,
        iterations,
        executionOrder: 'alternating',
        comparedFeatures,
        currentSamplesMs: currentSamples,
        deferredSamplesMs: deferredSamples,
        ratioMedian: percentile(ratios, 0.5),
        ratioP95: percentile(ratios, 0.95),
        currentMedianMs: percentile(currentSamples, 0.5),
        deferredMedianMs: percentile(deferredSamples, 0.5),
        currentP95Ms: percentile(currentSamples, 0.95),
        deferredP95Ms: percentile(deferredSamples, 0.95),
        currentCounters: counters[0],
        deferredCounters: counters[1],
        publicQueryPathAlreadyDefersProperties: true,
        note: 'Diagnostic MLT/default versus MLT/deferPropertyColumns=true; no product change and no replacement for MVT/MLT budgets. FeatureIndex.loadVTLayers already opts into deferred decoding. One sample covers four tiles. Geometry equality is checked outside timing for every feature; counters are collected separately after timing. Warmup is deliberately extended to test steady-state sensitivity.',
    };
}

const [mode, name, output, countArgument = '100'] = process.argv.slice(2);
const count = Number(countArgument);
assert(['memory', 'profile', 'geometry'].includes(mode), 'Expected memory, profile or geometry, benchmark name, new output JSON path and optional count');
assert(output && Number.isInteger(count) && count >= 20);
assert(typeof globalThis.gc === 'function', 'Launch Node with --expose-gc');
const outputPath = resolve(output);
assert(!existsSync(outputPath) && !existsSync(`${outputPath}.cpuprofile`), 'Diagnostic outputs must be new files');
mkdirSync(dirname(outputPath), {recursive: true});
const beforeRegistryImport = await settledMemory();
const {mltBenchmarkFactories} = await import('./mlt_benchmark_registry.ts');
const afterRegistryImport = await settledMemory();
assert(mltBenchmarkFactories[name], `Unknown benchmark ${name}`);
assert(mode !== 'memory' || name === 'MltMemoryLifecycleMLT');
assert(mode !== 'geometry' || name === 'MltRealTileDecodeGeometryMLT');
const result = mode === 'memory'
    ? await measureMemory(mltBenchmarkFactories[name], count)
    : mode === 'geometry'
        ? await measureGeometryOption(mltBenchmarkFactories[name], count)
        : await measureProfile(mltBenchmarkFactories[name], count, outputPath);
const report = {
    generatedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    node: process.version,
    v8: process.versions.v8,
    launchArguments: process.execArgv,
    entryPoint: process.argv[1],
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    mltCommit: execFileSync('git', ['-C', '../maplibre-tile-spec', 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    cpu: cpus()[0].model,
    mode,
    name,
    beforeRegistryImport,
    afterRegistryImport,
    result,
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'});
console.log(JSON.stringify({outputPath, ...report, result: mode === 'memory' ? {
    ...result,
    settledSamples: undefined,
    inScopePhaseHeapSamples: undefined,
    transferredBytes: undefined,
    retainedBufferBytes: undefined,
    queryResults: undefined,
} : mode === 'profile' ? {...result, selfTimeByFunction: (result as Awaited<ReturnType<typeof measureProfile>>).selfTimeByFunction.slice(0, 15)} : {
    ...result,
    currentSamplesMs: undefined,
    deferredSamplesMs: undefined,
}}, null, 2));
