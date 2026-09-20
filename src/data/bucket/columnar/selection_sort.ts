import type {SelectionVector} from '@maplibre/mlt';

const MAX_POOLED_SELECTION_SORT_CAPACITY = 65536;

type SelectionSortBuffers = {
    featureIndices: Uint32Array;
    order: Uint32Array;
    numericKeys: Float64Array;
    missingKeys: Uint8Array;
    genericKeys: unknown[];
};

let pooledBuffers = createBuffers(0);
let pooledBuffersInUse = false;

function createBuffers(capacity: number): SelectionSortBuffers {
    return {
        featureIndices: new Uint32Array(capacity),
        order: new Uint32Array(capacity),
        numericKeys: new Float64Array(capacity),
        missingKeys: new Uint8Array(capacity),
        genericKeys: new Array(capacity),
    };
}

function pooledCapacity(requiredCapacity: number): number {
    let capacity = 16;
    while (capacity < requiredCapacity) capacity *= 2;
    return Math.min(capacity, MAX_POOLED_SELECTION_SORT_CAPACITY);
}

function acquireBuffers(requiredCapacity: number): {buffers: SelectionSortBuffers; pooled: boolean} {
    if (pooledBuffersInUse || requiredCapacity > MAX_POOLED_SELECTION_SORT_CAPACITY) {
        return {buffers: createBuffers(requiredCapacity), pooled: false};
    }

    pooledBuffersInUse = true;
    if (pooledBuffers.featureIndices.length < requiredCapacity) {
        pooledBuffers = createBuffers(pooledCapacity(requiredCapacity));
    }
    return {buffers: pooledBuffers, pooled: true};
}

function compareGenericKeys(left: unknown, right: unknown): number {
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    if (typeof left === 'bigint' && typeof right === 'bigint') return left < right ? -1 : left > right ? 1 : 0;
    return String(left).localeCompare(String(right));
}

/**
 * Sorts a mutable selection vector without allocating a pair object per feature.
 * Scratch typed arrays are shared between calls up to a bounded retained capacity;
 * larger one-off selections are released after the sort.
 */
export function sortSelectionVectorByKey(
    selectionVector: SelectionVector,
    readSortKey: (featureIndex: number) => unknown,
): void {
    const count = selectionVector.limit;
    if (count <= 1) return;

    const acquired = acquireBuffers(count);
    const {featureIndices, order, numericKeys, missingKeys, genericKeys} = acquired.buffers;
    let firstValidKey: unknown;
    let hasValidKey = false;

    try {
        for (let position = 0; position < count; position++) {
            const featureIndex = Number(selectionVector.getIndex(position));
            const sortKey = readSortKey(featureIndex);
            featureIndices[position] = featureIndex;
            order[position] = position;
            genericKeys[position] = sortKey;
            if (!hasValidKey && sortKey != null) {
                firstValidKey = sortKey;
                hasValidKey = true;
            }
        }

        if (!hasValidKey) return;

        const sortedOrder = order.subarray(0, count);
        if (typeof firstValidKey === 'number') {
            for (let position = 0; position < count; position++) {
                const sortKey = genericKeys[position];
                const missing = sortKey == null;
                missingKeys[position] = missing ? 1 : 0;
                numericKeys[position] = missing ? 0 : Number(sortKey);
            }
            sortedOrder.sort((left, right) => {
                const missingDifference = missingKeys[left] - missingKeys[right];
                if (missingDifference !== 0) return missingDifference;
                const keyDifference = numericKeys[left] - numericKeys[right];
                return keyDifference || left - right;
            });
        } else {
            sortedOrder.sort((left, right) => compareGenericKeys(genericKeys[left], genericKeys[right]) || left - right);
        }

        for (let position = 0; position < count; position++) {
            selectionVector.setIndex(position, featureIndices[sortedOrder[position]]);
        }
    } finally {
        for (let position = 0; position < count; position++) genericKeys[position] = undefined;
        if (acquired.pooled) pooledBuffersInUse = false;
    }
}
