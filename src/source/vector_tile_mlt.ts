import {type FeatureTable, type Vector, decodeTileLayer, GEOMETRY_TYPE, scanTileLayers} from '@maplibre/mlt';
import {normalizeMltFeatureId} from '../util/mlt_feature_id';
import {
    createColumnarGeometryRangeIndex,
    loadFeatureGeoJSONGeometry,
    loadFeatureGeometry,
    type ColumnarGeometryRangeIndex,
} from '../data/bucket/columnar/geometry_traversal.ts';
import {
    createColumnarPublicProperties,
    createColumnarPublicPropertyBindings,
    type ColumnarPublicPropertyBindings,
} from '../data/bucket/columnar/feature_properties.ts';
import {isMltMaterializationStatsActive, recordMltMaterialization} from '../util/mlt_materialization_stats.ts';
import {normalizeGeoJSONProperty, type LazyGeoJSONPropertiesFeature} from '../util/vectortile_to_geojson.ts';

import type {VectorTileFeatureLike, VectorTileLayerLike, VectorTileLike} from '@maplibre/vt-pbf';
import type Point from '@mapbox/point-geometry';

export type MLTVectorTileOptions = {
    layerNames?: ReadonlySet<string> | readonly string[];
    propertyColumnNamesByLayer?: ReadonlyMap<string, ReadonlySet<string> | null> | Record<string, ReadonlySet<string> | readonly string[] | null>;
    deferPropertyColumns?: boolean;
};

function isLayerNameListOption(options: MLTVectorTileOptions | ReadonlySet<string> | readonly string[] | undefined): options is ReadonlySet<string> | readonly string[] {
    return Array.isArray(options) || options instanceof Set;
}

// Final MVT-like adapter used only when a public API needs a feature object.
// Properties and geometry stay columnar until the application reads them.
class MLTVectorTileFeature implements LazyGeoJSONPropertiesFeature {
    readonly lazyGeoJSONProperties = true;
    type: VectorTileFeatureLike['type'];
    extent: VectorTileFeatureLike['extent'];
    id: VectorTileFeatureLike['id'];
    private materializedProperties?: {[_: string]: any};

    constructor(
        private readonly layer: MLTVectorTileLayer,
        private readonly featureIndex: number,
    ) {
        const featureTable = layer.featureTable;
        if (isMltMaterializationStatsActive()) {
            recordMltMaterialization('vectorTileFeatureWrappers', 1, {
                sourceLayerId: featureTable.name,
                detail: `feature ${featureIndex}`,
            });
        }
        const geometryType = featureTable.geometryVector.geometryType(featureIndex);
        switch (geometryType) {
            case GEOMETRY_TYPE.POINT:
            case GEOMETRY_TYPE.MULTIPOINT:
                this.type = 1;
                break;
            case GEOMETRY_TYPE.LINESTRING:
            case GEOMETRY_TYPE.MULTILINESTRING:
                this.type = 2;
                break;
            case GEOMETRY_TYPE.POLYGON:
            case GEOMETRY_TYPE.MULTIPOLYGON:
                this.type = 3;
                break;
            default:
                this.type = 0;
        }
        this.extent = featureTable.extent;
        this.id = normalizeMltFeatureId(featureTable.idVector?.getValue(featureIndex), featureIndex);
    }

    get properties(): {[_: string]: any} {
        this.materializedProperties ||= createColumnarPublicProperties(
            this.layer.getPublicPropertyBindings(),
            this.featureIndex,
            normalizeGeoJSONProperty,
        );
        return this.materializedProperties;
    }

    loadGeometry(): Point[][] {
        return this.layer.loadPublicGeometry(this.featureIndex);
    }

    toGeoJSON(x: number, y: number, z: number): GeoJSON.Feature {
        return {
            type: 'Feature',
            geometry: this.layer.loadPublicGeoJSONGeometry(this.featureIndex, x, y, z),
            properties: this.properties,
            id: this.id,
        };
    }
}

