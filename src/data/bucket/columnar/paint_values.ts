import {StringDictionaryVector, StringFsstDictionaryVector, type FeatureTable} from '@maplibre/mlt';
import {readOnlyPropertyNames} from './property_dependencies.ts';

import type {PaintValueCache} from '../../bucket.ts';
import type {ColumnarPropertyColumn} from './feature_properties.ts';
import type {StyleLayer} from '../../../style/style_layer.ts';

/** The most groups a paint value is cached for; a value whose columns combine into more is evaluated per feature. */
const MAX_GROUPS = 1 << 16;

/** The most distinct values of a column other than a dictionary that a value is cached for. */
const MAX_COLUMN_VALUES = 1 << 12;

type DictionaryColumn = StringDictionaryVector | StringFsstDictionaryVector;

/** The evaluated paint or layout properties of a style layer, whose data-driven values hold their expression. */
type PropertyValues = {get(name: string): unknown};

/**
 * The features that share a paint value: those with the same dictionary entries in the columns the value reads.
 * A column the table does not have reads the same for every feature.
 */
type ValueGroups = {
    readonly columns: ReadonlyArray<DictionaryColumn | undefined>;
    /** The weight of each column in the group number; a column's last group is for features without a value. */
    readonly weights: readonly number[];
    readonly values: unknown[];
};

/** The features that share a value read from one column other than a dictionary: those with the same column value. */
type ColumnValues = {
    readonly column: ColumnarPropertyColumn;
    readonly values: Map<unknown, unknown>;
};

/**
 * Data-driven paint and layout values of the buckets of one feature table, cached for the features that share
 * them: an expression that reads only dictionary columns is evaluated once for each combination of their
 * entries, and one that reads a single other column once for each of its values.
 */
export class ColumnarPaintValues implements PaintValueCache {
    private readonly groupsByExpression = new Map<unknown, ValueGroups | ColumnValues | null>();

    constructor(private readonly featureTable: FeatureTable) {}

    /** Prepares the cache for the data-driven paint and layout values of `layers`. */
    addLayers(layers: readonly StyleLayer[]): void {
        for (const layer of layers) {
            const specification = layer.serialize();
            this.addProperties(layer.paint as PropertyValues, specification.paint);
            this.addProperties(layer.layout as PropertyValues, specification.layout);
        }
    }

    get(expression: unknown, featureIndex: number): unknown {
        const groups = this.groupsByExpression.get(expression);
        if (!groups) return undefined;
        return 'column' in groups ? groups.values.get(columnValue(groups.column, featureIndex)) : groups.values[groupOf(groups, featureIndex)];
    }

    set(expression: unknown, featureIndex: number, value: unknown): void {
        const groups = this.groupsByExpression.get(expression);
        if (!groups) return;
        if (!('column' in groups)) {
            groups.values[groupOf(groups, featureIndex)] = value;
        } else if (groups.values.size < MAX_COLUMN_VALUES) {
            groups.values.set(columnValue(groups.column, featureIndex), value);
        }
    }

    private addProperties(properties: PropertyValues | undefined, specifications: Record<string, unknown> | undefined): void {
        for (const property in specifications ?? {}) {
            const expression = (properties?.get(property) as {value?: {kind?: string}} | undefined)?.value;
            if (expression?.kind !== 'source' && expression?.kind !== 'composite') continue;
            if (this.groupsByExpression.has(expression)) continue;
            this.groupsByExpression.set(expression, this.createGroups(specifications[property]));
        }
    }

    private createGroups(specification: unknown): ValueGroups | ColumnValues | null {
        const names = readOnlyPropertyNames(specification);
        if (!names) return null;
        if (names.size === 1) {
            const column = this.featureTable.getPropertyVector([...names][0]);
            if (column && !isDictionaryColumn(column)) return {column, values: new Map()};
        }

        const columns: Array<DictionaryColumn | undefined> = [];
        const weights: number[] = [];
        let groupCount = 1;
        for (const name of names) {
            const vector: unknown = this.featureTable.getPropertyVector(name);
            if (vector !== undefined && !isDictionaryColumn(vector)) return null;
            const column = vector as DictionaryColumn | undefined;
            columns.push(column);
            weights.push(groupCount);
            groupCount *= column ? column.dictionarySize + 1 : 1;
            if (groupCount > MAX_GROUPS) return null;
        }
        return {columns, weights, values: new Array(groupCount)};
    }
}

/** The value of a row in a column, null when the row has none. */
function columnValue(column: ColumnarPropertyColumn, featureIndex: number): unknown {
    return column.getValue(featureIndex);
}

function isDictionaryColumn(column: unknown): column is DictionaryColumn {
    return column instanceof StringDictionaryVector || column instanceof StringFsstDictionaryVector;
}

function groupOf(groups: ValueGroups, featureIndex: number): number {
    let group = 0;
    for (let i = 0; i < groups.columns.length; i++) {
        const column = groups.columns[i];
        if (!column) continue;
        const entry = column.has(featureIndex) ? column.index[featureIndex] : column.dictionarySize;
        group += entry * groups.weights[i];
    }
    return group;
}
