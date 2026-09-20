import {
    type SelectionVector,
    FlatSelectionVector,
    type StringDictionaryVector,
} from '@maplibre/mlt';

/**
 * Generates sorted dictionary indices for efficient binary search.
 *
 * @param offsetBuffer Array of byte offsets for each dictionary entry
 * @param dataBuffer UTF-8 encoded string data for all dictionary entries
 * @param dictionarySize Number of entries in the dictionary
 * @returns Uint32Array of indices sorted by string values
 */
export function sortDictionary(
    offsetBuffer: Int32Array,
    dataBuffer: Uint8Array,
    dictionarySize: number
): Uint32Array {
    const indices = new Uint32Array(dictionarySize);
    for (let i = 0; i < dictionarySize; i++) indices[i] = i;

    // Sort indices by comparing their corresponding string values
    return indices.sort((a, b) => {
        const aData = dataBuffer.subarray(offsetBuffer[a], offsetBuffer[a + 1]);
        const bData = dataBuffer.subarray(offsetBuffer[b], offsetBuffer[b + 1]);
        return compareUtf8(aData, bData);
    });
}

/**
 * Binary search for a value in a pre-sorted dictionary.
 *
 * @param vector StringDictionaryVector with pre-computed sorted indices
 * @param value UTF-8 encoded value to search for
 * @returns Dictionary index of matching value, or -1 if not found
 */
export function binarySearchDictionary(
    vector: StringDictionaryVector,
    value: Uint8Array
): number {
    if (!vector.isSorted) return -1;  // Can only use binary search if pre-sorted

    const sortedIndices = vector.sorted;
    const offsetBuffer = vector.offset;
    const dataBuffer = vector.data;

    let left = 0, right = sortedIndices.length - 1;

    while (left <= right) {
        const mid = (left + right) >>> 1;  // Bitwise unsigned right shift for floor division
        const dictIdx = sortedIndices[mid];
        const entry = dataBuffer.subarray(offsetBuffer[dictIdx], offsetBuffer[dictIdx + 1]);
        const cmp = compareUtf8(entry, value);

        if (cmp < 0) left = mid + 1;        // entry < value, search right half
        else if (cmp > 0) right = mid - 1;  // entry > value, search left half
        else return dictIdx;                // entry === value, found!
    }

    return -1;  // Value not found in dictionary
}

/**
 * Finds a dictionary index by searching for a value.
 * Automatically chooses binary search (if sorted) or linear scan.
 *
 * @param vector The StringDictionaryVector to search
 * @param value UTF-8 encoded value to find
 * @returns Dictionary index or -1 if not found
 */
export function findDictionaryIndex(
    vector: StringDictionaryVector,
    value: Uint8Array
): number {
    // Attempt binary search on sorted dictionary for O(log n) performance
    if (vector.isSorted) {
        return binarySearchDictionary(vector, value);
    }

    // Fall back to linear scan for unsorted dictionaries
    const offsetBuffer = vector.offset;
    const dataBuffer = vector.data;
    const dictionarySize = vector.size;
    const valueLength = value.length;

    for (let i = 1; i <= dictionarySize; i++) {
        const entryLength = offsetBuffer[i] - offsetBuffer[i - 1];
        if (entryLength !== valueLength) continue;  // Length mismatch, skip

        const entry = dataBuffer.subarray(offsetBuffer[i - 1], offsetBuffer[i]);
        let match = true;

        // Byte-by-byte comparison for exact match
        for (let j = 0; j < valueLength; j++) {
            if (entry[j] !== value[j]) {
                match = false;
                break;
            }
        }
        if (match) return i - 1;  // Found matching entry
    }
    return -1;  // Value not found
}

/**
 * Returns a SelectionVector containing indices where the string value equals the specified value.
 *
 * @param vector The StringDictionaryVector to filter
 * @param value The string value to match
 * @returns SelectionVector with indices where vector[i] === value
 */
export function filterStringDictionaryByValue(
    vector: StringDictionaryVector,
    value: string
): SelectionVector {
    const dictIdx = findDictionaryIndex(vector, new TextEncoder().encode(value));
    if (dictIdx === -1) return new FlatSelectionVector(new Uint32Array());
    return scan(vector, new Uint32Array([dictIdx]));
}

/**
 * Returns a SelectionVector containing indices where the string value does NOT equal the specified value.
 * Includes null values in the result.
 *
 * @param vector The StringDictionaryVector to filter
 * @param value The string value to exclude
 * @returns SelectionVector with indices where vector[i] !== value
 */
export function filterStringDictionaryNotEqual(
    vector: StringDictionaryVector,
    value: string
): SelectionVector {
    const matchingIndices = getMatchingDictIndices(vector, new TextEncoder().encode(value), 0);
    return scan(vector, matchingIndices, true);
}

