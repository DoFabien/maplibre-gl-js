import {describe, it, expect} from 'vitest';
import {createNullableStringVector, createStringFlatVector, FlatSelectionVector} from '@maplibre/mlt';
import {
    filterStringFlatByValue,
    filterStringFlatSelected,
    greaterThanOrEqualToStringFlat,
    greaterThanOrEqualToStringFlatSelected,
    smallerThanOrEqualToStringFlat,
    smallerThanOrEqualToStringFlatSelected,
    matchStringFlat,
    matchStringFlatSelected,
    noneMatchStringFlat,
    noneMatchStringFlatSelected,
    filterStringFlatNotEqual,
    filterStringFlatNotEqualSelected,
} from './stringFlatVectorUtils';

describe('filterStringFlatByValue', () => {
    it('finds exact matches in string vector', () => {
        const v = createStringFlatVector(['apple', 'banana', 'apple'], 'test');
        expect(filterStringFlatByValue(v, 'apple').selectionValues())
            .toEqual(new Uint32Array([0, 2]));
    });

    it('handles unicode characters correctly', () => {
        const v = createStringFlatVector(['café', 'naïve', 'café'], 'test');
        expect(filterStringFlatByValue(v, 'café').selectionValues())
            .toEqual(new Uint32Array([0, 2]));
    });

    it('handles empty strings correctly', () => {
        const v = createStringFlatVector(['', 'a', '', 'b'], 'test');
        expect(filterStringFlatByValue(v, '').selectionValues())
            .toEqual(new Uint32Array([0, 2]));
    });

    it('returns empty selection when no matches found', () => {
        const v = createStringFlatVector(['apple', 'banana'], 'test');
        expect(filterStringFlatByValue(v, 'orange').selectionValues())
            .toEqual(new Uint32Array([]));
    });

    it('skips null values and only returns non-null matches', () => {
        const v = createNullableStringVector(['apple', null, 'apple'], 'test');
        expect(filterStringFlatByValue(v, 'apple').selectionValues())
            .toEqual(new Uint32Array([0, 2]));
    });
});

describe('filterStringFlatSelected', () => {
    it('filters a pre-existing selection in-place', () => {
        const v = createStringFlatVector(['apple', 'banana', 'apple', 'date'], 'test');
        const sel = new FlatSelectionVector(new Uint32Array([0, 2, 3]));
        filterStringFlatSelected(v, 'apple', sel);
        expect(sel.selectionValues()).toEqual(new Uint32Array([0, 2]));
    });

    it('handles null values in the selection', () => {
        const v = createNullableStringVector(['apple', null, 'apple'], 'test');
        const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2]));
        filterStringFlatSelected(v, 'apple', sel);
        expect(sel.selectionValues()).toEqual(new Uint32Array([0, 2]));
    });
});

describe('greaterThanOrEqualToStringFlat', () => {
    it('finds all values greater than or equal to threshold using lexicographic order', () => {
        const v = createStringFlatVector(['aaa', 'apple', 'banana', 'cherry', 'date'], 'test');
        expect(greaterThanOrEqualToStringFlat(v, 'banana').selectionValues())
            .toEqual(new Uint32Array([2, 3, 4]));
    });

    it('handles string prefixes correctly in comparison', () => {
        const v = createStringFlatVector(['app', 'apple', 'application'], 'test');
        expect(greaterThanOrEqualToStringFlat(v, 'apple').selectionValues())
            .toEqual(new Uint32Array([1, 2]));
    });

    it('returns empty selection when no values meet threshold', () => {
        const v = createStringFlatVector(['aaa', 'aab', 'aac'], 'test');
        expect(greaterThanOrEqualToStringFlat(v, 'banana').selectionValues())
            .toEqual(new Uint32Array([]));
    });

    it('returns full selection when all values meet threshold', () => {
        const v = createStringFlatVector(['banana', 'cherry'], 'test');
        expect(greaterThanOrEqualToStringFlat(v, 'apple').selectionValues())
            .toEqual(new Uint32Array([0, 1]));
    });

    it('skips null values in comparison', () => {
        const v = createNullableStringVector(['apple', null, 'banana', 'cherry'], 'test');
        expect(greaterThanOrEqualToStringFlat(v, 'banana').selectionValues())
            .toEqual(new Uint32Array([2, 3]));
    });

    it('processes long strings using 8-byte chunked optimization', () => {
        const v = createStringFlatVector(['verylongstring1', 'verylongstring2', 'verylongstring3'], 'test');
        expect(greaterThanOrEqualToStringFlat(v, 'verylongstring2').selectionValues())
            .toEqual(new Uint32Array([1, 2]));
    });

    it('returns early when first byte differs in long strings', () => {
        const v = createStringFlatVector(['cccccccc', 'aaaaaaaa', 'bbbbbbbb'], 'test');
        expect(greaterThanOrEqualToStringFlat(v, 'bbbbbbbb').selectionValues())
            .toEqual(new Uint32Array([0, 2]));
    });
});

