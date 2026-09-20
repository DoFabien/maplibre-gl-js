import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {cpus} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {constants as performanceConstants, PerformanceObserver, type PerformanceEntry} from 'node:perf_hooks';
import minimist from 'minimist';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../../src/util/mlt_materialization_stats.ts';
import {mltBenchmarkComparisonPairs, mltBenchmarkFactories, mltDefaultBenchmarkNames, mltExtendedBenchmarkNames} from './mlt_benchmark_registry.ts';
import {
    MLT_BENCHMARK_MINIMUM_ITERATIONS,
    MLT_BENCHMARK_MINIMUM_WARMUP,
    MLT_BENCHMARK_PERCENTILE_METHOD,
    summarizeNumbers,
} from './lib/mlt_benchmark_statistics.ts';

import type {Benchmark, BenchmarkIterationMetrics, BenchmarkMemorySnapshot} from './lib/mlt_worker_parse.ts';

type GcGlobal = typeof globalThis & {gc?: () => void};

type GcPerformanceEntry = PerformanceEntry & {
    kind?: number;
    detail?: {kind?: number};
};

type GcIterationSample = {
    count: number;
    durationMs: number;
    majorCount: number;
    minorCount: number;
    incrementalCount: number;
    weakCallbackCount: number;
    heapDeltaBytes: number;
};

type TimedIteration = {
    durationMs: number;
    gc: GcIterationSample;
};

const argv = minimist(process.argv.slice(2), {
    boolean: ['child', 'comparison'],
    string: ['suite'],
    default: {iterations: MLT_BENCHMARK_MINIMUM_ITERATIONS, warmup: MLT_BENCHMARK_MINIMUM_WARMUP},
});

