import {GEOMETRY_TYPE, type FeatureTable, type SelectionVector} from '@maplibre/mlt';
import {loadFeatureGeometry} from './geometry_traversal.ts';
import {createColumnarPublicProperties, createColumnarPublicPropertyBindings, normalizeColumnarValue, type ColumnarPropertyColumn, type ColumnarPublicPropertyBindings} from './feature_properties.ts';
import {getMltFeatureId} from '../../../util/mlt_feature_id.ts';
import {loadGeometry} from '../../load_geometry.ts';
import {ColumnarPaintValues} from './paint_values.ts';
import {EXTENT} from '../../extent.ts';

import type Point from '@mapbox/point-geometry';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';
import type {BucketFeature, PopulateParameters} from '../../bucket.ts';
import type {PossiblyEvaluatedPropertyValue} from '../../../style/properties.ts';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';

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

export class ColumnarEvaluationFeature implements VectorTileFeatureLike {
    readonly extent: number;
    readonly properties: Record<string, any>;
    private featureIndex = -1;
    private featureType?: VectorTileFeatureLike['type'];
    private featureId?: VectorTileFeatureLike['id'];
    private featureTypeResolved = false;
    private featureIdResolved = false;
    private materializedGeometry?: Point[][];
    private readonly propertyColumnByName: Map<string, ColumnarPropertyColumn>;
    private readonly missingPropertyNames = new Set<string>();

