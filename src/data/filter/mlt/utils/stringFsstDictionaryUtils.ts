import {
    type SelectionVector,
    FlatSelectionVector,
    type StringFsstDictionaryVector,
} from '@maplibre/mlt';

/**
 * Returns a SelectionVector containing indices where the FSST dictionary vector value equals the specified value.
 *
 * @param vector The FSST dictionary vector to filter
 * @param value The value to match
 * @returns SelectionVector with indices where vector[i] === value
 */
export function filterStringFsstDictionaryByValue(
    vector: StringFsstDictionaryVector,
    value: string
): SelectionVector {
    ensureDecoded(vector);
    const matchingIndices = getMatchingDictIndices(vector, [new TextEncoder().encode(value)], false);
    return scan(vector, matchingIndices);
}

/**
 * Returns a SelectionVector containing indices where the FSST dictionary vector value does NOT equal the specified value.
 * Includes null values in the result.
 *
 * @param vector The FSST dictionary vector to filter
 * @param value The value to exclude
 * @returns SelectionVector with indices where vector[i] !== value
 */
export function filterStringFsstDictionaryNotEqual(
    vector: StringFsstDictionaryVector,
    value: string
): SelectionVector {
    ensureDecoded(vector);
    const matchingIndices = getMatchingDictIndices(vector, [new TextEncoder().encode(value)], true);
    return scan(vector, matchingIndices);
}

/**
 * Returns a SelectionVector containing indices where the FSST dictionary vector value matches any value in the provided array.
 *
 * @param vector The FSST dictionary vector to filter
 * @param values Array of values to match against
 * @returns SelectionVector with indices where vector[i] is in values array
 */
export function matchStringFsstDictionary(
    vector: StringFsstDictionaryVector,
    values: string[]
): SelectionVector {
    ensureDecoded(vector);
    const encoder = new TextEncoder();
    const matchingIndices = getMatchingDictIndices(
        vector,
        values.map(v => encoder.encode(v)),
        false
    );
    return scan(vector, matchingIndices);
}

/**
 * Returns a SelectionVector containing indices where the FSST dictionary vector value does NOT match any value in the provided array.
 *
 * @param vector The FSST dictionary vector to filter
 * @param values Array of values to exclude
 * @returns SelectionVector with indices where vector[i] is NOT in values array
 */
export function noneMatchStringFsstDictionary(
    vector: StringFsstDictionaryVector,
    values: string[]
): SelectionVector {
    ensureDecoded(vector);
    const encoder = new TextEncoder();
    const matchingIndices = getMatchingDictIndices(
        vector,
        values.map(v => encoder.encode(v)),
        true
    );
    return scan(vector, matchingIndices);
}

/**
 * Returns a SelectionVector containing indices where the FSST dictionary vector value is greater than or equal to the specified value.
 * Uses lexicographic (byte-wise) comparison.
 *
 * @param vector The FSST dictionary vector to filter
 * @param value The value to compare against
 * @returns SelectionVector with indices where vector[i] >= value
 */
export function greaterThanOrEqualToStringFsstDictionary(
    vector: StringFsstDictionaryVector,
    value: string
): SelectionVector {
    ensureDecoded(vector);
    const matchingIndices = getCompareDictIndices(vector, new TextEncoder().encode(value), true);
    return scan(vector, matchingIndices);
}

/**
 * Returns a SelectionVector containing indices where the FSST dictionary vector value is less than or equal to the specified value.
 * Uses lexicographic (byte-wise) comparison.
 *
 * @param vector The FSST dictionary vector to filter
 * @param value The value to compare against
 * @returns SelectionVector with indices where vector[i] <= value
 */
export function smallerThanOrEqualToStringFsstDictionary(
    vector: StringFsstDictionaryVector,
    value: string
): SelectionVector {
    ensureDecoded(vector);
    const matchingIndices = getCompareDictIndices(vector, new TextEncoder().encode(value), false);
    return scan(vector, matchingIndices);
}

