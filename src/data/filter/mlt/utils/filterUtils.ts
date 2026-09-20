import {
    type Vector,
    type SelectionVector,
    FlatSelectionVector,
} from '@maplibre/mlt';

/**
 * Returns a SelectionVector containing indices of all non-null values in the vector.
 *
 * @param vector The vector to filter
 * @returns SelectionVector with indices where values are present (non-null)
 */
export function createNonNullSelectionVector<K>(vector: Vector<ArrayBufferView, K>): SelectionVector {
    const selectionVector = new Uint32Array(vector.size);
    let index = 0;
    for (let i = 0; i < vector.size; i++) {
        if (vector.has(i)) {
            selectionVector[index++] = i;
        }
    }
    return new FlatSelectionVector(selectionVector, index);
}

/**
 * Filters an existing SelectionVector to only include indices where the vector has non-null values.
 * Updates the SelectionVector in-place.
 *
 * @param vector The vector to check for non-null values
 * @param selectionVector The SelectionVector to filter (modified in-place)
 * @returns The filtered SelectionVector (same reference as input)
 */
export function filterNonNullSelected<K>(
    vector: Vector<ArrayBufferView, K>,
    selectionVector: SelectionVector
): SelectionVector {
    let writeIndex = 0;
    const vectorValues = selectionVector.selectionValues();
    for (let i = 0; i < selectionVector.limit; i++) {
        const index = vectorValues[i];
        if (vector.has(index)) {
            selectionVector.setIndex(writeIndex++, index);
        }
    }
    selectionVector.setLimit(writeIndex);
    return selectionVector;
}

/**
 * Returns a SelectionVector containing indices of all null values in the vector.
 *
 * @param vector The vector to filter
 * @returns SelectionVector with indices where values are null
 */
export function nullableValues<K>(vector: Vector<ArrayBufferView, K>): SelectionVector {
    const selectionVector = new Uint32Array(vector.size);
    let index = 0;
    for (let i = 0; i < vector.size; i++) {
        if (!vector.has(i)) {
            selectionVector[index++] = i;
        }
    }
    return new FlatSelectionVector(selectionVector, index);
}

/**
 * Filters an existing SelectionVector to only include indices where the vector has null values.
 * Updates the SelectionVector in-place.
 *
 * @param vector The vector to check for null values
 * @param selectionVector The SelectionVector to filter (modified in-place)
 * @returns The filtered SelectionVector (same reference as input)
 */
export function filterNullSelected<K>(
    vector: Vector<ArrayBufferView, K>,
    selectionVector: SelectionVector
): SelectionVector {
    let writeIndex = 0;
    const vectorValues = selectionVector.selectionValues();
    for (let i = 0; i < selectionVector.limit; i++) {
        const index = vectorValues[i];
        if (!vector.has(index)) {
            selectionVector.setIndex(writeIndex++, index);
        }
    }
    selectionVector.setLimit(writeIndex);
    return selectionVector;
}

/**
 * Returns a SelectionVector containing indices where the vector value equals the specified value.
 *
 * @param vector The vector to filter
 * @param value The value to match
 * @returns SelectionVector with indices where vector[i] === value
 */
export function filterByValue<K>(vector: Vector<ArrayBufferView, K>, value: K): SelectionVector {
    const selectionVector = new Uint32Array(vector.size);
    let index = 0;
    for (let i = 0; i < vector.size; i++) {
        if (vector.has(i) && vector.getValue(i) === value) {
            selectionVector[index++] = i;
        }
    }
    return new FlatSelectionVector(selectionVector, index);
}

/**
 * Filters an existing SelectionVector to only include indices where the vector value equals the specified value.
 * Updates the SelectionVector in-place.
 *
 * @param vector The vector to check
 * @param value The value to match
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function filterSelected<K>(
    vector: Vector<ArrayBufferView, K>,
    value: K,
    selectionVector: SelectionVector
): void {
    let writeIndex = 0;
    const vectorValues = selectionVector.selectionValues();
    for (let i = 0; i < selectionVector.limit; i++) {
        const index = vectorValues[i];
        if (vector.has(index) && vector.getValue(index) === value) {
            selectionVector.setIndex(writeIndex++, index);
        }
    }
    selectionVector.setLimit(writeIndex);
}

/**
 * Returns a SelectionVector containing indices where the vector value does NOT equal the specified value.
 * Includes null values in the result.
 *
 * @param vector The vector to filter
 * @param value The value to exclude
 * @returns SelectionVector with indices where vector[i] !== value
 */
