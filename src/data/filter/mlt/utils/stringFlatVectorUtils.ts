import {
    type SelectionVector,
    type StringFlatVector,
    FlatSelectionVector,
} from '@maplibre/mlt';

/**
 * Returns a SelectionVector containing indices where the string value equals the specified value.
 * Performs byte-level comparison of UTF-8 encoded strings.
 *
 * @param vector The StringFlatVector to filter
 * @param value The string value to match
 * @returns SelectionVector with indices where vector[i] === value
 */
export function filterStringFlatByValue(
    vector: StringFlatVector,
    value: string
): SelectionVector {
    const encodedValue = new TextEncoder().encode(value);
    return scanVector(vector, i =>
        bytesEqual(vector.data, vector.offset, i, encodedValue)
    );
}

/**
 * Returns a SelectionVector containing indices where the string value does NOT equal the specified value.
 * Includes null values in the result.
 *
 * @param vector The StringFlatVector to filter
 * @param value The string value to exclude
 * @returns SelectionVector with indices where vector[i] !== value
 */
export function filterStringFlatNotEqual(
    vector: StringFlatVector,
    value: string
): SelectionVector {
    const encodedValue = new TextEncoder().encode(value);
    return scanVector(
        vector,
        i => !bytesEqual(vector.data, vector.offset, i, encodedValue),
        true
    );
}

/**
 * Returns a SelectionVector containing indices where the string value matches any value in the provided array.
 * Uses byte-level comparison with length-based optimization.
 *
 * @param vector The StringFlatVector to filter
 * @param values Array of string values to match against
 * @returns SelectionVector with indices where vector[i] is in values array
 */
export function matchStringFlat(
    vector: StringFlatVector,
    values: string[]
): SelectionVector {
    const byLength = groupByLength(values);
    return scanVector(vector, i =>
        bytesMatchAny(vector.data, vector.offset, i, byLength)
    );
}

/**
 * Returns a SelectionVector containing indices where the string value does NOT match any value in the provided array.
 * Includes null values in the result.
 *
 * @param vector The StringFlatVector to filter
 * @param values Array of string values to exclude
 * @returns SelectionVector with indices where vector[i] is NOT in values array
 */
export function noneMatchStringFlat(
    vector: StringFlatVector,
    values: string[]
): SelectionVector {
    const byLength = groupByLength(values);
    return scanVector(
        vector,
        i => !bytesMatchAny(vector.data, vector.offset, i, byLength),
        true
    );
}

/**
 * Returns a SelectionVector containing indices where the string value is lexicographically greater than or equal to the specified value.
 * Uses byte-level comparison with chunked processing for performance.
 *
 * @param vector The StringFlatVector to filter
 * @param value The threshold string value
 * @returns SelectionVector with indices where vector[i] >= value
 */
export function greaterThanOrEqualToStringFlat(
    vector: StringFlatVector,
    value: string
): SelectionVector {
    const encodedValue = new TextEncoder().encode(value);
    return scanVector(vector, (i) =>
        compareBytes(vector.data, vector.offset, i, encodedValue, '>=')
    );
}

/**
 * Returns a SelectionVector containing indices where the string value is lexicographically smaller than or equal to the specified value.
 * Uses byte-level comparison with chunked processing for performance.
 *
 * @param vector The StringFlatVector to filter
 * @param value The threshold string value
 * @returns SelectionVector with indices where vector[i] <= value
 */
export function smallerThanOrEqualToStringFlat(
    vector: StringFlatVector,
    value: string
): SelectionVector {
    const encodedValue = new TextEncoder().encode(value);
    return scanVector(vector, i =>
        compareBytes(vector.data, vector.offset, i, encodedValue, '<=')
    );
}