function estimateDecodedColumnBytes(value: unknown, visited: Set<object>): number {
    if (value === null || typeof value !== 'object') return 0;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (visited.has(value)) return 0;
    visited.add(value);

    if (value instanceof Map) {
        let bytes = 0;
        for (const [key, entry] of value) {
            bytes += estimateDecodedColumnBytes(key, visited);
            bytes += estimateDecodedColumnBytes(entry, visited);
        }
        return bytes;
    }

    if (value instanceof Set) {
        let bytes = 0;
        for (const entry of value) {
            bytes += estimateDecodedColumnBytes(entry, visited);
        }
        return bytes;
    }

    let bytes = 0;
    for (const key of Object.getOwnPropertyNames(value)) {
        bytes += estimateDecodedColumnBytes((value as Record<string, unknown>)[key], visited);
    }
    return bytes;
}

function recordDecodedFeatureTable(featureTable: FeatureTable): void {
    if (!isMltMaterializationStatsActive()) return;

    const propertyColumnCount = featureTable.propertyVectors?.filter(Boolean).length ?? 0;
    const decodedColumnCount = 1 + (featureTable.idVector ? 1 : 0) + propertyColumnCount;
    const decodedColumnBytes = estimateDecodedColumnBytes(featureTable, new Set());
    const context = {sourceLayerId: featureTable.name};

    recordMltMaterialization('decodedLayers', 1, context);
    recordMltMaterialization('decodedColumns', decodedColumnCount, context);
    recordMltMaterialization('decodedValues', featureTable.numFeatures * decodedColumnCount, context);
    recordMltMaterialization('decodedColumnBytes', decodedColumnBytes, context);
}

function recordDeferredPropertyVectors(featureTable: FeatureTable, propertyVectors: readonly Vector[]): void {
    if (!isMltMaterializationStatsActive() || propertyVectors.length === 0) return;

    const context = {sourceLayerId: featureTable.name, detail: 'deferred property decode'};
    const decodedValues = propertyVectors.reduce<number>(
        (sum, vector) => sum + vector.size,
        0,
    );
    const decodedColumnBytes = estimateDecodedColumnBytes(propertyVectors, new Set());

    recordMltMaterialization('decodedColumns', propertyVectors.length, context);
    recordMltMaterialization('decodedValues', decodedValues, context);
    recordMltMaterialization('decodedColumnBytes', decodedColumnBytes, context);
}

class MLTVectorTileLayer implements VectorTileLayerLike {
    name: string;
    version: number;
    extent: number;
    private publicPropertyBindings?: ColumnarPublicPropertyBindings;
    private publicGeometryRangeIndex?: ColumnarGeometryRangeIndex;
    private lastPublicGeometryFeatureIndex?: number;
    constructor(
        public readonly featureTable: FeatureTable,
    ) {
        this.name = featureTable.name;
        this.extent = featureTable.extent;
        this.version = 2;
    }

    get length(): number {
        return this.featureTable.numFeatures;
    }

    // Public query output adapter. Worker rendering uses FeatureTable directly.
    feature(i: number): VectorTileFeatureLike {
        if (i < 0 || i >= this.length) throw new Error('feature index out of bounds');
        return new MLTVectorTileFeature(this, i);
    }

    getPublicPropertyBindings(): ColumnarPublicPropertyBindings {
        this.publicPropertyBindings ||= createColumnarPublicPropertyBindings(
            this.featureTable.materializePropertyVectors(),
        );
        return this.publicPropertyBindings;
    }

    loadPublicGeometry(featureIndex: number): Point[][] {
        const rangeIndex = this.getPublicGeometryRangeIndex(featureIndex);
        return loadFeatureGeometry(this.featureTable, featureIndex, 1, rangeIndex);
    }

    loadPublicGeoJSONGeometry(featureIndex: number, x: number, y: number, z: number): GeoJSON.Geometry {
        const rangeIndex = this.getPublicGeometryRangeIndex(featureIndex);
        return loadFeatureGeoJSONGeometry(this.featureTable, featureIndex, x, y, z, rangeIndex);
    }