/**
 * Filters an existing SelectionVector to only include indices where the FSST dictionary vector value equals the specified value.
 * Updates the SelectionVector in-place.
 *
 * @param vector The FSST dictionary vector to check
 * @param value The value to match
 * @param sel The SelectionVector to filter (modified in-place)
 */
export function filterStringFsstDictionarySelected(
    vector: StringFsstDictionaryVector,
    value: string,
    sel: SelectionVector
): void {
    ensureDecoded(vector);
    const matchingIndices = getMatchingDictIndices(vector, [new TextEncoder().encode(value)], false);
    filterInPlace(vector, sel, matchingIndices);
}

/**
 * Filters an existing SelectionVector to only include indices where the FSST dictionary vector value does NOT equal the specified value.
 * Updates the SelectionVector in-place.
 *
 * @param vector The FSST dictionary vector to check
 * @param value The value to exclude
 * @param sel The SelectionVector to filter (modified in-place)
 */
export function filterStringFsstDictionaryNotEqualSelected(
    vector: StringFsstDictionaryVector,
    value: string,
    sel: SelectionVector
): void {
    ensureDecoded(vector);
    const matchingIndices = getMatchingDictIndices(vector, [new TextEncoder().encode(value)], true);
    filterInPlace(vector, sel, matchingIndices);
}

/**
 * Filters an existing SelectionVector to only include indices where the FSST dictionary vector value matches any value in the provided array.
 * Updates the SelectionVector in-place.
 *
 * @param vector The FSST dictionary vector to check
 * @param values Array of values to match against
 * @param sel The SelectionVector to filter (modified in-place)
 */
export function matchStringFsstDictionarySelected(
    vector: StringFsstDictionaryVector,
    values: string[],
    sel: SelectionVector
): void {
    ensureDecoded(vector);
    const encoder = new TextEncoder();
    const matchingIndices = getMatchingDictIndices(
        vector,
        values.map(v => encoder.encode(v)),
        false
    );
    filterInPlace(vector, sel, matchingIndices);
}

/**
 * Filters an existing SelectionVector to only include indices where the FSST dictionary vector value does NOT match any value in the provided array.
 * Updates the SelectionVector in-place.
 *
 * @param vector The FSST dictionary vector to check
 * @param values Array of values to exclude
 * @param sel The SelectionVector to filter (modified in-place)
 */
export function noneMatchStringFsstDictionarySelected(
    vector: StringFsstDictionaryVector,
    values: string[],
    sel: SelectionVector
): void {
    ensureDecoded(vector);
    const encoder = new TextEncoder();
    const matchingIndices = getMatchingDictIndices(
        vector,
        values.map(v => encoder.encode(v)),
        true
    );
    filterInPlace(vector, sel, matchingIndices);
}

/**
 * Filters an existing SelectionVector to only include indices where the FSST dictionary vector value is greater than or equal to the specified value.
 * Updates the SelectionVector in-place. Uses lexicographic (byte-wise) comparison.
 *
 * @param vector The FSST dictionary vector to check
 * @param value The value to compare against
 * @param sel The SelectionVector to filter (modified in-place)
 */
export function greaterThanOrEqualToStringFsstDictionarySelected(
    vector: StringFsstDictionaryVector,
    value: string,
    sel: SelectionVector
): void {
    ensureDecoded(vector);
    const matchingIndices = getCompareDictIndices(vector, new TextEncoder().encode(value), true);
    filterInPlace(vector, sel, matchingIndices);
}

/**
 * Filters an existing SelectionVector to only include indices where the FSST dictionary vector value is less than or equal to the specified value.
 * Updates the SelectionVector in-place. Uses lexicographic (byte-wise) comparison.
 *
 * @param vector The FSST dictionary vector to check
 * @param value The value to compare against
 * @param sel The SelectionVector to filter (modified in-place)
 */
