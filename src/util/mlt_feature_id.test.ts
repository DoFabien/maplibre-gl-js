import {describe, expect, test} from 'vitest';
import {normalizeMltFeatureId} from './mlt_feature_id';

describe('normalizeMltFeatureId', () => {
    test('reinterprets negative decoder ids as uint64 numbers to match MVT feature ids', () => {
        expect(normalizeMltFeatureId(-1814668313)).toBe(18446744071894882000);
        expect(normalizeMltFeatureId(-297277425)).toBe(18446744073412274000);
    });

    test('preserves positive ids and leaves missing ids undefined, as vector tiles do', () => {
        expect(normalizeMltFeatureId(4068029)).toBe(4068029);
        expect(normalizeMltFeatureId(undefined)).toBeUndefined();
        expect(normalizeMltFeatureId(null)).toBeUndefined();
    });
});