    constructor(readonly featureTable: FeatureTable) {
        this.extent = featureTable.extent;
        this.propertyColumnByName = new Map(featureTable.propertyVectors.filter(Boolean).map((column) => [column.name, column]));
        this.properties = new Proxy({}, {
            get: (_target, property) => this.readProperty(property),
            has: (_target, property) => typeof property === 'string' && this.hasProperty(property),
            ownKeys: () => this.featureTable.availablePropertyNames.filter(name => this.hasProperty(name)),
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

    /** The row the view is set to. */
    get index(): number {
        return this.featureIndex;
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
            this.featureId = getMltFeatureId(this.featureTable, this.featureIndex);
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

    private hasProperty(name: string): boolean {
        const column = this.resolveProperty(name);
        return !!column && hasValue(column, this.featureIndex);
    }

    /**
     * Deferred query tables can acquire columns after this reusable view was constructed, but never a column
     * the tile does not have.
     */
    private resolveProperty(name: string): ColumnarPropertyColumn | undefined {
        const cached = this.propertyColumnByName.get(name);
        if (cached || this.missingPropertyNames.has(name)) return cached;
        const column = this.featureTable.getPropertyVector(name);
        if (column) this.propertyColumnByName.set(name, column);
        else this.missingPropertyNames.add(name);
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

/** The range {@link loadGeometry} clamps coordinates to. */
const MAX_LOADED_COORDINATE = Math.pow(2, 14) - 1;
const MIN_LOADED_COORDINATE = -MAX_LOADED_COORDINATE - 1;

/**
 * The integer factor by which {@link loadGeometry} scales every vertex of a table without rounding or clamping
 * any of them, or undefined when it may round or clamp some vertex.
 */
function getExactScale(featureTable: FeatureTable): number | undefined {
    const geometryVector = featureTable.geometryVector;
    const vertexBuffer = geometryVector.vertexBuffer;
    const scale = EXTENT / featureTable.extent;
    if (!Number.isInteger(scale) || ('mortonSettings' in geometryVector && geometryVector.mortonSettings) || !(vertexBuffer instanceof Int32Array)) {
        return undefined;
    }
    for (const coordinate of vertexBuffer) {
        if (coordinate * scale < MIN_LOADED_COORDINATE || coordinate * scale > MAX_LOADED_COORDINATE) return undefined;
    }
    return scale;
}

/**
 * A row read as a vector tile feature: its id, type and properties, and its geometry scaled to the tile extent,
 * loaded on each read so that the points die young unless a bucket keeps them.
 */
class FeatureRow implements Pick<BucketFeature, 'id' | 'type' | 'properties' | 'geometry'> {
    constructor(
        readonly id: BucketFeature['id'],
        readonly type: BucketFeature['type'],
        readonly properties: BucketFeature['properties'],
        private readonly rows: ColumnarFeatureRows,
        private readonly index: number,
    ) {}

    get geometry(): Point[][] {
        return this.rows.loadGeometry(this.index);
    }
}

/**
 * The rows of a feature table read as vector tile buckets read features, each once for all the buckets of a
 * parse, which only read them.
 */
export class ColumnarFeatureRows {
    private readonly rows: FeatureRow[];
    private readonly view: ColumnarEvaluationFeature;
    private readonly resolveId: (index: number) => string | number | undefined;
    private bindings?: ColumnarPublicPropertyBindings;
    private exactScale?: number | null;
    /** Data-driven paint values that rows of the table share, for the buckets of the parse. */
    readonly paintValues: ColumnarPaintValues;

    constructor(readonly featureTable: FeatureTable, private readonly sourceLayerIndex: number, options: PopulateParameters) {
        this.rows = new Array(featureTable.numFeatures);
        this.view = new ColumnarEvaluationFeature(featureTable);
        this.paintValues = new ColumnarPaintValues(featureTable);
        this.resolveId = options.featureIndex.createMltIdResolver(featureTable, featureTable.name);
    }

    /** Reads the selected rows that are not read yet, each field for all of these rows in turn. */
    readRows(selectionVector: SelectionVector): void {
        const indices: number[] = [];
        for (let i = 0; i < selectionVector.limit; i++) {
            const index = selectionVector.getIndex(i);
            if (!this.rows[index]) indices.push(index);
        }
        if (indices.length === 0) return;

        this.bindings ??= createColumnarPublicPropertyBindings(this.featureTable.propertyVectors);
        this.exactScale ??= getExactScale(this.featureTable) ?? null;
        const count = indices.length;
        const ids = new Array<string | number | undefined>(count);
        const types = new Array<BucketFeature['type']>(count);
        const properties = new Array<Record<string, unknown>>(count);
        for (let i = 0; i < count; i++) ids[i] = this.resolveId(indices[i]);
        for (let i = 0; i < count; i++) types[i] = this.view.setIndex(indices[i]).type;
        for (let i = 0; i < count; i++) properties[i] = createColumnarPublicProperties(this.bindings, indices[i]);
        for (let i = 0; i < count; i++) {
            this.rows[indices[i]] = new FeatureRow(ids[i], types[i], properties[i], this, indices[i]);
        }
    }

    /** The geometry of a row scaled to the tile extent, as {@link loadGeometry} loads that of a vector tile feature. */
    loadGeometry(index: number): Point[][] {
        return this.exactScale ? loadFeatureGeometry(this.featureTable, index, this.exactScale) : loadGeometry(this.view.setIndex(index));
    }

    /** Evaluates a data-driven layout value for a read row, once for the rows that share the value. */
    evaluate<T>(property: PossiblyEvaluatedPropertyValue<T>, index: number, canonical: CanonicalTileID, availableImages?: string[]): T {
        const expression = property.value;
        const cached = this.paintValues.get(expression, index) as T | undefined;
        if (cached !== undefined) return cached;
        const value = property.evaluate(this.rows[index], {}, canonical, availableImages);
        this.paintValues.set(expression, index, value);
        return value;
    }

    /** A row that {@link readRows} read, as a feature that expressions evaluate. */
    row(index: number): FeatureRow {
        return this.rows[index];
    }

    /** The bucket feature of a read row, as a vector tile bucket builds one for each feature it draws, with its sort key. */
    bucketFeature(index: number, sortKey?: number): BucketFeature {
        const {id, type, properties} = this.rows[index];
        return {id, properties, type, sourceLayerIndex: this.sourceLayerIndex, index, geometry: this.loadGeometry(index), patterns: {}, dashes: {}, sortKey,
            paintValues: this.paintValues};
    }
}

const featureRowsByParse = new WeakMap<PopulateParameters, ColumnarFeatureRows>();

/**
 * The rows of a feature table shared by the buckets of the parse that `options` belongs to. A parse populates the
 * buckets of one source layer after another, so it keeps the rows of the latest table only.
 */
export function getColumnarFeatureRows(featureTable: FeatureTable, sourceLayerIndex: number, options: PopulateParameters): ColumnarFeatureRows {
    let rows = featureRowsByParse.get(options);
    if (rows?.featureTable !== featureTable) featureRowsByParse.set(options, rows = new ColumnarFeatureRows(featureTable, sourceLayerIndex, options));
    return rows;
}
