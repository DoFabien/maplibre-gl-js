import {GEOMETRY_TYPE, type FeatureTable} from '@maplibre/mlt';
import {FeaturePositionMap} from '../../feature_position_map.ts';
import {getColumnarPropertyValue} from './feature_properties.ts';
import {register} from '../../../util/web_worker_transfer.ts';

import type {Feature} from '@maplibre/maplibre-gl-style-spec';

export type ColumnarFeatureIdResolver = (featureIndex: number) => string | number | undefined;
type MutableEvaluationFeature = {
    type: Feature['type'];
    id: string | number | undefined;
    properties: Record<string, unknown>;
};

/**
 * Minimal, transferable data needed to reevaluate state-dependent paint
 * expressions. It deliberately retains neither geometry nor a FeatureTable.
 */
export class ColumnarFeatureStateData {
    readonly featureIndices: Uint32Array;
    readonly ids: Array<string | number | undefined>;
    readonly types: Uint8Array;
    readonly propertyNames: string[];
    readonly propertyValues: unknown[][];
    readonly featureMap: FeaturePositionMap;
    readonly byteLength: number;

    private _feature?: MutableEvaluationFeature;
    private _properties?: Record<string, unknown>;
    private _provider?: (featureIndex: number) => Feature;

    constructor(
        featureIndices: Uint32Array,
        ids: Array<string | number | undefined>,
        types: Uint8Array,
        propertyNames: string[],
        propertyValues: unknown[][],
        featureMap: FeaturePositionMap,
    ) {
        this.featureIndices = featureIndices;
        this.ids = ids;
        this.types = types;
        this.propertyNames = propertyNames;
        this.propertyValues = propertyValues;
        this.featureMap = featureMap;
        this.byteLength = estimateByteLength(featureIndices, ids, types, propertyNames, propertyValues);
    }

    static create(
        featureTable: FeatureTable,
        sourceFeatureMap: FeaturePositionMap,
        neededProperties: ReadonlySet<string> | null,
        resolveId: ColumnarFeatureIdResolver,
    ): ColumnarFeatureStateData {
        const featureIndexSet = new Set<number>();
        for (let offset = 0; offset < sourceFeatureMap.positions.length; offset += 3) {
            featureIndexSet.add(sourceFeatureMap.positions[offset]);
        }
        const featureIndices = new Uint32Array(Array.from(featureIndexSet).sort((a, b) => a - b));
        const ids = Array.from(featureIndices, resolveId);
        const types = Uint8Array.from(featureIndices, (featureIndex) => evaluationGeometryType(
            featureTable.geometryVector.geometryType(featureIndex),
        ));
        const propertyNames = featureTable.materializePropertyVectors(neededProperties ?? undefined)
            .filter((column) => column && (neededProperties === null || neededProperties.has(column.name)))
            .map((column) => column.name);
        const propertyValues = propertyNames.map((propertyName) => Array.from(
            featureIndices,
            (featureIndex) => getColumnarPropertyValue(featureTable, featureIndex, propertyName),
        ));

        const featureMap = new FeaturePositionMap();
        for (let offset = 0; offset < sourceFeatureMap.positions.length; offset += 3) {
            const featureIndex = sourceFeatureMap.positions[offset];
            const id = resolveId(featureIndex);
            if (id === undefined) continue;
            featureMap.add(
                id,
                featureIndex,
                sourceFeatureMap.positions[offset + 1],
                sourceFeatureMap.positions[offset + 2],
            );
        }

        const indexedFeatureMap = FeaturePositionMap.deserialize(FeaturePositionMap.serialize(featureMap, []));
        return new ColumnarFeatureStateData(featureIndices, ids, types, propertyNames, propertyValues, indexedFeatureMap);
    }

    getFeatureProvider(): (featureIndex: number) => Feature {
        this._provider ??= (featureIndex) => this.getFeature(featureIndex);
        return this._provider;
    }

    getFeature(featureIndex: number): Feature {
        const row = this.findRow(featureIndex);
        if (row < 0) {
            throw new Error(`MLT feature-state data does not contain feature ${featureIndex}`);
        }

        this.ensureEvaluationFeature();
        for (let columnIndex = 0; columnIndex < this.propertyNames.length; columnIndex++) {
            const propertyName = this.propertyNames[columnIndex];
            const value = this.propertyValues[columnIndex][row];
            if (value === undefined) {
                delete this._properties[propertyName];
            } else {
                this._properties[propertyName] = value;
            }
        }
        this._feature.id = this.ids[row];
        this._feature.type = this.types[row] as Feature['type'];
        return this._feature;
    }

    private ensureEvaluationFeature(): void {
        if (this._feature) return;
        this._properties = {};
        this._feature = {
            type: 0,
            id: undefined,
            properties: this._properties,
        };
    }

    private findRow(featureIndex: number): number {
        let low = 0;
        let high = this.featureIndices.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const candidate = this.featureIndices[middle];
            if (candidate === featureIndex) return middle;
            if (candidate < featureIndex) low = middle + 1;
            else high = middle - 1;
        }
        return -1;
    }
}

function evaluationGeometryType(geometryType: GEOMETRY_TYPE): 0 | 1 | 2 | 3 {
    switch (geometryType) {
        case GEOMETRY_TYPE.POINT:
        case GEOMETRY_TYPE.MULTIPOINT:
            return 1;
        case GEOMETRY_TYPE.LINESTRING:
        case GEOMETRY_TYPE.MULTILINESTRING:
            return 2;
        case GEOMETRY_TYPE.POLYGON:
        case GEOMETRY_TYPE.MULTIPOLYGON:
            return 3;
        default:
            return 0;
    }
}

function estimateByteLength(
    featureIndices: Uint32Array,
    ids: Array<string | number | undefined>,
    types: Uint8Array,
    propertyNames: string[],
    propertyValues: unknown[][],
): number {
    let bytes = featureIndices.byteLength + types.byteLength;
    for (const id of ids) bytes += typeof id === 'string' ? id.length * 2 : 8;
    for (const propertyName of propertyNames) bytes += propertyName.length * 2;
    for (const values of propertyValues) {
        for (const value of values) {
            bytes += typeof value === 'string' ? value.length * 2 : 8;
        }
    }
    return bytes;
}

register('ColumnarFeatureStateData', ColumnarFeatureStateData, {
    omit: ['_feature', '_properties', '_provider'],
} as any);
