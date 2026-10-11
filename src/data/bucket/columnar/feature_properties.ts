import type {FeatureTable} from '@maplibre/mlt';

export type ColumnarPropertyColumn = NonNullable<FeatureTable['propertyVectors']>[number];
export type ColumnarValueNormalizer = (value: unknown) => unknown;

export type ColumnarPublicPropertyBindings = readonly ColumnarPropertyColumn[];

export function normalizeColumnarValue(value: unknown): unknown {
    return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * Prepares reusable column metadata once per layer. Public properties can then
 * be read without allocating closures or descriptors for ordinary keys.
 * Logical name ordering is independent of physical nullable-column placement;
 * keep the private array unfrozen for fast indexed iteration on public reads.
 */
export function createColumnarPublicPropertyBindings(
    propertyColumns: readonly ColumnarPropertyColumn[],
): ColumnarPublicPropertyBindings {
    return propertyColumns.slice().sort((left, right) => left.name.localeCompare(right.name));
}

export function createColumnarPublicProperties(
    bindings: ColumnarPublicPropertyBindings,
    featureIndex: number,
    normalizeValue: ColumnarValueNormalizer = normalizeColumnarValue,
): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    // Indexed iteration is measurably faster on this per-feature public hot path.
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let columnIndex = 0; columnIndex < bindings.length; columnIndex++) {
        const propertyColumn = bindings[columnIndex];
        const value = propertyColumn.getValue(featureIndex);
        if (value === null || value === undefined) continue;
        const normalized = normalizeValue(value);
        if (propertyColumn.name === '__proto__') {
            Object.defineProperty(properties, propertyColumn.name, {
                value: normalized,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        } else {
            properties[propertyColumn.name] = normalized;
        }
    }
    return properties;
}
