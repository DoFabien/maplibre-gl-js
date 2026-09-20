import {classifyRings} from '@mapbox/vector-tile';
import {JSON_PREFIX} from './util.ts';
import {loadFeatureGeoJSONGeometry} from '../data/bucket/columnar/geometry_traversal.ts';
import {createColumnarPublicProperties, createColumnarPublicPropertyBindings, normalizeColumnarValue, type ColumnarPublicPropertyBindings} from '../data/bucket/columnar/feature_properties.ts';

import type {FeatureTable} from '@maplibre/mlt';
import type Point from '@mapbox/point-geometry';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';

/**
 * A helper for type to omit a property from a type
 */
export type DistributiveKeys<T> = T extends T ? keyof T : never;
/**
 * A helper for type to omit a property from a type
 */
export type DistributiveOmit<T, K extends DistributiveKeys<T>> = T extends unknown
    ? Omit<T, K>
    : never;

/**
 * An extended geojson feature used by the events to return data to the listener
 */
export type MapGeoJSONFeature = GeoJSONFeature & {
    layer: DistributiveOmit<LayerSpecification, 'source'> & {source: string};
    source: string;
    sourceLayer?: string;
    state: { [key: string]: any };
};

export interface LazyGeoJSONPropertiesFeature extends VectorTileFeatureLike {
    readonly lazyGeoJSONProperties: true;
}

function hasLazyGeoJSONProperties(feature: VectorTileFeatureLike): feature is LazyGeoJSONPropertiesFeature {
    return (feature as Partial<LazyGeoJSONPropertiesFeature>).lazyGeoJSONProperties === true;
}

export function normalizeGeoJSONProperty(value: unknown): unknown {
    const normalized = normalizeColumnarValue(value);
    return typeof normalized === 'string' && normalized.startsWith(JSON_PREFIX)
        ? JSON.parse(normalized.slice(JSON_PREFIX.length))
        : normalized;
}

/** Shares resolved column metadata, never mutable output values, without retaining unloaded tables. */
const publicPropertyBindings = new WeakMap<FeatureTable, ColumnarPublicPropertyBindings>();

/** Resolves the complete public schema only on the first properties access for a table. */
function getPublicPropertyBindings(featureTable: FeatureTable): ColumnarPublicPropertyBindings {
    let bindings = publicPropertyBindings.get(featureTable);
    if (!bindings) {
        bindings = createColumnarPublicPropertyBindings(featureTable.materializePropertyVectors());
        publicPropertyBindings.set(featureTable, bindings);
    }
    return bindings;
}

const lazyPropertiesDescriptor: PropertyDescriptor = {
    enumerable: true,
    configurable: true,
    get(this: GeoJSONFeature) {
        const properties = this._materializeProperties();
        Object.defineProperty(this, 'properties', {
            value: properties,
            enumerable: true,
            configurable: true,
            writable: true,
        });
        return properties;
    },
    set(this: GeoJSONFeature, properties: Record<string, any>) {
        Object.defineProperty(this, 'properties', {
            value: properties,
            enumerable: true,
            configurable: true,
            writable: true,
        });
    },
};

/**
 * A geojson feature
 */
export class GeoJSONFeature {
    type: 'Feature';
    _geometry: GeoJSON.Geometry;
    properties: { [name: string]: any };
    id: number | string | undefined;
    _x: number;
    _y: number;
    _z: number;

    _vectorTileFeature: VectorTileFeatureLike;
    _columnarFeatureTable?: FeatureTable;
    _columnarFeatureIndex?: number;

    constructor(vectorTileFeature: VectorTileFeatureLike, z: number, x: number, y: number, id: string | number | undefined) {
        this.type = 'Feature';
        this._vectorTileFeature = vectorTileFeature;
        this._x = x;
        this._y = y;
        this._z = z;

        if (hasLazyGeoJSONProperties(vectorTileFeature)) {
            Object.defineProperty(this, 'properties', lazyPropertiesDescriptor);
        } else {
            for (const key in vectorTileFeature.properties) {
                if (typeof vectorTileFeature.properties[key] !== 'string' || !vectorTileFeature.properties[key].startsWith(JSON_PREFIX)) {
                    continue;
                }
                // JSON parsing the special case of a json prefix that is serialized in geojson worker source.
                vectorTileFeature.properties[key] = JSON.parse(vectorTileFeature.properties[key].slice(JSON_PREFIX.length));
            }
            this.properties = vectorTileFeature.properties;
        }
        this.id = id;
    }

    static fromFeatureTable(
        featureTable: FeatureTable,
        featureIndex: number,
        z: number,
        x: number,
        y: number,
        id: string | number | undefined,
    ): GeoJSONFeature {
        return new ColumnarGeoJSONFeature(featureTable, featureIndex, z, x, y, id) as GeoJSONFeature;
    }

