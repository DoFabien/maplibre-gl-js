import {describe, expect, test} from 'vitest';
import {SequenceSelectionVector} from '@maplibre/mlt';
import {sortSelectionByKey} from './selection_sort';

describe('sortSelectionByKey', () => {
    test('sorts stably by key and returns the keys in selection order', () => {
        const selectionVector = new SequenceSelectionVector(0, 1, 5);
        const keys = [3, 0, 1, 1, 2];

        expect(sortSelectionByKey(selectionVector, featureIndex => keys[featureIndex])).toEqual([0, 1, 1, 2, 3]);
        expect(Array.from(selectionVector.selectionValues().subarray(0, selectionVector.limit))).toEqual([1, 2, 3, 4, 0]);
    });
});
