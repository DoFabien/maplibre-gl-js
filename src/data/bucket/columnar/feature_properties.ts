import {recordMltMaterialization} from '../../../util/mlt_materialization_stats.ts';

import type {FeatureTable} from '@maplibre/mlt';

export type ColumnarPropertyColumn = NonNullable<FeatureTable['propertyVectors']>[number];
export type ColumnarValueNormalizer = (value: unknown) => unknown;

export type ColumnarPublicPropertyBindings = readonly ColumnarPropertyColumn[];

export function normalizeColumnarValue(value: unknown): unknown {
    return typeof value === 'bigint' ? Number(value) : value;
}

function hasColumnarValue(propertyColumn: ColumnarPropertyColumn, featureIndex: number): boolean {
    if (typeof (propertyColumn as any).has === 'function') {
        return (propertyColumn as any).has(featureIndex);
    }
    const value = propertyColumn.getValue(featureIndex);
    return value !== null && value !== undefined;
}

/**
 * Reads one MLT property without constructing a feature or a properties object.
 * Missing and null values follow the evaluation-feature convention and resolve
 * to undefined.
 */
export function getColumnarPropertyValue(
    featureTable: FeatureTable,
    featureIndex: number,
    propertyName: string,
): unknown {
    const propertyColumn = featureTable.getPropertyVector(propertyName);
    if (!propertyColumn || !hasColumnarValue(propertyColumn, featureIndex)) return undefined;

    const value = propertyColumn.getValue(featureIndex);
    return value === null ? undefined : normalizeColumnarValue(value);
}

export function getColumnarPropertyColumns(
    featureTable: FeatureTable,
    neededProperties: ReadonlySet<string> | null = null
): ColumnarPropertyColumn[] {
    if (neededProperties !== null) {
        const columns: ColumnarPropertyColumn[] = [];
        for (const propertyName of neededProperties) {
            const propertyColumn = featureTable.getPropertyVector(propertyName);
            if (propertyColumn) columns.push(propertyColumn);
        }
        return columns;
    }

    const columns: ColumnarPropertyColumn[] = [];
    for (const propertyColumn of featureTable.propertyVectors ?? []) {
        if (!propertyColumn) continue;
        columns.push(propertyColumn);
    }
    return columns;
}

export function createColumnarProperties(
    featureTable: FeatureTable,
    featureIndex: number,
    neededProperties: ReadonlySet<string> | null = null,
    normalizeValue: ColumnarValueNormalizer = normalizeColumnarValue,
): Record<string, unknown> {
    return createColumnarPropertiesFromColumns(
        getColumnarPropertyColumns(featureTable, neededProperties),
        featureIndex,
        neededProperties !== null,
        normalizeValue,
    );
}

export function createColumnarPropertiesFromColumns(
    propertyColumns: readonly ColumnarPropertyColumn[],
    featureIndex: number,
    eager = false,
    normalizeValue: ColumnarValueNormalizer = normalizeColumnarValue,
): Record<string, unknown> {
    recordMltMaterialization('propertyObjects');
    const properties: Record<string, unknown> = {};

    if (eager) {
        // Indexed iteration is measurably faster on this per-feature public hot path.
        // eslint-disable-next-line @typescript-eslint/prefer-for-of
        for (let columnIndex = 0; columnIndex < propertyColumns.length; columnIndex++) {
            const propertyColumn = propertyColumns[columnIndex];
            const value = propertyColumn.getValue(featureIndex);
            if (value === null || value === undefined) continue;
            const normalized = normalizeValue(value);
            if (propertyColumn.name === '__proto__') {
                recordMltMaterialization('propertyDescriptors');
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

    for (const propertyColumn of propertyColumns) {
        if (!propertyColumn) continue;
        if (!hasColumnarValue(propertyColumn, featureIndex)) continue;

        recordMltMaterialization('propertyDescriptors');
        Object.defineProperty(properties, propertyColumn.name, {
            enumerable: true,
            configurable: true,
            get() {
                const value = propertyColumn.getValue(featureIndex);
                const normalized = value === null ? undefined : normalizeValue(value);
                recordMltMaterialization('propertyDescriptors');
                Object.defineProperty(properties, propertyColumn.name, {
                    value: normalized,
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
                return normalized;
            },
            set(value) {
                recordMltMaterialization('propertyDescriptors');
                Object.defineProperty(properties, propertyColumn.name, {
                    value,
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            }
        });
    }

    return properties;
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
    return createColumnarPropertiesFromColumns(bindings, featureIndex, true, normalizeValue);
}

export function updateColumnarPropertiesFromColumns(
    properties: Record<string, unknown>,
    propertyColumns: readonly ColumnarPropertyColumn[],
    featureIndex: number
): void {
    for (const propertyColumn of propertyColumns) {
        if (!propertyColumn) continue;
        const value = propertyColumn.getValue(featureIndex);
        properties[propertyColumn.name] = value === null ? undefined : normalizeColumnarValue(value);
    }
}

export function getSimpleGetPropertyName(expression: unknown): string | null {
    if (!Array.isArray(expression)) {
        return typeof expression === 'string' ? expression : null;
    }

    return expression[0] === 'get' && typeof expression[1] === 'string'
        ? expression[1]
        : null;
}