    _materializeProperties(): Record<string, any> {
        if (this._columnarFeatureTable && this._columnarFeatureIndex !== undefined) {
            return createColumnarPublicProperties(
                getPublicPropertyBindings(this._columnarFeatureTable),
                this._columnarFeatureIndex,
                normalizeGeoJSONProperty,
            );
        }
        return this._vectorTileFeature.properties;
    }

    private projectPoint(p: Point, x0: number, y0: number, size: number): [number, number] {
        return [
            (p.x + x0) * 360 / size - 180,
            360 / Math.PI * Math.atan(Math.exp((1 - (p.y + y0) * 2 / size) * Math.PI)) - 90
        ];
    }

    private projectLine(line: Point[], x0: number, y0: number, size: number) {
        return line.map(p => this.projectPoint(p, x0, y0, size));
    }

    /** Projects columnar geometry directly into the caller-owned GeoJSON arrays, without intermediate Point objects. */
    get geometry(): GeoJSON.Geometry {
        if (this._geometry) return this._geometry;

        const columnarFeatureTable = this._columnarFeatureTable;
        const columnarFeatureIndex = this._columnarFeatureIndex;
        if (columnarFeatureTable && columnarFeatureIndex !== undefined) {
            this._geometry = loadFeatureGeoJSONGeometry(columnarFeatureTable, columnarFeatureIndex, this._x, this._y, this._z);
            return this._geometry;
        }
        const feature = this._vectorTileFeature;

        // Copied from https://github.com/mapbox/vector-tile-js/blob/f1457ee47d0a261e6246d68c959fbd12bf56aeeb/index.js
        const extent = feature.extent;
        const size = extent * Math.pow(2, this._z);
        const x0 = extent * this._x;
        const y0 = extent * this._y;
        const vtCoords = feature.loadGeometry();
        const type = feature.type;

        switch (type) {
            case 1: {
                const points = [];
                for (const line of vtCoords) {
                    points.push(line[0]);
                }
                const coordinates = this.projectLine(points, x0, y0, size);
                this._geometry = points.length === 1 ?
                    {type: 'Point', coordinates: coordinates[0]} :
                    {type: 'MultiPoint', coordinates};
                break;
            }
            case 2: {
                const coordinates = vtCoords.map(coord => this.projectLine(coord, x0, y0, size));
                this._geometry = coordinates.length === 1 ?
                    {type: 'LineString', coordinates: coordinates[0]} :
                    {type: 'MultiLineString', coordinates};
                break;
            }
            case 3: {
                const polygons = classifyRings(vtCoords);
                const coordinates = [];
                for (const polygon of polygons) {
                    coordinates.push(polygon.map(coord => this.projectLine(coord, x0, y0, size)));
                }
                this._geometry = coordinates.length === 1 ?
                    {type: 'Polygon', coordinates: coordinates[0]} :
                    {type: 'MultiPolygon', coordinates};
                break;
            }
            default:
                throw new Error(`unknown feature type: ${type}`);
        }

        return this._geometry;
    }

    set geometry(g: GeoJSON.Geometry) {
        this._geometry = g;
    }

    toJSON(): GeoJSON.Feature {
        const json: any = {
            geometry: this.geometry
        };
        for (const i in this) {
            if (i === '_geometry' || i === '_vectorTileFeature' || i === '_columnarFeatureTable' || i === '_columnarFeatureIndex' || i === '_x' || i === '_y' || i === '_z') continue;
            json[i] = (this)[i];
        }
        return json;
    }
}

/**
 * Constructor-shaped columnar result. Keeping a stable V8 object shape is
 * materially cheaper in high-cardinality queries than assigning fields to an
 * Object.create() result, while the shared descriptor still preserves an own,
 * enumerable and lazy `properties` member on every public feature.
 */
class ColumnarGeoJSONFeature {
    type: 'Feature';
    _geometry: GeoJSON.Geometry;
    properties: { [name: string]: any };
    id: number | string | undefined;
    _x: number;
    _y: number;
    _z: number;
    _columnarFeatureTable: FeatureTable;
    _columnarFeatureIndex: number;

    constructor(
        featureTable: FeatureTable,
        featureIndex: number,
        z: number,
        x: number,
        y: number,
        id: string | number | undefined,
    ) {
        this.type = 'Feature';
        this._columnarFeatureTable = featureTable;
        this._columnarFeatureIndex = featureIndex;
        this._x = x;
        this._y = y;
        this._z = z;
        this.id = id;
        Object.defineProperty(this, 'properties', lazyPropertiesDescriptor);
    }
}

Object.setPrototypeOf(ColumnarGeoJSONFeature.prototype, GeoJSONFeature.prototype);