function positiveInteger(value: unknown, name: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid --${name} value: ${value}`);
    }
    return parsed;
}

function memorySnapshot(): BenchmarkMemorySnapshot {
    const {heapUsed, rss, external, arrayBuffers} = process.memoryUsage();
    return {heapUsed, rss, external, arrayBuffers};
}

function maxMemory(left: BenchmarkMemorySnapshot, right: BenchmarkMemorySnapshot): BenchmarkMemorySnapshot {
    return {
        heapUsed: Math.max(left.heapUsed, right.heapUsed),
        rss: Math.max(left.rss, right.rss),
        external: Math.max(left.external, right.external),
        arrayBuffers: Math.max(left.arrayBuffers, right.arrayBuffers),
    };
}

function createGcTracker() {
    let queuedEntries: GcPerformanceEntry[] = [];
    const observer = new PerformanceObserver((list) => {
        queuedEntries.push(...list.getEntries() as GcPerformanceEntry[]);
    });
    observer.observe({entryTypes: ['gc']});

    const drain = (): GcPerformanceEntry[] => {
        const entries = queuedEntries;
        queuedEntries = [];
        entries.push(...observer.takeRecords() as GcPerformanceEntry[]);
        return entries;
    };

    return {
        beginIteration(): BenchmarkMemorySnapshot {
            drain();
            return memorySnapshot();
        },
        async finishIteration(before: BenchmarkMemorySnapshot): Promise<GcIterationSample> {
            // PerformanceObserver delivers GC entries asynchronously, even for a
            // synchronous benchmark. Give it one event-loop turn before taking
            // the records; otherwise those entries are observed during the next
            // iteration and discarded by beginIteration().
            await new Promise<void>((resolveIteration) => setImmediate(resolveIteration));
            const after = memorySnapshot();
            const entries = drain();
            let majorCount = 0;
            let minorCount = 0;
            let incrementalCount = 0;
            let weakCallbackCount = 0;
            let durationMs = 0;
            for (const entry of entries) {
                durationMs += entry.duration;
                switch (entry.detail?.kind ?? entry.kind) {
                    case performanceConstants.NODE_PERFORMANCE_GC_MAJOR:
                        majorCount++;
                        break;
                    case performanceConstants.NODE_PERFORMANCE_GC_MINOR:
                        minorCount++;
                        break;
                    case performanceConstants.NODE_PERFORMANCE_GC_INCREMENTAL:
                        incrementalCount++;
                        break;
                    case performanceConstants.NODE_PERFORMANCE_GC_WEAKCB:
                        weakCallbackCount++;
                        break;
                }
            }
            return {
                count: entries.length,
                durationMs,
                majorCount,
                minorCount,
                incrementalCount,
                weakCallbackCount,
                heapDeltaBytes: after.heapUsed - before.heapUsed,
            };
        },
        disconnect(): void {
            observer.disconnect();
        },
    };
}

async function measureIteration(
    benchmark: Benchmark,
    gcTracker: ReturnType<typeof createGcTracker>,
): Promise<TimedIteration> {
    const memoryBefore = gcTracker.beginIteration();
    const start = performance.now();
    await benchmark.bench();
    const durationMs = performance.now() - start;
    return {durationMs, gc: await gcTracker.finishIteration(memoryBefore)};
}

function summarizeGcSamples(samples: GcIterationSample[]) {
    return {
        count: summarizeNumbers(samples.map((sample) => sample.count)),
        durationMs: summarizeNumbers(samples.map((sample) => sample.durationMs)),
        majorCount: summarizeNumbers(samples.map((sample) => sample.majorCount)),
        minorCount: summarizeNumbers(samples.map((sample) => sample.minorCount)),
        incrementalCount: summarizeNumbers(samples.map((sample) => sample.incrementalCount)),
        weakCallbackCount: summarizeNumbers(samples.map((sample) => sample.weakCallbackCount)),
        heapDeltaBytes: summarizeNumbers(samples.map((sample) => sample.heapDeltaBytes)),
        totalCount: samples.reduce((sum, sample) => sum + sample.count, 0),
        totalDurationMs: samples.reduce((sum, sample) => sum + sample.durationMs, 0),
    };
}

function summarizeIterationMetrics(samples: BenchmarkIterationMetrics[]) {
    const result: Record<string, unknown> = {};
    for (const key of ['transferredBytes', 'retainedBytes'] as const) {
        const values = samples.flatMap((sample) => sample[key] === undefined ? [] : [sample[key]]);
        if (values.length > 0) result[key] = summarizeNumbers(values);
    }

    const valueNames = new Set(samples.flatMap((sample) => Object.keys(sample.values ?? {})));
    if (valueNames.size > 0) {
        result.values = Object.fromEntries(Array.from(valueNames, (name) => [
            name,
            summarizeNumbers(samples.flatMap((sample) => sample.values?.[name] === undefined ? [] : [sample.values[name]])),
        ]));
    }

    const phaseNames = new Set(samples.flatMap((sample) => Object.keys(sample.phaseMemoryBytes ?? {})));
    if (phaseNames.size > 0) {
        const memoryKeys: Array<keyof BenchmarkMemorySnapshot> = ['heapUsed', 'rss', 'external', 'arrayBuffers'];
        result.phaseMemoryBytes = Object.fromEntries(Array.from(phaseNames, (phase) => [
            phase,
            Object.fromEntries(memoryKeys.map((memoryKey) => [
                memoryKey,
                summarizeNumbers(samples.flatMap((sample) => {
                    const snapshot = sample.phaseMemoryBytes?.[phase];
                    return snapshot ? [snapshot[memoryKey]] : [];
                })),
            ])),
        ]));
    }

    return result;
}

function metadata() {
    const worktreeStatus = spawnSync('git', ['status', '--porcelain'], {
        cwd: process.cwd(),
        encoding: 'utf8',
    });
    return {
        commit: readGitHead(process.cwd()),
        worktreeDirty: worktreeStatus.status === 0
            ? worktreeStatus.stdout.trim().length > 0
            : null,
        node: process.version,
        cpu: cpus()[0]?.model ?? 'unknown',
        platform: `${process.platform}-${process.arch}`,
    };
}

function readGitHead(worktree: string): string {
    const dotGitPath = join(worktree, '.git');
    let gitDirectory = dotGitPath;
    if (!existsSync(dotGitPath)) return 'unknown';
    if (!statSync(dotGitPath).isDirectory()) {
        const gitDirectoryLine = readFileSync(dotGitPath, 'utf8').trim();
        if (!gitDirectoryLine.startsWith('gitdir:')) return 'unknown';
        gitDirectory = resolve(worktree, gitDirectoryLine.slice('gitdir:'.length).trim());
    }

    const head = readFileSync(join(gitDirectory, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head;
    const ref = head.slice('ref:'.length).trim();
    const commonDirectoryFile = join(gitDirectory, 'commondir');
    const commonDirectory = existsSync(commonDirectoryFile)
        ? resolve(gitDirectory, readFileSync(commonDirectoryFile, 'utf8').trim())
        : gitDirectory;
    for (const refDirectory of new Set([gitDirectory, commonDirectory])) {
        const looseRefPath = join(refDirectory, ref);
        if (existsSync(looseRefPath)) return readFileSync(looseRefPath, 'utf8').trim();
    }

    const packedRefsPath = join(commonDirectory, 'packed-refs');
    if (!existsSync(packedRefsPath)) return 'unknown';
    for (const line of readFileSync(packedRefsPath, 'utf8').split('\n')) {
        if (line.startsWith('#') || line.startsWith('^') || line.length === 0) continue;
        const [commit, packedRef] = line.split(' ');
        if (packedRef === ref) return commit;
    }
    return 'unknown';
}

async function runChild(benchmarkName: string, iterations: number, warmup: number) {
    const factory = mltBenchmarkFactories[benchmarkName];
    if (!factory) {
        throw new Error(`Unknown benchmark: ${benchmarkName}. Available benchmarks: ${Object.keys(mltBenchmarkFactories).join(', ')}`);
    }

    const benchmark = factory();
    await benchmark.setup();
    for (let iteration = 0; iteration < warmup; iteration++) {
        await benchmark.bench();
        benchmark.takeIterationMetrics();
    }

    (globalThis as GcGlobal).gc?.();
    const initialMemory = memorySnapshot();
    let maxObservedMemory = initialMemory;
    const durationsMs: number[] = [];
    const gcSamples: GcIterationSample[] = [];
    const iterationMetrics: BenchmarkIterationMetrics[] = [];
    const materializationStats = createMltMaterializationStats();
    const deactivate = activateMltMaterializationStats(materializationStats);
    const gcTracker = createGcTracker();

    try {
        for (let iteration = 0; iteration < iterations; iteration++) {
            const measured = await measureIteration(benchmark, gcTracker);
            durationsMs.push(measured.durationMs);
            gcSamples.push(measured.gc);
            const metrics = benchmark.takeIterationMetrics();
            if (metrics) {
                iterationMetrics.push(metrics);
                for (const snapshot of Object.values(metrics.phaseMemoryBytes ?? {})) {
                    maxObservedMemory = maxMemory(maxObservedMemory, snapshot);
                }
            }
            maxObservedMemory = maxMemory(maxObservedMemory, memorySnapshot());
        }
    } finally {
        gcTracker.disconnect();
        deactivate();
    }

    (globalThis as GcGlobal).gc?.();
    const retainedMemory = memorySnapshot();
    const materializationsPerIteration = Object.fromEntries(
        Object.entries(materializationStats.counters).map(([counter, total]) => [counter, total / iterations])
    );
    const estimatedBytesPerQueryResult = materializationStats.counters.queryResults > 0
        ? materializationStats.counters.estimatedQueryResultBytes / materializationStats.counters.queryResults
        : 0;

    const durationMs = summarizeNumbers(durationsMs);
    const workload = benchmark.getWorkload();
    const throughputPerSecond = {
        median: workload.operationsPerIteration * 1000 / durationMs.median,
        p05: workload.operationsPerIteration * 1000 / durationMs.p95,
    };

    return {
        benchmark: benchmarkName,
        iterations,
        warmup,
        durationSamplesMs: durationsMs,
        workload,
        durationMs,
        throughputPerSecond,
        memoryBytes: {
            initialHeap: initialMemory.heapUsed,
            maxObservedHeap: maxObservedMemory.heapUsed,
            retainedHeapAfterGc: retainedMemory.heapUsed,
            initialRss: initialMemory.rss,
            maxObservedRss: maxObservedMemory.rss,
            retainedRssAfterGc: retainedMemory.rss,
            initialExternal: initialMemory.external,
            maxObservedExternal: maxObservedMemory.external,
            retainedExternalAfterGc: retainedMemory.external,
            initialArrayBuffers: initialMemory.arrayBuffers,
            maxObservedArrayBuffers: maxObservedMemory.arrayBuffers,
            retainedArrayBuffersAfterGc: retainedMemory.arrayBuffers,
        },
        measurements: summarizeIterationMetrics(iterationMetrics),
        gc: summarizeGcSamples(gcSamples),
        materializations: {
            total: materializationStats.counters,
            perIteration: materializationsPerIteration,
            estimatedBytesPerQueryResult,
        },
        ...metadata(),
    };
}

async function runComparisonChild(referenceName: string, candidateName: string, iterations: number, warmup: number) {
    const referenceFactory = mltBenchmarkFactories[referenceName];
    const candidateFactory = mltBenchmarkFactories[candidateName];
    if (!referenceFactory || !candidateFactory) {
        throw new Error(`Unknown comparison: ${referenceName} / ${candidateName}`);
    }

    const reference = referenceFactory();
    const candidate = candidateFactory();
    await reference.setup();
    await candidate.setup();

    for (let iteration = 0; iteration < warmup; iteration++) {
        const orderedBenchmarks = iteration % 2 === 0 ? [reference, candidate] : [candidate, reference];
        for (const benchmark of orderedBenchmarks) {
            await benchmark.bench();
            benchmark.takeIterationMetrics();
        }
    }

    (globalThis as GcGlobal).gc?.();
    const durationSamplesMs: Record<string, number[]> = {
        [referenceName]: [],
        [candidateName]: [],
    };
    const gcSamples: Record<string, GcIterationSample[]> = {
        [referenceName]: [],
        [candidateName]: [],
    };
    const gcTracker = createGcTracker();
    for (let iteration = 0; iteration < iterations; iteration++) {
        const orderedBenchmarks = iteration % 2 === 0
            ? [[referenceName, reference], [candidateName, candidate]] as const
            : [[candidateName, candidate], [referenceName, reference]] as const;
        for (const [benchmarkName, benchmark] of orderedBenchmarks) {
            const measured = await measureIteration(benchmark, gcTracker);
            durationSamplesMs[benchmarkName].push(measured.durationMs);
            gcSamples[benchmarkName].push(measured.gc);
            benchmark.takeIterationMetrics();
        }
    }
    gcTracker.disconnect();

    return {
        reference: referenceName,
        candidate: candidateName,
        iterations,
        warmup,
        executionOrder: 'alternating',
        referenceDurationMs: summarizeNumbers(durationSamplesMs[referenceName]),
        candidateDurationMs: summarizeNumbers(durationSamplesMs[candidateName]),
        referenceDurationSamplesMs: durationSamplesMs[referenceName],
        candidateDurationSamplesMs: durationSamplesMs[candidateName],
        referenceGc: summarizeGcSamples(gcSamples[referenceName]),
        candidateGc: summarizeGcSamples(gcSamples[candidateName]),
        ...metadata(),
    };
}

const iterations = positiveInteger(argv.iterations, 'iterations');
const warmup = positiveInteger(argv.warmup, 'warmup');
const suite = String(argv.suite ?? 'core');
if (suite !== 'core' && suite !== 'extended') {
    throw new Error(`Invalid --suite value: ${suite}. Expected core or extended.`);
}
const benchmarkNames = argv._.length > 0
    ? argv._
    : suite === 'extended'
        ? [...mltDefaultBenchmarkNames, ...mltExtendedBenchmarkNames]
        : mltDefaultBenchmarkNames;

if (argv.child) {
    if (argv.comparison && benchmarkNames.length === 2) {
        const result = await runComparisonChild(benchmarkNames[0], benchmarkNames[1], iterations, warmup);
        console.log(`MLT_BENCH_COMPARISON:${JSON.stringify(result)}`);
    } else if (!argv.comparison && benchmarkNames.length === 1) {
        const result = await runChild(benchmarkNames[0], iterations, warmup);
        console.log(`MLT_BENCH_RESULT:${JSON.stringify(result)}`);
    } else {
        throw new Error('An isolated child must receive exactly one benchmark name.');
    }
} else {
    const results = [];
    for (const benchmarkName of benchmarkNames) {
        const child = spawnSync(
            process.execPath,
            [
                '--expose-gc',
                'node_modules/vite-node/dist/cli.mjs',
                'test/bench/run-mlt-isolated.ts',
                '--child',
                '--iterations', String(iterations),
                '--warmup', String(warmup),
                benchmarkName,
            ],
            {cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024}
        );

        if (child.error || child.status !== 0) {
            throw new Error(`Benchmark ${benchmarkName} failed (status ${child.status}, signal ${child.signal ?? 'none'}):\n${child.stderr || child.stdout || String(child.error)}`);
        }

        const resultLine = child.stdout.split('\n').find((line) => line.startsWith('MLT_BENCH_RESULT:'));
        if (!resultLine) {
            const errorDetail = child.error ? `\n${String(child.error)}` : '';
            throw new Error(`Benchmark ${benchmarkName} returned no result (status ${child.status}):\n${child.stderr || child.stdout}${errorDetail}`);
        }
        results.push(JSON.parse(resultLine.slice('MLT_BENCH_RESULT:'.length)));
    }

    const requestedBenchmarks = new Set(benchmarkNames);
    const comparisonResults = [];
    for (const pair of mltBenchmarkComparisonPairs) {
        if (!requestedBenchmarks.has(pair.reference) || !requestedBenchmarks.has(pair.candidate)) continue;
        const child = spawnSync(
            process.execPath,
            [
                '--expose-gc',
                'node_modules/vite-node/dist/cli.mjs',
                'test/bench/run-mlt-isolated.ts',
                '--child',
                '--comparison',
                '--iterations', String(iterations),
                '--warmup', String(warmup),
                pair.reference,
                pair.candidate,
            ],
            {cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024}
        );
        if (child.error || child.status !== 0) {
            throw new Error(`Benchmark comparison ${pair.reference} / ${pair.candidate} failed (status ${child.status}, signal ${child.signal ?? 'none'}):\n${child.stderr || child.stdout || String(child.error)}`);
        }
        const resultLine = child.stdout.split('\n').find((line) => line.startsWith('MLT_BENCH_COMPARISON:'));
        if (!resultLine) {
            const errorDetail = child.error ? `\n${String(child.error)}` : '';
            throw new Error(`Benchmark comparison ${pair.reference} / ${pair.candidate} returned no result (status ${child.status}):\n${child.stderr || child.stdout}${errorDetail}`);
        }
        comparisonResults.push(JSON.parse(resultLine.slice('MLT_BENCH_COMPARISON:'.length)));
    }

    const report = {
        generatedAt: new Date().toISOString(),
        iterations,
        warmup,
        processIsolation: true,
        statistics: {
            percentileMethod: MLT_BENCHMARK_PERCENTILE_METHOD,
            minimumIterations: MLT_BENCHMARK_MINIMUM_ITERATIONS,
            minimumWarmup: MLT_BENCHMARK_MINIMUM_WARMUP,
        },
        benchmarks: results,
        comparisons: comparisonResults,
        ...metadata(),
    };
    const reportJson = `${JSON.stringify(report, null, 2)}\n`;

    if (argv.output) {
        const outputPath = resolve(String(argv.output));
        mkdirSync(dirname(outputPath), {recursive: true});
        writeFileSync(outputPath, reportJson);
        console.log(`MLT benchmark report written to ${outputPath}`);
    } else {
        process.stdout.write(reportJson);
    }
}
