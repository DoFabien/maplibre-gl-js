import {describe, it, expect} from 'vitest';
import {createStringDictionaryVector, StringDictionaryVector, FlatSelectionVector} from '@maplibre/mlt';
import {
    filterStringDictionaryByValue,
    filterStringDictionarySelected,
    filterStringDictionaryNotEqual,
    filterStringDictionaryNotEqualSelected,
    matchStringDictionary,
    matchStringDictionarySelected,
    noneMatchStringDictionary,
    noneMatchStringDictionarySelected,
    greaterThanOrEqualToStringDictionary,
    greaterThanOrEqualToStringDictionarySelected,
    smallerThanOrEqualToStringDictionary,
    smallerThanOrEqualToStringDictionarySelected,
    sortDictionary,
    binarySearchDictionary,
    findDictionaryIndex,
} from './stringDictionaryUtils';

describe('StringDictionaryUtil Tests', () => {
    describe('Core operations', () => {
        it('filters by value', () => {
            const v = createStringDictionaryVector(['a', 'b', 'a', 'c'], 'test');
            expect(filterStringDictionaryByValue(v, 'a').selectionValues())
                .toEqual(new Uint32Array([0, 2]));
        });

        it('filters not equal values', () => {
            const v = createStringDictionaryVector(['a', 'b', 'a', 'c'], 'test');
            expect(filterStringDictionaryNotEqual(v, 'a').selectionValues())
                .toEqual(new Uint32Array([1, 3]));
        });

        it('matches values from list', () => {
            const v = createStringDictionaryVector(['a', 'b', 'c', 'a', 'd'], 'test');
            expect(matchStringDictionary(v, ['a', 'c']).selectionValues())
                .toEqual(new Uint32Array([0, 2, 3]));
        });

        it('excludes values from list with noneMatch', () => {
            const v = createStringDictionaryVector(['a', 'b', 'c', 'a', 'd'], 'test');
            expect(noneMatchStringDictionary(v, ['a', 'c']).selectionValues())
                .toEqual(new Uint32Array([1, 4]));
        });

        it('filters by >= comparison', () => {
            const v = createStringDictionaryVector(['apple', 'banana', 'cherry', 'date'], 'test');
            expect(greaterThanOrEqualToStringDictionary(v, 'cherry').selectionValues())
                .toEqual(new Uint32Array([2, 3]));
        });

        it('filters by <= comparison', () => {
            const v = createStringDictionaryVector(['apple', 'banana', 'cherry', 'date'], 'test');
            expect(smallerThanOrEqualToStringDictionary(v, 'banana').selectionValues())
                .toEqual(new Uint32Array([0, 1]));
        });

        it('filters selection by value', () => {
            const v = createStringDictionaryVector(['a', 'b', 'a', 'c', 'a'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([0, 2, 3, 4]));
            filterStringDictionarySelected(v, 'a', sel);
            expect(sel.selectionValues()).toEqual(new Uint32Array([0, 2, 4]));
        });

        it('filters selection for not equal values', () => {
            const v = createStringDictionaryVector(['a', 'b', 'a', 'c', 'a'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2, 3]));
            filterStringDictionaryNotEqualSelected(v, 'a', sel);
            expect(sel.selectionValues()).toEqual(new Uint32Array([1, 3]));
        });

        it('filters selection by match list', () => {
            const v = createStringDictionaryVector(['a', 'b', 'c', 'a', 'd'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([1, 2, 3, 4]));
            matchStringDictionarySelected(v, ['a', 'c'], sel);
            expect(sel.selectionValues()).toEqual(new Uint32Array([2, 3]));
        });

        it('filters selection by noneMatch list', () => {
            const v = createStringDictionaryVector(['a', 'b', 'c', 'a', 'd'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2]));
            noneMatchStringDictionarySelected(v, ['a', 'c'], sel);
            expect(sel.selectionValues()).toEqual(new Uint32Array([1]));
        });

        it('filters selection by >= comparison', () => {
            const v = createStringDictionaryVector(['apple', 'banana', 'cherry', 'date'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([1, 2, 3]));
            greaterThanOrEqualToStringDictionarySelected(v, 'cherry', sel);
            expect(sel.selectionValues()).toEqual(new Uint32Array([2, 3]));
        });

        it('filters selection by <= comparison', () => {
            const v = createStringDictionaryVector(['apple', 'banana', 'cherry', 'date'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2]));
            smallerThanOrEqualToStringDictionarySelected(v, 'banana', sel);
            expect(sel.selectionValues()).toEqual(new Uint32Array([0, 1]));
        });
    });

    describe('Dictionary operations', () => {
        it('sorts dictionary indices', () => {
            const encoder = new TextEncoder();
            const values = ['cherry', 'apple', 'banana'];
            const encoded = values.map(v => encoder.encode(v));
            const dictSize = encoded.reduce((sum, v) => sum + v.length, 0);
            const offsetBuffer = new Int32Array(values.length + 1);
            const dataBuffer = new Uint8Array(dictSize);

            let offset = 0;
            offsetBuffer[0] = 0;
            for (let i = 0; i < encoded.length; i++) {
                dataBuffer.set(encoded[i], offset);
                offset += encoded[i].length;
                offsetBuffer[i + 1] = offset;
            }

            const sorted = sortDictionary(offsetBuffer, dataBuffer, 3);
            expect(sorted).toEqual(new Uint32Array([1, 2, 0]));
        });

        it('performs binary search on sorted dictionary', () => {
            const encoder = new TextEncoder();
            const sortedIndices = new Uint32Array([0, 1, 2]);
            const sortedValues = ['apple', 'banana', 'cherry'];
            const sortedEncoded = sortedValues.map(v => encoder.encode(v));
            const sortedDictSize = sortedEncoded.reduce((sum, v) => sum + v.length, 0);
            const sortedOffsetBuffer = new Uint32Array(sortedValues.length + 1);
            const sortedDataBuffer = new Uint8Array(sortedDictSize);

            let sortedOffset = 0;
            sortedOffsetBuffer[0] = 0;
            for (let i = 0; i < sortedEncoded.length; i++) {
                sortedDataBuffer.set(sortedEncoded[i], sortedOffset);
                sortedOffset += sortedEncoded[i].length;
                sortedOffsetBuffer[i + 1] = sortedOffset;
            }

            const indexBuffer = new Uint32Array([0, 1, 2]);
            const v = new StringDictionaryVector(
                'test',
                indexBuffer,
                sortedOffsetBuffer,
                sortedDataBuffer,
                undefined,
                sortedIndices,
            );

            expect(binarySearchDictionary(v, encoder.encode('banana'))).toBe(1);
            expect(binarySearchDictionary(v, encoder.encode('zebra'))).toBe(-1);
            expect(binarySearchDictionary(v, encoder.encode('aaa'))).toBe(-1);
        });

        it('finds dictionary index using binary search for sorted vectors', () => {
            const encoder = new TextEncoder();
            const sortedIndices = new Uint32Array([0, 1, 2]);
            const sortedValues = ['apple', 'banana', 'cherry'];
            const sortedEncoded = sortedValues.map(v => encoder.encode(v));
            const sortedDictSize = sortedEncoded.reduce((sum, v) => sum + v.length, 0);
            const sortedOffsetBuffer = new Uint32Array(sortedValues.length + 1);
            const sortedDataBuffer = new Uint8Array(sortedDictSize);

            let sortedOffset = 0;
            sortedOffsetBuffer[0] = 0;
            for (let i = 0; i < sortedEncoded.length; i++) {
                sortedDataBuffer.set(sortedEncoded[i], sortedOffset);
                sortedOffset += sortedEncoded[i].length;
                sortedOffsetBuffer[i + 1] = sortedOffset;
            }

            const indexBuffer = new Uint32Array([0, 1, 2]);
            const v = new StringDictionaryVector(
                'test',
                indexBuffer,
                sortedOffsetBuffer,
                sortedDataBuffer,
                undefined,
                sortedIndices,
            );

            expect(findDictionaryIndex(v, encoder.encode('apple'))).toBe(0);
            expect(findDictionaryIndex(v, encoder.encode('banana'))).toBe(1);
        });

        it('finds dictionary index using linear scan for unsorted vectors', () => {
            const encoder = new TextEncoder();
            const unsorted = createStringDictionaryVector(['cherry', 'apple', 'banana'], 'test');

            expect(findDictionaryIndex(unsorted, encoder.encode('apple'))).toBe(1);
            expect(findDictionaryIndex(unsorted, encoder.encode('notfound'))).toBe(-1);
        });

        it('returns -1 for binary search on unsorted vector', () => {
            const encoder = new TextEncoder();
            const unsorted = createStringDictionaryVector(['cherry', 'apple', 'banana'], 'test');

            expect(binarySearchDictionary(unsorted, encoder.encode('apple'))).toBe(-1);
        });
    });

    describe('Edge cases', () => {
        it('handles empty vector', () => {
            const empty = createStringDictionaryVector([], 'test');
            expect(filterStringDictionaryByValue(empty, 'a').selectionValues())
                .toEqual(new Uint32Array([]));
        });

        it('handles all null values', () => {
            const allNulls = createStringDictionaryVector([null, null, null], 'test');
            expect(filterStringDictionaryByValue(allNulls, 'a').selectionValues())
                .toEqual(new Uint32Array([]));
            expect(filterStringDictionaryNotEqual(allNulls, 'a').selectionValues())
                .toEqual(new Uint32Array([0, 1, 2]));
        });

        it('includes nulls in filterInPlace when includeNulls=true', () => {
            const v = createStringDictionaryVector(['a', null, 'b', null, 'c'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([1, 3, 4]));
            filterStringDictionaryNotEqualSelected(v, 'a', sel);
            expect(sel.selectionValues()).toEqual(new Uint32Array([1, 3, 4]));
        });

        it('includes nulls in noneMatch selection', () => {
            const v = createStringDictionaryVector([null, 'a', 'b', null, 'c'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2, 3, 4]));
            noneMatchStringDictionarySelected(v, ['a'], sel);
            expect(sel.selectionValues()).toEqual(new Uint32Array([0, 2, 3, 4]));
        });

        it('returns empty selection when value not found', () => {
            const v = createStringDictionaryVector(['a', 'b', 'c'], 'test');
            expect(filterStringDictionaryByValue(v, 'x').selectionValues())
                .toEqual(new Uint32Array([]));

            const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2]));
            filterStringDictionarySelected(v, 'x', sel);
            expect(sel.selectionValues()).toEqual(new Uint32Array([]));
        });

        it('handles empty match/noneMatch arrays', () => {
            const v = createStringDictionaryVector(['a', 'b', 'c'], 'test');
            expect(matchStringDictionary(v, []).selectionValues())
                .toEqual(new Uint32Array([]));
            expect(noneMatchStringDictionary(v, []).selectionValues())
                .toEqual(new Uint32Array([0, 1, 2]));
        });

        it('handles empty match array in Selected version (tests filterInPlace early exit)', () => {
            const v = createStringDictionaryVector(['a', 'b', 'c'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2]));
            matchStringDictionarySelected(v, [], sel);
            expect(sel.selectionValues()).toEqual(new Uint32Array([]));
        });

        it('filters selection with matching values (tests filterInPlace main loop)', () => {
            const v = createStringDictionaryVector(['a', 'b', 'c', 'd'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2, 3]));
            matchStringDictionarySelected(v, ['b', 'd'], sel);
            expect(sel.selectionValues()).toEqual(new Uint32Array([1, 3]));
        });

        it('handles comparison with value between dictionary entries', () => {
            const v = createStringDictionaryVector(['apple', 'cherry'], 'test');
            expect(greaterThanOrEqualToStringDictionary(v, 'banana').selectionValues())
                .toEqual(new Uint32Array([1]));
            expect(smallerThanOrEqualToStringDictionary(v, 'banana').selectionValues())
                .toEqual(new Uint32Array([0]));
        });

        it('handles >= comparison with exact match', () => {
            const v = createStringDictionaryVector(['apple', 'banana', 'banana', 'cherry'], 'test');
            expect(greaterThanOrEqualToStringDictionary(v, 'banana').selectionValues())
                .toEqual(new Uint32Array([1, 2, 3]));
        });

        it('skips nulls in comparison operations', () => {
            const v = createStringDictionaryVector([null, 'a', 'b', null], 'test');
            expect(greaterThanOrEqualToStringDictionary(v, 'a').selectionValues())
                .toEqual(new Uint32Array([1, 2]));
        });

        it('sorts strings with different lengths correctly', () => {
            const encoder = new TextEncoder();
            const values = ['z', 'aaa', 'aa'];
            const encoded = values.map(v => encoder.encode(v));
            const dictSize = encoded.reduce((sum, v) => sum + v.length, 0);
            const offsetBuffer = new Int32Array(values.length + 1);
            const dataBuffer = new Uint8Array(dictSize);

            let offset = 0;
            offsetBuffer[0] = 0;
            for (let i = 0; i < encoded.length; i++) {
                dataBuffer.set(encoded[i], offset);
                offset += encoded[i].length;
                offsetBuffer[i + 1] = offset;
            }

            const sorted = sortDictionary(offsetBuffer, dataBuffer, 3);
            expect(sorted).toEqual(new Uint32Array([2, 1, 0]));
        });

        it('handles >= comparison when all dictionary values are smaller', () => {
            const v = createStringDictionaryVector(['a', 'b', 'c'], 'test');
            expect(greaterThanOrEqualToStringDictionary(v, 'z').selectionValues())
                .toEqual(new Uint32Array([]));
        });

        it('handles <= comparison when all dictionary values are larger', () => {
            const v = createStringDictionaryVector(['x', 'y', 'z'], 'test');
            expect(smallerThanOrEqualToStringDictionary(v, 'a').selectionValues())
                .toEqual(new Uint32Array([]));
        });
    });
});
