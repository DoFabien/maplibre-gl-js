import {describe, expect, test, vi} from 'vitest';
import {createSelectionVector} from '@maplibre/mlt';
import {sortSelectionVectorByKey} from './selection_sort';

function selectedValues(selectionVector: ReturnType<typeof createSelectionVector>): number[] {
    return Array.from(selectionVector.selectionValues().subarray(0, selectionVector.limit));
}

describe('sortSelectionVectorByKey', () => {
    test('sorts numeric keys stably and puts missing values last', () => {
        const selectionVector = createSelectionVector(5);
        const keys = [3, null, 1, 1, 2];
        const readSortKey = vi.fn((featureIndex: number) => keys[featureIndex]);

        sortSelectionVectorByKey(selectionVector, readSortKey);

        expect(selectedValues(selectionVector)).toEqual([2, 3, 4, 0, 1]);
        expect(readSortKey).toHaveBeenCalledTimes(5);
    });

    test('preserves bigint and string ordering without pair objects', () => {
        const bigintSelection = createSelectionVector(4);
        const bigintKeys = [3n, null, -1n, 2n];
        sortSelectionVectorByKey(bigintSelection, (featureIndex) => bigintKeys[featureIndex]);
        expect(selectedValues(bigintSelection)).toEqual([2, 3, 0, 1]);

        const stringSelection = createSelectionVector(4);
        const stringKeys = ['z', 'a', null, 'm'];
        sortSelectionVectorByKey(stringSelection, (featureIndex) => stringKeys[featureIndex]);
        expect(selectedValues(stringSelection)).toEqual([1, 3, 0, 2]);
    });
});
