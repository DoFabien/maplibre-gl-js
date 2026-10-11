import {type FeatureTable, decodeTileLayer, GEOMETRY_TYPE, scanTileLayers} from '@maplibre/mlt';
import {getMltFeatureId} from '../util/mlt_feature_id';
import {loadFeatureGeometry} from '../data/bucket/columnar/geometry_traversal.ts';
import {
    createColumnarPublicProperties,
    createColumnarPublicPropertyBindings,
    type ColumnarPublicPropertyBindings,
} from '../data/bucket/columnar/feature_properties.ts';

import type {VectorTileFeatureLike, VectorTileLayerLike, VectorTileLike} from '@maplibre/vt-pbf';
import type Point from '@mapbox/point-geometry';

export type MLTVectorTileOptions = {
    /** The layers to read, all of them when omitted. */
    layerNames?: readonly string[];
    /**
     * The property columns decoded with each layer it lists; the other columns of these layers are decoded when
     * first read, and the layers it does not list decode all their columns.
     */
    propertyColumnNamesByLayer?: ReadonlyMap<string, Set<string>>;
    /** Decodes every property column when first read. */
    deferPropertyColumns?: boolean;
};

// Final MVT-like adapter used only when a public API needs a feature object.
// Properties and geometry stay columnar until the application reads them.
class MLTVectorTileFeature implements VectorTileFeatureLike {
    type: VectorTileFeatureLike['type'];
    extent: VectorTileFeatureLike['extent'];
    id: VectorTileFeatureLike['id'];
    private materializedProperties?: {[_: string]: any};

    constructor(
        readonly layer: MLTVectorTileLayer,
        readonly featureIndex: number,
    ) {
        const featureTable = layer.featureTable;
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
        this.id = getMltFeatureId(featureTable, featureIndex);
    }

    get properties(): {[_: string]: any} {
        this.materializedProperties ||= createColumnarPublicProperties(
            this.layer.getPublicPropertyBindings(),
            this.featureIndex,
        );
        return this.materializedProperties;
    }

    loadGeometry(): Point[][] {
        return loadFeatureGeometry(this.layer.featureTable, this.featureIndex);
    }
}

class MLTVectorTileLayer implements VectorTileLayerLike {
    name: string;
    version: number;
    extent: number;
    private publicPropertyBindings?: ColumnarPublicPropertyBindings;
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
}

export function getMltFeatureTable(layer: VectorTileLayerLike): FeatureTable | undefined {
    return layer instanceof MLTVectorTileLayer ? layer.featureTable : undefined;
}

export class MLTVectorTile implements VectorTileLike {
    layers: Record<string, VectorTileLayerLike> = {};

    constructor(buffer: ArrayBuffer, options: MLTVectorTileOptions = {}) {
        const tile = new Uint8Array(buffer);
        const layerEntries = scanTileLayers(tile).filter(layer => !options.layerNames || options.layerNames.includes(layer.name));
        const layerEntryByName = Object.fromEntries(layerEntries.map((layer) => [layer.name, layer]));
        this.addLayerGetters(layerEntries.map((layer) => layer.name), (layerName) => {
            const propertyNames = options.deferPropertyColumns ? new Set<string>() : options.propertyColumnNamesByLayer?.get(layerName);
            return decodeTileLayer(tile, layerEntryByName[layerName], undefined, true, propertyNames);
        });
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