export function smallerThanOrEqualToStringFsstDictionarySelected(
    vector: StringFsstDictionaryVector,
    value: string,
    sel: SelectionVector
): void {
    ensureDecoded(vector);
    const matchingIndices = getCompareDictIndices(vector, new TextEncoder().encode(value), false);
    filterInPlace(vector, sel, matchingIndices);
}

function matchDictEntry(
    dictionary: Uint8Array,
    start: number,
    length: number,
    encodedValue: Uint8Array
): boolean {
    if (length !== encodedValue.length) return false;
    for (let j = 0; j < length; j++) {
        if (dictionary[start + j] !== encodedValue[j]) return false;
    }
    return true;
}

function compareDictEntry(
    dictionary: Uint8Array,
    start: number,
    length: number,
    encodedValue: Uint8Array,
    isGte: boolean
): boolean {
    const valueLength = encodedValue.length;
    const minLength = length < valueLength ? length : valueLength;

    let cmp = 0;
    for (let j = 0; j < minLength; j++) {
        const diff = dictionary[start + j] - encodedValue[j];
        if (diff !== 0) {
            cmp = diff;
            break;
        }
    }

    if (cmp === 0) cmp = length - valueLength;
    return isGte ? cmp >= 0 : cmp <= 0;
}

function getMatchingDictIndices(
    vector: StringFsstDictionaryVector,
    encodedValues: Uint8Array[],
    invert: boolean
): Set<number> {
    const {decoded: dictionary, offset} = vector;
    const dictSize = offset.length - 1;
    const result = new Set<number>();

    for (let dictIdx = 0; dictIdx < dictSize; dictIdx++) {
        const start = offset[dictIdx];
        const length = offset[dictIdx + 1] - start;

        let isMatch = false;
        for (const ev of encodedValues) {
            if (matchDictEntry(dictionary, start, length, ev)) {
                isMatch = true;
                break;
            }
        }

        if (isMatch !== invert) result.add(dictIdx);
    }
    return result;
}

function getCompareDictIndices(
    vector: StringFsstDictionaryVector,
    encodedValue: Uint8Array,
    isGte: boolean
): Set<number> {
    const {decoded: dictionary, offset} = vector;
    const dictSize = offset.length - 1;
    const result = new Set<number>();

    for (let dictIdx = 0; dictIdx < dictSize; dictIdx++) {
        const start = offset[dictIdx];
        const length = offset[dictIdx + 1] - start;

        if (compareDictEntry(dictionary, start, length, encodedValue, isGte)) {
            result.add(dictIdx);
        }
    }
    return result;
}

function ensureDecoded(vector: StringFsstDictionaryVector): void {
    if (vector.decoded == null && vector.size > 0) vector.getValue(0);
}

function matchesCondition(
    vector: StringFsstDictionaryVector,
    idx: number,
    matchingIndices: Set<number>
): boolean {
    return vector.has(idx) && matchingIndices.has(vector.index[idx]);
}

function scan(vector: StringFsstDictionaryVector, matchingIndices: Set<number>): SelectionVector {
    const {size} = vector;
    const result = new Uint32Array(size);
    let w = 0;

    for (let i = 0; i < size; i++) {
        if (matchesCondition(vector, i, matchingIndices)) {
            result[w++] = i;
        }
    }

    return new FlatSelectionVector(result, w);
}

function filterInPlace(
    vector: StringFsstDictionaryVector,
    selectionVector: SelectionVector,
    matchingIndices: Set<number>
): void {
    if (matchingIndices.size === 0) {
        selectionVector.setLimit(0);
        return;
    }

    const values = selectionVector.selectionValues();
    const limit = selectionVector.limit;
    let w = 0;

    for (let i = 0; i < limit; i++) {
        const idx = values[i];
        if (matchesCondition(vector, idx, matchingIndices)) {
            values[w++] = idx;
        }
    }

    selectionVector.setLimit(w);
}
