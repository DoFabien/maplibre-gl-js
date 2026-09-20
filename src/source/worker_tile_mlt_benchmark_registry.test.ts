import {describe, expect, test} from 'vitest';
import {
    mltBenchmarkComparisonPairs,
    mltBenchmarkFactories,
    mltDefaultBenchmarkNames,
    mltExtendedBenchmarkNames,
} from '../../test/bench/mlt_benchmark_registry.ts';

describe('MLT benchmark registry', () => {
    test('keeps every default benchmark registered exactly once', () => {
        expect(new Set(mltDefaultBenchmarkNames).size).toBe(mltDefaultBenchmarkNames.length);
        for (const benchmarkName of mltDefaultBenchmarkNames) {
            expect(mltBenchmarkFactories).toHaveProperty(benchmarkName);
        }
    });

    test('keeps every extended benchmark registered exactly once', () => {
        expect(new Set(mltExtendedBenchmarkNames).size).toBe(mltExtendedBenchmarkNames.length);
        for (const benchmarkName of mltExtendedBenchmarkNames) {
            expect(mltBenchmarkFactories).toHaveProperty(benchmarkName);
        }
    });

    test('runs every comparison pair in the core or extended suite', () => {
        const registeredBenchmarks = new Set<string>([...mltDefaultBenchmarkNames, ...mltExtendedBenchmarkNames]);
        for (const pair of mltBenchmarkComparisonPairs) {
            expect(registeredBenchmarks.has(pair.reference)).toBe(true);
            expect(registeredBenchmarks.has(pair.candidate)).toBe(true);
        }
    });

    test('validates Bing and FastPFOR from physical stream metadata', async () => {
        const bing = mltBenchmarkFactories.MltBingDecodeMLT();
        const fastPfor = mltBenchmarkFactories.MltFastPforDecodeMLT();

        await bing.setup();
        await fastPfor.setup();

        expect(bing.getWorkload().parameters.physicalTechniques).not.toContain('FAST_PFOR');
        expect(fastPfor.getWorkload().parameters.physicalTechniques).toContain('FAST_PFOR');
    });

    test.each([
        'MltWorkerParseOnlySyntheticLineMLT',
        'MltWorkerParseOnlySyntheticFillMLT',
        'MltWorkerParseOnlySyntheticCircleMLT',
        'MltWorkerParseOnlySyntheticFillExtrusionMLT',
        'MltWorkerParseOnlySyntheticSymbolMLT',
        'MltWorkerParseOnlySyntheticLineSymbolMLT',
        'MltBingDecodeMLT',
        'MltFastPforDecodeMLT',
    ])('includes %s in the default coverage', (benchmarkName) => {
        expect(mltDefaultBenchmarkNames).toContain(benchmarkName);
    });
});