/**
 * Filters an existing SelectionVector to only include indices where the string value equals the specified value.
 * Updates the SelectionVector in-place.
 *
 * @param vector The StringFlatVector to check
 * @param value The string value to match
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function filterStringFlatSelected(
    vector: StringFlatVector,
    value: string,
    selectionVector: SelectionVector
): void {
    const encodedValue = new TextEncoder().encode(value);
    filterSelection(vector, selectionVector, i =>
        bytesEqual(vector.data, vector.offset, i, encodedValue)
    );
}

/**
 * Filters an existing SelectionVector to only include indices where the string value does NOT equal the specified value.
 * Updates the SelectionVector in-place. Includes null values in the result.
 *
 * @param vector The StringFlatVector to check
 * @param value The string value to exclude
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function filterStringFlatNotEqualSelected(
    vector: StringFlatVector,
    value: string,
    selectionVector: SelectionVector
): void {
    const encodedValue = new TextEncoder().encode(value);
    filterSelection(
        vector,
        selectionVector,
        i => !bytesEqual(vector.data, vector.offset, i, encodedValue),
        true
    );
}

/**
 * Filters an existing SelectionVector to only include indices where the string value matches any value in the provided array.
 * Updates the SelectionVector in-place.
 *
 * @param vector The StringFlatVector to check
 * @param values Array of string values to match against
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function matchStringFlatSelected(
    vector: StringFlatVector,
    values: string[],
    selectionVector: SelectionVector
): void {
    const byLength = groupByLength(values);
    filterSelection(vector, selectionVector, (i) =>
        bytesMatchAny(vector.data, vector.offset, i, byLength)
    );
}

/**
 * Filters an existing SelectionVector to only include indices where the string value does NOT match any value in the provided array.
 * Updates the SelectionVector in-place. Includes null values in the result.
 *
 * @param vector The StringFlatVector to check
 * @param values Array of string values to exclude
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function noneMatchStringFlatSelected(
    vector: StringFlatVector,
    values: string[],
    selectionVector: SelectionVector
): void {
    const byLength = groupByLength(values);
    filterSelection(
        vector,
        selectionVector,
        i => !bytesMatchAny(vector.data, vector.offset, i, byLength),
        true
    );
}

/**
 * Filters an existing SelectionVector to only include indices where the string value is lexicographically greater than or equal to the specified value.
 * Updates the SelectionVector in-place.
 *
 * @param vector The StringFlatVector to check
 * @param value The threshold string value
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function greaterThanOrEqualToStringFlatSelected(
    vector: StringFlatVector,
    value: string,
    selectionVector: SelectionVector
): void {
    const encodedValue = new TextEncoder().encode(value);
    filterSelection(vector, selectionVector, i =>
        compareBytes(vector.data, vector.offset, i, encodedValue, '>=')
    );
}

/**
 * Filters an existing SelectionVector to only include indices where the string value is lexicographically smaller than or equal to the specified value.
 * Updates the SelectionVector in-place.
 *
 * @param vector The StringFlatVector to check
 * @param value The threshold string value
 * @param selectionVector The SelectionVector to filter (modified in-place)
 */
export function smallerThanOrEqualToStringFlatSelected(
    vector: StringFlatVector,
    value: string,
    selectionVector: SelectionVector
): void {
    const encodedValue = new TextEncoder().encode(value);
    filterSelection(vector, selectionVector, i =>
        compareBytes(vector.data, vector.offset, i, encodedValue, '<=')
    );
}

function groupByLength(values: string[]): Map<number, Uint8Array[]> {
    const grouped = new Map<number, Uint8Array[]>();
    for (const value of values) {
        const encoded = new TextEncoder().encode(value);
        const list = grouped.get(encoded.length);
        if (list) {
            list.push(encoded);
        } else {
            grouped.set(encoded.length, [encoded]);
        }
    }
    return grouped;
}