    private getPublicGeometryRangeIndex(featureIndex: number): ColumnarGeometryRangeIndex | undefined {
        if (this.publicGeometryRangeIndex) return this.publicGeometryRangeIndex;
        const previousFeatureIndex = this.lastPublicGeometryFeatureIndex;
        this.lastPublicGeometryFeatureIndex = featureIndex;
        if (previousFeatureIndex !== undefined && Math.abs(featureIndex - previousFeatureIndex) > 1) {
            this.publicGeometryRangeIndex = createColumnarGeometryRangeIndex(this.featureTable);
        }
        return this.publicGeometryRangeIndex;
    }
}

export function getMltFeatureTable(layer: VectorTileLayerLike): FeatureTable | undefined {
    return layer instanceof MLTVectorTileLayer ? layer.featureTable : undefined;
}

export class MLTVectorTile implements VectorTileLike {
    layers: Record<string, VectorTileLayerLike> = {};

    constructor(buffer: ArrayBuffer, options?: MLTVectorTileOptions | ReadonlySet<string> | readonly string[]) {
        const decodeOptions: MLTVectorTileOptions | undefined = isLayerNameListOption(options)
            ? {layerNames: options}
            : options;
        const tile = new Uint8Array(buffer);
        const layerEntries = scanTileLayers(tile, decodeOptions);
        if (decodeOptions?.deferPropertyColumns) {
            decodeOptions.propertyColumnNamesByLayer = new Map(
                layerEntries.map((layer) => [layer.name, new Set<string>()])
            );
        }
        const layerEntryByName = Object.fromEntries(layerEntries.map((layer) => [layer.name, layer]));
        this.addLayerGetters(layerEntries.map((layer) => layer.name), (layerName) => {
            const layerEntry = layerEntryByName[layerName];
            if (!layerEntry) {
                throw new Error(`MLT layer '${layerName}' could not be resolved`);
            }
            const featureTable = decodeTileLayer(tile, layerEntry, undefined, true, decodeOptions);
            recordDecodedFeatureTable(featureTable);
            featureTable.onPropertyVectorsResolved((propertyVectors) => {
                recordDeferredPropertyVectors(featureTable, propertyVectors);
            });
            return featureTable;
        });
    }

    static fromFeatureTables(featureTables: FeatureTable[]): MLTVectorTile {
        const tile = Object.create(MLTVectorTile.prototype) as MLTVectorTile;
        tile.layers = {};
        tile.addFeatureTables(featureTables);
        return tile;
    }

    /** Resolves known layers independently, so querying one overzoomed layer does not decode/clip all the others. */
    static fromFeatureTableResolver(layerNames: string[], resolveFeatureTable: (name: string) => FeatureTable): MLTVectorTile {
        const tile = Object.create(MLTVectorTile.prototype) as MLTVectorTile;
        tile.layers = {};
        tile.addLayerGetters(layerNames, resolveFeatureTable);
        return tile;
    }

    private addFeatureTables(featureTables: FeatureTable[]): void {
        const featureTableByName = Object.fromEntries(featureTables.map((featureTable) => [featureTable.name, featureTable]));
        this.addLayerGetters(
            featureTables.map((featureTable) => featureTable.name),
            (layerName) => {
                const featureTable = featureTableByName[layerName];
                if (!featureTable) {
                    throw new Error(`MLT layer '${layerName}' could not be resolved`);
                }
                return featureTable;
            }
        );
    }

    private addLayerGetters(layerNames: string[], resolveFeatureTable: (layerName: string) => FeatureTable): void {
        const layerCache: Record<string, MLTVectorTileLayer> = {};

        for (const layerName of layerNames) {
            Object.defineProperty(this.layers, layerName, {
                enumerable: true,
                configurable: false,
                get: () => {
                    let layer = layerCache[layerName];
                    if (!layer) {
                        layer = new MLTVectorTileLayer(resolveFeatureTable(layerName));
                        layerCache[layerName] = layer;
                    }
                    return layer;
                }
            });
        }
    }
}