describe('smallerThanOrEqualToStringFlat', () => {
    it('finds all values smaller than or equal to threshold using lexicographic order', () => {
        const v = createStringFlatVector(['aaa', 'apple', 'banana', 'cherry', 'date'], 'test');
        expect(smallerThanOrEqualToStringFlat(v, 'banana').selectionValues())
            .toEqual(new Uint32Array([0, 1, 2]));
    });

    it('handles string prefixes correctly in comparison', () => {
        const v = createStringFlatVector(['app', 'apple', 'application'], 'test');
        expect(smallerThanOrEqualToStringFlat(v, 'apple').selectionValues())
            .toEqual(new Uint32Array([0, 1]));
    });

    it('returns empty selection when no values meet threshold', () => {
        const v = createStringFlatVector(['banana', 'cherry'], 'test');
        expect(smallerThanOrEqualToStringFlat(v, 'apple').selectionValues())
            .toEqual(new Uint32Array([]));
    });

    it('skips null values in comparison', () => {
        const v = createNullableStringVector(['apple', null, 'banana', 'cherry'], 'test');
        expect(smallerThanOrEqualToStringFlat(v, 'banana').selectionValues())
            .toEqual(new Uint32Array([0, 2]));
    });

    it('processes long strings using 8-byte chunked optimization', () => {
        const v = createStringFlatVector(['verylongstring1', 'verylongstring2', 'verylongstring3'], 'test');
        expect(smallerThanOrEqualToStringFlat(v, 'verylongstring2').selectionValues())
            .toEqual(new Uint32Array([0, 1]));
    });

    it('reaches remainder byte processing in <= branch with 9-byte strings', () => {
        const v = createStringFlatVector(['123456789', '234567890', '345678901'], 'test');
        expect(smallerThanOrEqualToStringFlat(v, '234567890').selectionValues())
            .toEqual(new Uint32Array([0, 1]));
    });
});

describe('greaterThanOrEqualToStringFlatSelected', () => {
    it('filters a pre-existing selection to values >= threshold', () => {
        const v = createStringFlatVector(['aaa', 'apple', 'banana', 'cherry'], 'test');
        const sel = new FlatSelectionVector(new Uint32Array([0, 2, 3]));
        greaterThanOrEqualToStringFlatSelected(v, 'banana', sel);
        expect(sel.selectionValues()).toEqual(new Uint32Array([2, 3]));
    });
});

describe('smallerThanOrEqualToStringFlatSelected', () => {
    it('filters a pre-existing selection to values <= threshold', () => {
        const v = createStringFlatVector(['aaa', 'banana', 'cherry'], 'test');
        const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2]));
        smallerThanOrEqualToStringFlatSelected(v, 'banana', sel);
        expect(sel.selectionValues()).toEqual(new Uint32Array([0, 1]));
    });
});

describe('matchStringFlat', () => {
    it('returns indices of values matching a single item in list', () => {
        const v = createStringFlatVector(['apple', 'banana', 'cherry', 'apple', 'date'], 'test');
        expect(matchStringFlat(v, ['apple']).selectionValues())
            .toEqual(new Uint32Array([0, 3]));
    });

    it('returns indices of values matching multiple items in list', () => {
        const v = createStringFlatVector(['apple', 'banana', 'cherry', 'apple', 'date'], 'test');
        expect(matchStringFlat(v, ['apple', 'cherry']).selectionValues())
            .toEqual(new Uint32Array([0, 2, 3]));
    });

    it('returns empty selection when given empty match list', () => {
        const v = createStringFlatVector(['apple', 'banana', 'cherry', 'apple', 'date'], 'test');
        expect(matchStringFlat(v, []).selectionValues())
            .toEqual(new Uint32Array([]));
    });

    it('uses length-based grouping optimization for efficient matching', () => {
        const v = createStringFlatVector(['abc', 'def', 'ghi'], 'test');
        expect(matchStringFlat(v, ['abc', 'ghi']).selectionValues())
            .toEqual(new Uint32Array([0, 2]));
    });
});

