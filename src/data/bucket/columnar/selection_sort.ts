import type {SelectionVector} from '@maplibre/mlt';

/**
 * Reorders a selection as vector tile buckets order their features: a stable sort on the
 * evaluated sort key. Returns the sort keys in the new selection order.
 */
export function sortSelectionByKey(selectionVector: SelectionVector, evaluateSortKey: (featureIndex: number) => number): number[] {
    const count = selectionVector.limit;
    const featureIndices = new Uint32Array(count);
    const sortKeys = new Float64Array(count);
    const order = new Uint32Array(count);
    for (let position = 0; position < count; position++) {
        featureIndices[position] = selectionVector.getIndex(position);
        sortKeys[position] = evaluateSortKey(featureIndices[position]);
        order[position] = position;
    }
    order.sort((a, b) => sortKeys[a] - sortKeys[b] || a - b);

    const sortedKeys = new Array<number>(count);
    for (let position = 0; position < count; position++) {
        selectionVector.setIndex(position, featureIndices[order[position]]);
        sortedKeys[position] = sortKeys[order[position]];
    }
    return sortedKeys;
}