export function filterNotEqual<K>(vector: Vector<ArrayBufferView, K>, value: K): SelectionVector {
    const selectionVector = new Uint32Array(vector.size);
    let index = 0;
    for (let i = 0; i < vector.size; i++) {
        if (!vector.has(i) || vector.getValue(i) !== value) {
            selectionVector[index++] = i;
        }
    }
    return new FlatSelectionVector(selectionVector, index);
}

/**
 * Filters an existing SelectionVector to only include indices where the vector value does NOT equal the specified value.
 * Updates the SelectionVector in-place.
 *
 * @param vector The vector to check
 * @param value The value to exclude
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function filterNotEqualSelected<K>(
    vector: Vector<ArrayBufferView, K>,
    value: K,
    selectionVector: SelectionVector
): void {
    let writeIndex = 0;
    const vectorValues = selectionVector.selectionValues();
    for (let i = 0; i < selectionVector.limit; i++) {
        const index = vectorValues[i];
        if (!vector.has(index) || vector.getValue(index) !== value) {
            selectionVector.setIndex(writeIndex++, index);
        }
    }
    selectionVector.setLimit(writeIndex);
}

/**
 * Returns a SelectionVector containing indices where the vector value matches any value in the provided array.
 * Duplicate matches result in duplicate indices in the output.
 *
 * @param vector The vector to filter
 * @param values Array of values to match against
 * @returns SelectionVector with indices where vector[i] is in values array
 */
export function match<K>(vector: Vector<ArrayBufferView, K>, values: K[]): SelectionVector {
    const tempArray = new Uint32Array(vector.size);
    let writeIndex = 0;
    const valueSet = new Set(values);
    for (let i = 0; i < vector.size; i++) {
        if (!vector.has(i)) continue;
        const value = vector.getValue(i);
        if (value == null) continue;
        if (valueSet.has(value)) {
            tempArray[writeIndex++] = i;
        }
    }
    return new FlatSelectionVector(tempArray, writeIndex);
}

/**
 * Filters an existing SelectionVector to only include indices where the vector value matches any value in the provided array.
 * Updates the SelectionVector in-place. Duplicate matches result in duplicate indices in the output.
 *
 * @param vector The vector to check
 * @param values Array of values to match against
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function matchSelected<K>(
    vector: Vector<ArrayBufferView, K>,
    values: K[],
    selectionVector: SelectionVector
): void {
    const valueSet = new Set(values);
    let writeIndex = 0;
    const vectorValues = selectionVector.selectionValues();
    for (let i = 0; i < selectionVector.limit; i++) {
        const index = vectorValues[i];
        if (!vector.has(index)) continue;
        const value = vector.getValue(index);
        if (value == null) continue;

        if (valueSet.has(value)) {
            vectorValues[writeIndex++] = index;
        }
    }
    selectionVector.setLimit(writeIndex);
}

/**
 * Returns a SelectionVector containing indices where the vector value does NOT match any value in the provided array.
 * includeNulls retains missing values for legacy MVT !in semantics; primitive vector scans omit them by default.
 *
 * @param vector The vector to filter
 * @param values Array of values to exclude
 * @returns SelectionVector with indices where vector[i] is NOT in values array
 */
export function noneMatch<K>(vector: Vector<ArrayBufferView, K>, values: K[], includeNulls = false): SelectionVector {
    const tempArray = new Uint32Array(vector.size);
    let writeIndex = 0;
    const valueSet = new Set(values);
    for (let i = 0; i < vector.size; i++) {
        if (!vector.has(i)) {
            if (includeNulls) tempArray[writeIndex++] = i;
            continue;
        }
        const value = vector.getValue(i);
        if (value == null) continue;

        if (!valueSet.has(value)) {
            tempArray[writeIndex++] = i;
        }
    }
    return new FlatSelectionVector(tempArray, writeIndex);
}

/**
 * Filters an existing SelectionVector to only include indices where the vector value does NOT match any value in the provided array.
 * Updates the SelectionVector in-place.
 *
 * @param vector The vector to check
 * @param values Array of values to exclude
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function noneMatchSelected<K>(
    vector: Vector<ArrayBufferView, K>,
    values: K[],
    selectionVector: SelectionVector,
    includeNulls = false,
): void {
    const valueSet = new Set(values);
    let writeIndex = 0;
    const vectorValues = selectionVector.selectionValues();
    for (let i = 0; i < selectionVector.limit; i++) {
        const index = vectorValues[i];
        if (!vector.has(index)) {
            if (includeNulls) vectorValues[writeIndex++] = index;
            continue;
        }
        const value = vector.getValue(index);
        if (value == null) continue;

        if (!valueSet.has(value)) {
            vectorValues[writeIndex++] = index;
        }
    }
    selectionVector.setLimit(writeIndex);
}