function bytesEqual(
    dataBuffer: Uint8Array,
    offsetBuffer: Uint32Array,
    index: number,
    encodedValue: Uint8Array
): boolean {
    const start = offsetBuffer[index];
    const length = offsetBuffer[index + 1] - start;

    if (length !== encodedValue.length) return false;

    for (let j = 0; j < length; j++) {
        if (dataBuffer[start + j] !== encodedValue[j]) {
            return false;
        }
    }
    return true;
}

function bytesMatchAny(
    dataBuffer: Uint8Array,
    offsetBuffer: Uint32Array,
    index: number,
    encodedValuesByLength: Map<number, Uint8Array[]>
): boolean {
    const start = offsetBuffer[index];
    const length = offsetBuffer[index + 1] - start;

    const candidates = encodedValuesByLength.get(length);
    if (!candidates) return false;

    for (const encodedValue of candidates) {
        let match = true;
        for (let j = 0; j < length; j++) {
            if (dataBuffer[start + j] !== encodedValue[j]) {
                match = false;
                break;
            }
        }
        if (match) return true;
    }
    return false;
}

function compareBytes(
    dataBuffer: Uint8Array,
    offsetBuffer: Uint32Array,
    index: number,
    encodedValue: Uint8Array,
    operator: '>=' | '<='
): boolean {
    const start = offsetBuffer[index];
    const length = offsetBuffer[index + 1] - start;
    const valueLength = encodedValue.length;
    const minLen = Math.min(length, valueLength);

    // Process in 8-byte chunks for better cache performance
    const chunks = (minLen >>> 3); // Faster than (minLen / 8) | 0
    let offset = start;
    let valueOffset = 0;

    if (operator === '>=') {
        for (let chunk = 0; chunk < chunks; chunk++) {
            for (let j = 0; j < 8; j++) {
                const bufferByte = dataBuffer[offset++];
                const valueByte = encodedValue[valueOffset++];
                if (bufferByte > valueByte) return true;
                if (bufferByte < valueByte) return false;
            }
        }

        while (valueOffset < minLen) {
            const bufferByte = dataBuffer[offset++];
            const valueByte = encodedValue[valueOffset++];
            if (bufferByte > valueByte) return true;
            if (bufferByte < valueByte) return false;
        }

        return length >= valueLength;
    } else {
        for (let chunk = 0; chunk < chunks; chunk++) {
            for (let j = 0; j < 8; j++) {
                const bufferByte = dataBuffer[offset++];
                const valueByte = encodedValue[valueOffset++];
                if (bufferByte < valueByte) return true;
                if (bufferByte > valueByte) return false;
            }
        }

        while (valueOffset < minLen) {
            const bufferByte = dataBuffer[offset++];
            const valueByte = encodedValue[valueOffset++];
            if (bufferByte < valueByte) return true;
            if (bufferByte > valueByte) return false;
        }

        return length <= valueLength;
    }
}

function scanVector(
    vector: StringFlatVector,
    predicate: (index: number) => boolean,
    includeNulls: boolean = false
): SelectionVector {
    const result = new Uint32Array(vector.size);
    let writeIndex = 0;

    for (let i = 0; i < vector.size; i++) {
        if (!vector.has(i)) {
            if (includeNulls) result[writeIndex++] = i;
            continue;
        }
        if (predicate(i)) {
            result[writeIndex++] = i;
        }
    }

    return new FlatSelectionVector(result, writeIndex);
}

function filterSelection(
    vector: StringFlatVector,
    selectionVector: SelectionVector,
    predicate: (index: number) => boolean,
    includeNulls: boolean = false
): void {
    const vectorValues = selectionVector.selectionValues();
    let writeIndex = 0;

    for (let i = 0; i < selectionVector.limit; i++) {
        const idx = vectorValues[i];

        if (!vector.has(idx)) {
            if (includeNulls) selectionVector.setIndex(writeIndex++, idx);
            continue;
        }
        if (predicate(idx)) {
            selectionVector.setIndex(writeIndex++, idx);
        }
    }

    selectionVector.setLimit(writeIndex);
}
