import {describe, expect, test} from 'vitest';
import {
    activateMltMaterializationStats,
    createMltMaterializationStats,
    mltMaterializationCounterNames,
    recordMltMaterialization,
} from './mlt_materialization_stats.ts';

describe('MltMaterializationStats', () => {
    test('starts every counter at zero and records optional events', () => {
        const stats = createMltMaterializationStats({captureEvents: true});
        const deactivate = activateMltMaterializationStats(stats);

        try {
            recordMltMaterialization('queryCandidates', 4, {sourceLayerId: 'road'});
            recordMltMaterialization('queryResults', 2);
            recordMltMaterialization('estimatedQueryResultBytes', 192);
        } finally {
            deactivate();
        }

        expect(Object.keys(stats.counters)).toEqual([...mltMaterializationCounterNames]);
        expect(stats.counters.queryCandidates).toBe(4);
        expect(stats.counters.queryResults).toBe(2);
        expect(stats.counters.estimatedQueryResultBytes).toBe(192);
        expect(stats.events).toEqual([
            {counter: 'queryCandidates', amount: 4, sourceLayerId: 'road'},
            {counter: 'queryResults', amount: 2},
            {counter: 'estimatedQueryResultBytes', amount: 192},
        ]);
    });

    test('strict mode throws only for configured forbidden counters', () => {
        const stats = createMltMaterializationStats({
            strict: true,
            forbiddenCounters: ['vectorTileFeatureWrappers'],
        });
        const deactivate = activateMltMaterializationStats(stats);

        try {
            expect(() => recordMltMaterialization('queryCandidates', 1)).not.toThrow();
            expect(() => recordMltMaterialization('vectorTileFeatureWrappers', 1, {detail: 'query'}))
                .toThrow('Forbidden MLT materialization: vectorTileFeatureWrappers += 1 (query)');
        } finally {
            deactivate();
        }

        expect(stats.counters.queryCandidates).toBe(1);
        expect(stats.counters.vectorTileFeatureWrappers).toBe(1);
    });

    test('restores a nested collector', () => {
        const outer = createMltMaterializationStats();
        const inner = createMltMaterializationStats();
        const deactivateOuter = activateMltMaterializationStats(outer);

        try {
            recordMltMaterialization('queryResults');
            const deactivateInner = activateMltMaterializationStats(inner);
            try {
                recordMltMaterialization('queryResults', 2);
            } finally {
                deactivateInner();
            }
            recordMltMaterialization('queryResults', 3);
        } finally {
            deactivateOuter();
        }

        expect(outer.counters.queryResults).toBe(4);
        expect(inner.counters.queryResults).toBe(2);
    });
});