describe('noneMatchStringFlat', () => {
    it('returns indices of values not matching a single item in exclusion list', () => {
        const v = createStringFlatVector(['apple', 'banana', 'cherry', 'apple', 'date'], 'test');
        expect(noneMatchStringFlat(v, ['apple']).selectionValues())
            .toEqual(new Uint32Array([1, 2, 4]));
    });

    it('returns indices of values not matching multiple items in exclusion list', () => {
        const v = createStringFlatVector(['apple', 'banana', 'cherry', 'apple', 'date'], 'test');
        expect(noneMatchStringFlat(v, ['apple', 'cherry']).selectionValues())
            .toEqual(new Uint32Array([1, 4]));
    });

    it('returns all indices when given empty exclusion list', () => {
        const v = createStringFlatVector(['apple', 'banana', 'cherry', 'apple', 'date'], 'test');
        expect(noneMatchStringFlat(v, []).selectionValues())
            .toEqual(new Uint32Array([0, 1, 2, 3, 4]));
    });
});

describe('matchStringFlatSelected', () => {
    it('filters a pre-existing selection to only indices matching the list', () => {
        const v = createStringFlatVector(['apple', 'banana', 'cherry', 'apple', 'date'], 'test');
        const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2, 4]));
        matchStringFlatSelected(v, ['apple', 'banana'], sel);
        expect(sel.selectionValues()).toEqual(new Uint32Array([0, 1]));
    });

    it('returns empty selection when no values in selection match the list', () => {
        const v = createStringFlatVector(['apple', 'banana', 'cherry', 'apple', 'date'], 'test');
        const sel = new FlatSelectionVector(new Uint32Array([0, 1]));
        matchStringFlatSelected(v, ['cherry', 'date'], sel);
        expect(sel.selectionValues()).toEqual(new Uint32Array([]));
    });
});

describe('noneMatchStringFlatSelected', () => {
    it('filters a pre-existing selection to only indices not matching the exclusion list', () => {
        const v = createNullableStringVector(['apple', null, 'banana', 'cherry'], 'test');
        const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2, 3]));
        noneMatchStringFlatSelected(v, ['apple', 'banana'], sel);
        expect(sel.selectionValues()).toEqual(new Uint32Array([1, 3]));
    });
});

describe('filterStringFlatNotEqual', () => {
    it('returns indices where values differ from target', () => {
        const v = createStringFlatVector(['apple', 'banana', 'cherry', 'apple'], 'test');
        expect(filterStringFlatNotEqual(v, 'apple').selectionValues())
            .toEqual(new Uint32Array([1, 2]));
    });

    it('returns all indices when no values equal target', () => {
        const v = createStringFlatVector(['apple', 'banana'], 'test');
        expect(filterStringFlatNotEqual(v, 'orange').selectionValues())
            .toEqual(new Uint32Array([0, 1]));
    });

    it('returns empty selection when all values equal target', () => {
        const v = createStringFlatVector(['test', 'test'], 'test');
        expect(filterStringFlatNotEqual(v, 'test').selectionValues())
            .toEqual(new Uint32Array([]));
    });

    it('includes null values in the result of not-equal filter', () => {
        const v = createNullableStringVector(['apple', null, 'banana', 'apple'], 'test');
        expect(filterStringFlatNotEqual(v, 'apple').selectionValues())
            .toEqual(new Uint32Array([1, 2]));
    });

    it('handles empty strings in not-equal filter', () => {
        const v = createStringFlatVector(['', 'apple', '', 'banana'], 'test');
        expect(filterStringFlatNotEqual(v, '').selectionValues())
            .toEqual(new Uint32Array([1, 3]));
    });
});

describe('filterStringFlatNotEqualSelected', () => {
    it('filters a pre-existing selection to indices where values differ from target', () => {
        const v = createStringFlatVector(['apple', 'banana', 'cherry', 'apple'], 'test');
        const sel = new FlatSelectionVector(new Uint32Array([0, 1, 2, 3]));
        filterStringFlatNotEqualSelected(v, 'apple', sel);
        expect(sel.selectionValues()).toEqual(new Uint32Array([1, 2]));
    });

    it('returns empty selection when all selected values equal target', () => {
        const v = createStringFlatVector(['apple', 'banana', 'apple'], 'test');
        const sel = new FlatSelectionVector(new Uint32Array([0, 2]));
        filterStringFlatNotEqualSelected(v, 'apple', sel);
        expect(sel.selectionValues()).toEqual(new Uint32Array([]));
    });
});