/**
 * Returns a SelectionVector containing indices where the string value matches any value in the provided array.
 *
 * @param vector The StringDictionaryVector to filter
 * @param values Array of string values to match against
 * @returns SelectionVector with indices where vector[i] is in values array
 */
export function matchStringDictionary(
    vector: StringDictionaryVector,
    values: string[]
): SelectionVector {
    const matchingIndices = findDictionaryIndices(vector, values);
    return scan(vector, matchingIndices);
}

/**
 * Returns a SelectionVector containing indices where the string value does NOT match any value in the provided array.
 *
 * @param vector The StringDictionaryVector to filter
 * @param values Array of string values to exclude
 * @returns SelectionVector with indices where vector[i] is NOT in values array
 */
export function noneMatchStringDictionary(
    vector: StringDictionaryVector,
    values: string[]
): SelectionVector {
    const matchingIndices = findDictionaryIndices(vector, values);
    const allIndices = new Set<number>();
    for (let i = 0; i < vector.offset.length - 1; i++) {
        allIndices.add(i);
    }
    for (const idx of matchingIndices) {
        allIndices.delete(idx);
    }
    const invertedIndices = new Uint32Array(Array.from(allIndices)).sort();
    return scan(vector, invertedIndices, true);
}

/**
 * Returns a SelectionVector containing indices where the string value is lexicographically greater than or equal to the specified value.
 *
 * @param vector The StringDictionaryVector to filter
 * @param value The threshold string value
 * @returns SelectionVector with indices where vector[i] >= value
 */
export function greaterThanOrEqualToStringDictionary(
    vector: StringDictionaryVector,
    value: string
): SelectionVector {
    const matchingIndices = getMatchingDictIndices(vector, new TextEncoder().encode(value), 1);
    return scan(vector, matchingIndices);
}

/**
 * Returns a SelectionVector containing indices where the string value is lexicographically smaller than or equal to the specified value.
 *
 * @param vector The StringDictionaryVector to filter
 * @param value The threshold string value
 * @returns SelectionVector with indices where vector[i] <= value
 */
export function smallerThanOrEqualToStringDictionary(
    vector: StringDictionaryVector,
    value: string
): SelectionVector {
    const matchingIndices = getMatchingDictIndices(vector, new TextEncoder().encode(value), 2);
    return scan(vector, matchingIndices);
}

