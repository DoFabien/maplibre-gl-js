import {GEOMETRY_TYPE, type FeatureTable} from '@maplibre/mlt';
import {ColumnarGeometryView, loadFeatureGeometry} from './geometry_traversal.ts';
import {getColumnarPropertyColumns, normalizeColumnarValue, type ColumnarPropertyColumn} from './feature_properties.ts';
import {normalizeMltFeatureId} from '../../../util/mlt_feature_id.ts';
import {recordMltMaterialization} from '../../../util/mlt_materialization_stats.ts';

import type Point from '@mapbox/point-geometry';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';
import type {GeometryView} from '../../../util/geometry_view.ts';

function hasValue(column: ColumnarPropertyColumn, featureIndex: number): boolean {
    if (typeof (column as any).has === 'function') {
        return (column as any).has(featureIndex);
    }
    const value = column.getValue(featureIndex);
    return value !== null && value !== undefined;
}

function vectorTileGeometryType(geometryType: GEOMETRY_TYPE): VectorTileFeatureLike['type'] {
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

/**
 * A stable geometry object whose topology cursor is not positioned until an
 * intersection actually reads it. Query code can therefore pass geometry to
 * a style layer without paying for cursor setup when the layer rejects or
 * otherwise ignores the geometry.
 */
class DeferredColumnarGeometryView implements GeometryView {
    private featureIndex = -1;
    private invocation = 0;
    private resolvedInvocation = -1;
    private recordQueryGeometry = false;
    private view?: ColumnarGeometryView;

    constructor(private readonly featureTable: FeatureTable) {}

    setIndex(featureIndex: number, recordQueryGeometry: boolean): this {
        this.featureIndex = featureIndex;
        this.recordQueryGeometry = recordQueryGeometry;
        this.invocation++;
        return this;
    }

    get partCount(): number {
        return this.resolve().partCount;
    }

    getPartLength(partIndex: number): number {
        return this.resolve().getPartLength(partIndex);
    }

    getX(partIndex: number, pointIndex: number): number {
        return this.resolve().getX(partIndex, pointIndex);
    }

    getY(partIndex: number, pointIndex: number): number {
        return this.resolve().getY(partIndex, pointIndex);
    }

    materialize(): Point[][] {
        return this.resolve().materialize();
    }

    private resolve(): ColumnarGeometryView {
        this.view ??= new ColumnarGeometryView(this.featureTable);
        if (this.resolvedInvocation !== this.invocation) {
            this.view.setIndex(this.featureIndex);
            this.resolvedInvocation = this.invocation;
            if (this.recordQueryGeometry) {
                recordMltMaterialization('queryGeometriesLoaded', 1, {
                    sourceLayerId: this.featureTable.name,
                });
            }
        }
        return this.view;
    }
}

export class ColumnarEvaluationFeature implements VectorTileFeatureLike {
    readonly extent: number;
    readonly properties: Record<string, any>;
    private featureIndex = -1;
    private featureType?: VectorTileFeatureLike['type'];
    private featureId?: VectorTileFeatureLike['id'];
    private featureTypeResolved = false;
    private featureIdResolved = false;
    private materializedGeometry?: Point[][];
    private readonly deferredGeometryView: DeferredColumnarGeometryView;
    private readonly propertyColumns: ColumnarPropertyColumn[];
    private readonly propertyColumnByName: Map<string, ColumnarPropertyColumn>;

    constructor(readonly featureTable: FeatureTable, private readonly neededProperties: ReadonlySet<string> | null = null) {
        this.extent = featureTable.extent;
        this.propertyColumns = getColumnarPropertyColumns(featureTable, neededProperties);
        this.propertyColumnByName = new Map(this.propertyColumns.map((column) => [column.name, column]));
        this.deferredGeometryView = new DeferredColumnarGeometryView(featureTable);
        this.properties = new Proxy({}, {
            get: (_target, property) => this.readProperty(property),
            has: (_target, property) => typeof property === 'string' && this.hasProperty(property),
            ownKeys: () => (this.neededProperties === null ? this.featureTable.availablePropertyNames : [...this.neededProperties])
                .filter(name => this.hasProperty(name)),
            getOwnPropertyDescriptor: (_target, property) => {
                if (typeof property !== 'string' || !this.hasProperty(property)) return undefined;
                return {
                    value: this.readProperty(property),
                    enumerable: true,
                    configurable: true,
                };
            },
        });
    }

    setIndex(featureIndex: number): this {
        if (this.featureIndex === featureIndex) return this;
        this.featureIndex = featureIndex;
        this.materializedGeometry = undefined;
        this.featureTypeResolved = false;
        this.featureIdResolved = false;
        return this;
    }

    get type(): VectorTileFeatureLike['type'] {
        if (!this.featureTypeResolved) {
            this.featureType = vectorTileGeometryType(this.featureTable.geometryVector.geometryType(this.featureIndex));
            this.featureTypeResolved = true;
        }
        return this.featureType;
    }

    get id(): VectorTileFeatureLike['id'] {
        if (!this.featureIdResolved) {
            this.featureId = normalizeMltFeatureId(this.featureTable.idVector?.getValue(this.featureIndex), this.featureIndex);
            this.featureIdResolved = true;
        }
        return this.featureId;
    }

    loadGeometry(): Point[][] {
        return loadFeatureGeometry(this.featureTable, this.featureIndex);
    }

    get geometry(): Point[][] {
        return this.materializedGeometry ||= this.loadGeometry();
    }

    getGeometryView(recordQueryGeometry = false): GeometryView {
        return this.deferredGeometryView.setIndex(this.featureIndex, recordQueryGeometry);
    }

    private hasProperty(name: string): boolean {
        const column = this.resolveProperty(name);
        return !!column && hasValue(column, this.featureIndex);
    }

    /** Deferred query tables can acquire columns after this reusable view was constructed. */
    private resolveProperty(name: string): ColumnarPropertyColumn | undefined {
        const cached = this.propertyColumnByName.get(name);
        if (cached) return cached;
        if (this.neededProperties !== null && !this.neededProperties.has(name)) return undefined;
        const column = this.featureTable.getPropertyVector(name);
        if (column) this.propertyColumnByName.set(name, column);
        return column;
    }

    private readProperty(property: string | symbol): any {
        if (typeof property !== 'string') return undefined;
        const column = this.resolveProperty(property);
        if (!column || !hasValue(column, this.featureIndex)) return undefined;
        const value = column.getValue(this.featureIndex);
        return value === null ? undefined : normalizeColumnarValue(value);
    }
}

const evaluationFeatureCache = new WeakMap<FeatureTable, ColumnarEvaluationFeature>();

export function getColumnarEvaluationFeature(featureTable: FeatureTable, featureIndex: number): ColumnarEvaluationFeature {
    let feature = evaluationFeatureCache.get(featureTable);
    if (!feature) {
        feature = new ColumnarEvaluationFeature(featureTable);
        evaluationFeatureCache.set(featureTable, feature);
    }
    return feature.setIndex(featureIndex);
}
