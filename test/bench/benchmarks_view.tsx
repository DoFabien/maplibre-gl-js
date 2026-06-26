import React from 'react';
import {createRoot} from 'react-dom/client';

import {BenchmarksTable} from './components/BenchmarkTable.tsx';
import {summaryStatistics, regression, Summary} from './lib/statistics.ts';
import {ensureError} from '../../src/util/util.ts';
import type {BenchmarkRowProps} from './components/BenchmarkRow.tsx';
import type {Measurement} from './lib/benchmark.ts';

type ExternalDiagnostics = {
    rendererHardwareCounters?: Record<string, unknown>;
};

function getDiagnostics(measurements: Measurement[]): Record<string, unknown>[] {
    return measurements
        .map(measurement => measurement.diagnostics)
        .filter((diagnostics): diagnostics is Record<string, unknown> => !!diagnostics);
}

function mergeExternalDiagnostics(measurement: Measurement, externalDiagnostics?: ExternalDiagnostics | null): Measurement {
    if (!externalDiagnostics) return measurement;

    const diagnostics = measurement.diagnostics || {};
    const renderer = typeof diagnostics.renderer === 'object' && diagnostics.renderer ?
        diagnostics.renderer as Record<string, unknown> :
        {};

    return {
        ...measurement,
        diagnostics: {
            ...diagnostics,
            renderer: {
                ...renderer,
                hardwareCounters: externalDiagnostics.rendererHardwareCounters
            }
        }
    };
}

function updateUI(benchmarks: BenchmarkRowProps[], finished?: boolean) {
    finished = !!finished;
    const root = createRoot(document.getElementById('benchmarks'));
    root.render(<BenchmarksTable benchmarks={benchmarks} finished={finished}/>);
}

export async function run(benchmarks: BenchmarkRowProps[]): Promise<BenchmarkRowProps[]> {
    const filter = window.location.hash.substr(1);
    if (filter) benchmarks = benchmarks.filter(({name}) => name === filter);

    for (const benchmark of benchmarks) {
        for (const version of benchmark.versions) {
            version.status = 'waiting';
            version.samples = [];
            version.measurements = [];
            version.diagnostics = [];
            version.summary = {} as Summary;
        }
    }

    updateUI(benchmarks);

    const allRuns: Promise<any>[] = [];

    for (const bench of benchmarks) {
        for (const version of bench.versions) {
            version.status = 'running';
            updateUI(benchmarks);

            try {
                let externalDiagnostics: ExternalDiagnostics | null | undefined;
                await (window as any).maplibreglBenchmarkBeforeVersionRun?.({
                    benchmarkName: bench.name,
                    versionName: version.name,
                    versionDisplayName: version.displayName
                });
                let measurements: Measurement[];
                try {
                    measurements = await version.bench.run();
                } finally {
                    externalDiagnostics = await (window as any).maplibreglBenchmarkAfterVersionRun?.({
                        benchmarkName: bench.name,
                        versionName: version.name,
                        versionDisplayName: version.displayName
                    });
                }
                measurements = measurements.map(measurement => mergeExternalDiagnostics(measurement, externalDiagnostics));
                const samples = measurements.map(({time, iterations}) => time / iterations);
                version.status = 'ended';
                version.measurements = measurements;
                version.diagnostics = getDiagnostics(measurements);
                version.samples = samples;
                version.summary = summaryStatistics(samples);
                version.regression = regression(measurements);
                updateUI(benchmarks);
            } catch (error) {
                version.status = 'errored';
                version.error = ensureError(error);
                updateUI(benchmarks);
            }
        }
    }

    await Promise.all(allRuns);
    updateUI(benchmarks, true);
    return benchmarks;
}
