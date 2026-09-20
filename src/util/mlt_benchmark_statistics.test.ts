import {describe, expect, test} from 'vitest';
import {
    exceedsBudget,
    getNumberAtPath,
    percentile,
    summarizeNumbers,
    summarizeRatios,
} from '../../test/bench/lib/mlt_benchmark_statistics.ts';

describe('MLT benchmark statistics', () => {
    test('uses R7 interpolation instead of turning p95 into the maximum of ten samples', () => {
        const samples = Array.from({length: 10}, (_, index) => index + 1);

        expect(percentile(samples, 0.95)).toBeCloseTo(9.55);
        expect(summarizeNumbers(samples)).toEqual({
            median: 5.5,
            p95: 9.549999999999999,
            min: 1,
            max: 10,
        });
    });

    test('rejects empty samples and invalid percentile fractions', () => {
        expect(() => percentile([], 0.95)).toThrow(/without samples/);
        expect(() => percentile([1], -0.1)).toThrow(/between 0 and 1/);
        expect(() => percentile([1], 1.1)).toThrow(/between 0 and 1/);
    });

    test('uses the configured comparison precision at a budget boundary', () => {
        expect(exceedsBudget(4.315014433772446, 4.314731527175532, 0.0001)).toBe(false);
        expect(exceedsBudget(4.32, 4.314731527175532, 0.0001)).toBe(true);
        expect(exceedsBudget(Number.POSITIVE_INFINITY, 10, 0.0001)).toBe(true);
    });

    test('summarizes ratios from samples measured in the same paired iteration', () => {
        expect(summarizeRatios([6, 12, 21], [2, 3, 3])).toEqual({
            median: 4,
            p95: 6.699999999999999,
            min: 3,
            max: 7,
        });
        expect(() => summarizeRatios([1], [1, 2])).toThrow(/1 numerators against 2 denominators/);
    });

    test('resolves nested measurement paths with dotted phase-name keys', () => {
        const measurements = {
            measurements: {
                values: {
                    'query.tilesIn.outputCount': {median: 80},
                },
            },
        };

        expect(getNumberAtPath(measurements, 'measurements.values.query.tilesIn.outputCount.median')).toBe(80);
        expect(getNumberAtPath(measurements, 'measurements.values.query.tilesIn.outputCount.p95')).toBeUndefined();
    });
});