/**
 * Filters an existing SelectionVector to only include indices where the string value equals the specified value.
 * Updates the SelectionVector in-place.
 *
 * @param vector The StringDictionaryVector to check
 * @param value The string value to match
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function filterStringDictionarySelected(
    vector: StringDictionaryVector,
    value: string,
    selectionVector: SelectionVector
): void {
    const dictIdx = findDictionaryIndex(vector, new TextEncoder().encode(value));
    if (dictIdx === -1) {
        selectionVector.setLimit(0);
        return;
    }
    filterInPlace(vector, selectionVector, new Uint32Array([dictIdx]));
}

/**
 * Filters an existing SelectionVector to only include indices where the string value does NOT equal the specified value.
 * Updates the SelectionVector in-place. Includes null values in the result.
 *
 * @param vector The StringDictionaryVector to check
 * @param value The string value to exclude
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function filterStringDictionaryNotEqualSelected(
    vector: StringDictionaryVector,
    value: string,
    selectionVector: SelectionVector
): void {
    const matchingIndices = getMatchingDictIndices(vector, new TextEncoder().encode(value), 0);
    filterInPlace(vector, selectionVector, matchingIndices, true);
}

/**
 * Filters an existing SelectionVector to only include indices where the string value matches any value in the provided array.
 * Updates the SelectionVector in-place.
 *
 * @param vector The StringDictionaryVector to check
 * @param values Array of string values to match against
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function matchStringDictionarySelected(
    vector: StringDictionaryVector,
    values: string[],
    selectionVector: SelectionVector
): void {
    const matchingIndices = findDictionaryIndices(vector, values);
    filterInPlace(vector, selectionVector, matchingIndices);
}

/**
 * Filters an existing SelectionVector to only include indices where the string value does NOT match any value in the provided array.
 * Updates the SelectionVector in-place. Includes null values in the result.
 *
 * @param vector The StringDictionaryVector to check
 * @param values Array of string values to exclude
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function noneMatchStringDictionarySelected(
    vector: StringDictionaryVector,
    values: string[],
    selectionVector: SelectionVector
): void {
    const matchingIndices = findDictionaryIndices(vector, values);
    const allIndices = new Set<number>();
    for (let i = 0; i < vector.offset.length - 1; i++) {
        allIndices.add(i);
    }
    for (const idx of matchingIndices) {
        allIndices.delete(idx);
    }
    const invertedIndices = new Uint32Array(Array.from(allIndices)).sort();
    filterInPlace(vector, selectionVector, invertedIndices, true);
}

/**
 * Filters an existing SelectionVector to only include indices where the string value is lexicographically greater than or equal to the specified value.
 * Updates the SelectionVector in-place.
 *
 * @param vector The StringDictionaryVector to check
 * @param value The threshold string value
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function greaterThanOrEqualToStringDictionarySelected(
    vector: StringDictionaryVector,
    value: string,
    selectionVector: SelectionVector
): void {
    const matchingIndices = getMatchingDictIndices(vector, new TextEncoder().encode(value), 1);
    filterInPlace(vector, selectionVector, matchingIndices);
}

/**
 * Filters an existing SelectionVector to only include indices where the string value is lexicographically smaller than or equal to the specified value.
 * Updates the SelectionVector in-place.
 *
 * @param vector The StringDictionaryVector to check
 * @param value The threshold string value
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function smallerThanOrEqualToStringDictionarySelected(
    vector: StringDictionaryVector,
    value: string,
    selectionVector: SelectionVector
): void {
    const matchingIndices = getMatchingDictIndices(vector, new TextEncoder().encode(value), 2);
    filterInPlace(vector, selectionVector, matchingIndices);
}

function compareUtf8(a: Uint8Array, b: Uint8Array): number {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
}

function binarySearchIncludes(sortedArray: Uint32Array, value: number): boolean {
    let left = 0, right = sortedArray.length - 1;
    while (left <= right) {
        const mid = (left + right) >>> 1;  // Bitwise unsigned right shift for floor division
        if (sortedArray[mid] < value) left = mid + 1;
        else if (sortedArray[mid] > value) right = mid - 1;
        else return true;
    }
    return false;
}

function findDictionaryIndices(
    vector: StringDictionaryVector,
    values: string[]
): Uint32Array {
    const indices = values
        .map(v => findDictionaryIndex(vector, new TextEncoder().encode(v)))
        .filter(i => i !== -1);  // Remove -1 entries for values not found
    return new Uint32Array(indices).sort();
}

const enum ComparisonOperator {
    NotEqual = 0,
    GreaterThanOrEqual = 1,
    LessThanOrEqual = 2
}

function getMatchingDictIndices(
    vector: StringDictionaryVector,
    encodedValue: Uint8Array,
    operator: ComparisonOperator
): Uint32Array {
    const {offset, data} = vector;
    const dictSize = offset.length - 1;
    const result: number[] = [];

    // Scan all dictionary entries
    for (let dictIdx = 0; dictIdx < dictSize; dictIdx++) {
        const entry = data.subarray(offset[dictIdx], offset[dictIdx + 1]);
        const cmp = compareUtf8(entry, encodedValue);

        // Check if entry matches the operator condition
        let match = false;
        if (operator === ComparisonOperator.NotEqual) match = cmp !== 0;
        else if (operator === ComparisonOperator.GreaterThanOrEqual) match = cmp >= 0;
        else match = cmp <= 0;

        if (match) result.push(dictIdx);
    }

    return new Uint32Array(result).sort();
}

function scan(
    vector: StringDictionaryVector,
    matchingIndices: Uint32Array,
    includeNulls: boolean = false
): SelectionVector {
    // Quick exit: no matches and not including nulls means empty result
    if (matchingIndices.length === 0 && !includeNulls) {
        return new FlatSelectionVector(new Uint32Array());
    }

    const {index, nullability, size} = vector;
    const result = new Uint32Array(size);  // Worst case: all rows match
    let w = 0;  // Write position in result array

    // Scan through all rows to build selection
    for (let i = 0; i < size; i++) {
        const hasValue = !nullability || nullability.get(i);  // Check if row is non-null

        if (!hasValue) {
            // Row is null
            if (includeNulls) result[w++] = i;  // Include nulls if requested
        } else if (binarySearchIncludes(matchingIndices, index[i])) {
            // Row's dictionary index is in matching set
            result[w++] = i;
        }
    }

    return new FlatSelectionVector(result.subarray(0, w));
}

function filterInPlace(
    vector: StringDictionaryVector,
    selectionVector: SelectionVector,
    matchingIndices: Uint32Array,
    includeNulls: boolean = false
): void {
    // Quick exit: no matches and not including nulls means empty selection
    if (matchingIndices.length === 0 && !includeNulls) {
        selectionVector.setLimit(0);
        return;
    }

    const {index, nullability} = vector;
    const values = selectionVector.selectionValues();  // Get underlying array buffer
    const limit = selectionVector.limit;  // Current selection size
    let w = 0;  // Write position for filtered results

    // Iterate through currently selected rows
    for (let i = 0; i < limit; i++) {
        const idx = values[i];  // Current row index from selection
        const hasValue = !nullability || nullability.get(idx);  // Check if non-null

        if (!hasValue) {
            // Row is null
            if (includeNulls) values[w++] = idx;  // Keep null rows if requested
        } else if (binarySearchIncludes(matchingIndices, index[idx])) {
            // Row's dictionary index is in matching set
            values[w++] = idx;
        }
    }

    // Update selection limit to reflect filtered size
    selectionVector.setLimit(w);
}
