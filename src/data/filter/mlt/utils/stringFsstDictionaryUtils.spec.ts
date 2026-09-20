import {describe, it, expect} from 'vitest';
import {createStringFsstDictionaryVector, FlatSelectionVector} from '@maplibre/mlt';
import {
    filterStringFsstDictionaryByValue,
    filterStringFsstDictionarySelected,
    filterStringFsstDictionaryNotEqual,
    filterStringFsstDictionaryNotEqualSelected,
    matchStringFsstDictionary,
    matchStringFsstDictionarySelected,
    noneMatchStringFsstDictionary,
    noneMatchStringFsstDictionarySelected,
    greaterThanOrEqualToStringFsstDictionary,
    greaterThanOrEqualToStringFsstDictionarySelected,
    smallerThanOrEqualToStringFsstDictionary,
    smallerThanOrEqualToStringFsstDictionarySelected,
} from './stringFsstDictionaryUtils';

describe('stringFsstDictionaryUtil Tests', () => {
    describe('StringFsstDictionaryUtil - Core Filtering', () => {
        it('filterByValue matches existing values and skips nulls', () => {
            const v = createStringFsstDictionaryVector(['a', null, 'a', 'b'], 'test');
            expect(filterStringFsstDictionaryByValue(v, 'a').selectionValues())
                .toEqual(new Uint32Array([0, 2]));
        });

        it('filterByValue returns empty selection when value not found', () => {
            const v = createStringFsstDictionaryVector(['a', null, 'a', 'b'], 'test');
            expect(filterStringFsstDictionaryByValue(v, 'x').selectionValues())
                .toEqual(new Uint32Array([]));
        });

        it('filterNotEqual excludes matching values', () => {
            const v = createStringFsstDictionaryVector(['a', 'b', 'a', 'c'], 'test');
            expect(filterStringFsstDictionaryNotEqual(v, 'a').selectionValues())
                .toEqual(new Uint32Array([1, 3]));
        });
    });

    describe('StringFsstDictionaryUtil - Match Operations', () => {
        it('match returns indices matching any value in array', () => {
            const v = createStringFsstDictionaryVector(['a', 'b', 'c', 'a', 'd'], 'test');
            expect(matchStringFsstDictionary(v, ['a', 'c']).selectionValues())
                .toEqual(new Uint32Array([0, 2, 3]));
        });

        it('noneMatch returns indices not matching any value in array', () => {
            const v = createStringFsstDictionaryVector(['a', 'b', 'c', 'a', 'd'], 'test');
            expect(noneMatchStringFsstDictionary(v, ['a', 'c']).selectionValues())
                .toEqual(new Uint32Array([1, 4]));
        });

        it('match returns empty selection for empty values array', () => {
            const v = createStringFsstDictionaryVector(['a', 'b', 'c'], 'test');
            expect(matchStringFsstDictionary(v, []).selectionValues())
                .toEqual(new Uint32Array([]));
        });
    });

    describe('StringFsstDictionaryUtil - Comparison Operations', () => {
        it('greaterThanOrEqualTo returns indices with values >= threshold', () => {
            const v = createStringFsstDictionaryVector(['apple', 'banana', 'cherry', 'date'], 'test');
            expect(greaterThanOrEqualToStringFsstDictionary(v, 'cherry').selectionValues())
                .toEqual(new Uint32Array([2, 3]));
        });

        it('smallerThanOrEqualTo returns indices with values <= threshold', () => {
            const v = createStringFsstDictionaryVector(['apple', 'banana', 'cherry', 'date'], 'test');
            expect(smallerThanOrEqualToStringFsstDictionary(v, 'banana').selectionValues())
                .toEqual(new Uint32Array([0, 1]));
        });

        it('comparison handles string length differences correctly', () => {
            const v = createStringFsstDictionaryVector(['a', 'aa', 'aaa'], 'test');
            expect(greaterThanOrEqualToStringFsstDictionary(v, 'aa').selectionValues())
                .toEqual(new Uint32Array([1, 2]));
        });
    });

    describe('StringFsstDictionaryUtil - Selected Filtering', () => {
        it('filterSelected filters existing selection to matching values', () => {
            const v = createStringFsstDictionaryVector(['a', 'b', 'a', 'c', 'a'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([0, 2, 3, 4]));
            filterStringFsstDictionarySelected(v, 'a', sel);
            expect(sel.selectionValues())
                .toEqual(new Uint32Array([0, 2, 4]));
        });

        it('filterNotEqualSelected filters existing selection to non-matching values', () => {
            const v = createStringFsstDictionaryVector(['a', 'b', 'a', 'c', 'a'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2, 3]));
            filterStringFsstDictionaryNotEqualSelected(v, 'a', sel);
            expect(sel.selectionValues())
                .toEqual(new Uint32Array([1, 3]));
        });

        it('matchSelected filters existing selection to values in array', () => {
            const v = createStringFsstDictionaryVector(['a', 'b', 'c', 'a', 'd'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([1, 2, 3, 4]));
            matchStringFsstDictionarySelected(v, ['a', 'c'], sel);
            expect(sel.selectionValues())
                .toEqual(new Uint32Array([2, 3]));
        });

        it('noneMatchSelected filters existing selection to values not in array', () => {
            const v = createStringFsstDictionaryVector(['a', 'b', 'c', 'a', 'd'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2]));
            noneMatchStringFsstDictionarySelected(v, ['a', 'c'], sel);
            expect(sel.selectionValues())
                .toEqual(new Uint32Array([1]));
        });

        it('greaterThanOrEqualToSelected filters existing selection to values >= threshold', () => {
            const v = createStringFsstDictionaryVector(['apple', 'banana', 'cherry', 'date'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([1, 2, 3]));
            greaterThanOrEqualToStringFsstDictionarySelected(v, 'cherry', sel);
            expect(sel.selectionValues())
                .toEqual(new Uint32Array([2, 3]));
        });

        it('smallerThanOrEqualToSelected filters existing selection to values <= threshold', () => {
            const v = createStringFsstDictionaryVector(['apple', 'banana', 'cherry', 'date'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2]));
            smallerThanOrEqualToStringFsstDictionarySelected(v, 'banana', sel);
            expect(sel.selectionValues())
                .toEqual(new Uint32Array([0, 1]));
        });

        it('filterSelected empties selection when no values match', () => {
            const v = createStringFsstDictionaryVector(['a', 'b', 'c'], 'test');
            const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2]));
            filterStringFsstDictionarySelected(v, 'x', sel);
            expect(sel.selectionValues())
                .toEqual(new Uint32Array([]));
        });
    });

    describe('StringFsstDictionaryUtil - Edge Cases', () => {
        it('handles empty vectors', () => {
            const v = createStringFsstDictionaryVector([], 'test');
            expect(filterStringFsstDictionaryByValue(v, 'x').selectionValues())
                .toEqual(new Uint32Array([]));
        });

        it('handles unicode characters correctly', () => {
            const v = createStringFsstDictionaryVector(['café', 'naïve', 'café'], 'test');
            expect(filterStringFsstDictionaryByValue(v, 'café').selectionValues())
                .toEqual(new Uint32Array([0, 2]));
        });

        it('handles empty strings correctly', () => {
            const v = createStringFsstDictionaryVector(['', 'a', '', 'b'], 'test');
            expect(filterStringFsstDictionaryByValue(v, '').selectionValues())
                .toEqual(new Uint32Array([0, 2]));
        });
    });
});
