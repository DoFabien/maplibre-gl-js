import Point from '@mapbox/point-geometry';
import {encodeTile, type EncodeOptions, type FeatureTable, type Layer} from '@maplibre/mlt';
import {getMltFeatureTable, MLTVectorTile} from '../../../src/source/vector_tile_mlt.ts';

import type {IndexedFeature} from '../../../src/data/bucket.ts';
import type {VectorTileLayerLike, VectorTileLike} from '@maplibre/vt-pbf';

export const syntheticLineLayer = 'synthetic_lines';
export const syntheticPolygonLayer = 'synthetic_polygons';
export const syntheticPointLayer = 'synthetic_points';
export const signedMltFeatureId = -1814668313;

export type SyntheticLineFeature = {
    id?: number | null;
    parts: Array<Array<[number, number]>>;
    properties: {
        kind: string;
        rank: number;
        sort: number;
        width: number;
        opacity: number;
        dash: number;
        pattern: string;
        geojsonvt_clip_start: number;
        geojsonvt_clip_end: number;
    };
};

export type SyntheticPolygonFeature = {
    id?: number | null;
    rings: Array<Array<[number, number]>>;
    properties: {
        kind: string;
        height: number;
        base: number;
        sort: number;
        opacity: number;
        pattern: string;
    };
};

export type SyntheticPointFeature = {
    id?: number | null;
    point: [number, number];
    properties: {
        category: string;
        radius: number;
        sort: number;
        label: string;
        icon: string;
    };
};

export function syntheticLineFeatures(): SyntheticLineFeature[] {
    return [
        {
            id: 11,
            parts: [
                [[256, 512], [1280, 512], [2304, 512]],
                [[2560, 512], [3328, 512]]
            ],
            properties: {kind: 'primary', rank: 1, sort: 2, width: 6, opacity: 9, dash: 1, pattern: 'stripe', geojsonvt_clip_start: 0.1, geojsonvt_clip_end: 0.8}
        },
        {
            id: null,
            parts: [
                [[256, 1024], [1280, 1024], [2304, 1024]],
                [[2560, 1024], [3328, 1024]]
            ],
            properties: {kind: 'secondary', rank: 2, sort: 0, width: 3, opacity: 6, dash: 0, pattern: 'dot', geojsonvt_clip_start: 0.0, geojsonvt_clip_end: 1.0}
        },
        {
            id: signedMltFeatureId,
            parts: [
                [[256, 1536], [1280, 1536], [2304, 1536]],
                [[2560, 1536], [3328, 1536]]
            ],
            properties: {kind: 'primary', rank: 3, sort: 1, width: 8, opacity: 4, dash: 1, pattern: 'stripe', geojsonvt_clip_start: 0.25, geojsonvt_clip_end: 0.75}
        },
        {
            id: 14,
            parts: [
                [[256, 2048], [1280, 2048], [2304, 2048]],
                [[2560, 2048], [3328, 2048]]
            ],
            properties: {kind: 'service', rank: 4, sort: 3, width: 2, opacity: 2, dash: 0, pattern: 'dot', geojsonvt_clip_start: 0.15, geojsonvt_clip_end: 0.9}
        }
    ];
}

export function syntheticPolygonFeatures(): SyntheticPolygonFeature[] {
    return [
        {
            id: 21,
            rings: [[[256, 256], [1152, 256], [1152, 1152], [256, 1152], [256, 256]]],
            properties: {kind: 'land', height: 6, base: 0, sort: 2, opacity: 8, pattern: 'grid'}
        },
        {
            id: null,
            rings: [
                [[1408, 256], [2304, 256], [2304, 1152], [1408, 1152], [1408, 256]],
                [[1664, 512], [2048, 512], [2048, 896], [1664, 896], [1664, 512]]
            ],
            properties: {kind: 'park', height: 10, base: 2, sort: 0, opacity: 5, pattern: 'grid'}
        },
        {
            id: signedMltFeatureId,
            rings: [[[2560, 256], [3456, 256], [3456, 1152], [2560, 1152], [2560, 256]]],
            properties: {kind: 'land', height: 14, base: 3, sort: 1, opacity: 3, pattern: 'cross'}
        },
        {
            id: 24,
            rings: [[[-256, 2560], [4352, 2560], [4352, 4608], [-256, 4608], [-256, 2560]]],
            properties: {kind: 'outside', height: 4, base: 0, sort: 3, opacity: 2, pattern: 'cross'}
        }
    ];
}

export function syntheticPointFeatures(): SyntheticPointFeature[] {
    return [
        {id: 31, point: [512, 3072], properties: {category: 'poi', radius: 5, sort: 2, label: 'Alpha', icon: 'marker'}},
        {id: null, point: [1408, 3072], properties: {category: 'label', radius: 8, sort: 0, label: 'Beta', icon: 'marker'}},
        {id: signedMltFeatureId, point: [2304, 3072], properties: {category: 'poi', radius: 11, sort: 1, label: 'Gamma', icon: 'star'}},
        {id: 34, point: [3200, 3072], properties: {category: 'hidden', radius: 4, sort: 3, label: 'Delta', icon: 'star'}},
    ];
}

/** An MLT feature id: MLT stores unsigned ids, as which a negative vector tile id reads. */
function mltId(id: number | null | undefined): bigint | undefined {
    return id === null || id === undefined ? undefined : BigInt.asUintN(64, BigInt(id));
}

/** The rings of a polygon as MLT encodes them, without the closing vertex. */
function openRing(ring: Array<[number, number]>): Array<[number, number]> {
    const last = ring[ring.length - 1];
    return ring.length > 1 && ring[0][0] === last[0] && ring[0][1] === last[1] ? ring.slice(0, -1) : ring;
}

/** Encodes layers into an MLT tile and decodes it as sources do. */
export function encodeMltTile(layers: Layer[], options?: EncodeOptions): MLTVectorTile {
    const bytes = encodeTile(layers, options);
    return new MLTVectorTile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

/** Encodes one layer into an MLT tile and returns its feature table. */
export function encodeMltFeatureTable(layer: Layer, options?: EncodeOptions): FeatureTable {
    return getMltFeatureTable(encodeMltTile([layer], options).layers[layer.name]);
}

function syntheticLineLayerOf(features: SyntheticLineFeature[], extent = 4096): Layer {
    return {
        name: syntheticLineLayer,
        extent,
        features: features.map(feature => ({
            id: mltId(feature.id),
            geometry: {type: 'MultiLineString', coordinates: feature.parts},
            properties: feature.properties,
        })),
    };
}

function syntheticPolygonLayerOf(features: SyntheticPolygonFeature[]): Layer {
    return {
        name: syntheticPolygonLayer,
        extent: 4096,
        features: features.map(feature => ({
            id: mltId(feature.id),
            geometry: {type: 'Polygon', coordinates: feature.rings.map(openRing)},
            properties: feature.properties,
        })),
    };
}

function syntheticPointLayerOf(features: SyntheticPointFeature[]): Layer {
    return {
        name: syntheticPointLayer,
        extent: 4096,
        features: features.map(feature => ({
            id: mltId(feature.id),
            geometry: {type: 'Point', coordinates: feature.point},
            properties: feature.properties,
        })),
    };
}

export function createSyntheticLineFeatureTable(features: SyntheticLineFeature[] = syntheticLineFeatures(), extent = 4096): FeatureTable {
    return encodeMltFeatureTable(syntheticLineLayerOf(features, extent));
}

export function createSyntheticPolygonFeatureTable(features: SyntheticPolygonFeature[] = syntheticPolygonFeatures()): FeatureTable {
    return encodeMltFeatureTable(syntheticPolygonLayerOf(features));
}

export function createSyntheticPointFeatureTable(features: SyntheticPointFeature[] = syntheticPointFeatures()): FeatureTable {
    return encodeMltFeatureTable(syntheticPointLayerOf(features));
}

export function createSyntheticMltTile(): MLTVectorTile {
    return encodeMltTile([
        syntheticLineLayerOf(syntheticLineFeatures()),
        syntheticPolygonLayerOf(syntheticPolygonFeatures()),
        syntheticPointLayerOf(syntheticPointFeatures()),
    ]);
}

function createSyntheticLegacyLayer(name: string, features: IndexedFeature[]): VectorTileLayerLike {
    return {
        version: 2,
        name,
        extent: 4096,
        length: features.length,
        feature: (index: number) => features[index].feature,
    };
}

export function createSyntheticLegacyTile(): VectorTileLike {
    return {
        layers: {
            [syntheticLineLayer]: createSyntheticLegacyLayer(syntheticLineLayer, createSyntheticLegacyLineFeatures()),
            [syntheticPolygonLayer]: createSyntheticLegacyLayer(syntheticPolygonLayer, createSyntheticLegacyPolygonFeatures()),
            [syntheticPointLayer]: createSyntheticLegacyLayer(syntheticPointLayer, createSyntheticLegacyPointFeatures()),
        }
    };
}

export function createSyntheticLegacyLineFeatures(features: SyntheticLineFeature[] = syntheticLineFeatures()): IndexedFeature[] {
    return features.map((feature, index) => ({
        feature: {
            id: feature.id ?? undefined,
            type: 2 as const,
            properties: feature.properties,
            extent: 4096,
            loadGeometry: () => feature.parts.map(part => part.map(([x, y]) => new Point(x, y)))
        },
        id: feature.id ?? index,
        index,
        sourceLayerIndex: 0
    }));
}

export function createSyntheticLegacyPolygonFeatures(features: SyntheticPolygonFeature[] = syntheticPolygonFeatures()): IndexedFeature[] {
    return features.map((feature, index) => ({
        feature: {
            id: feature.id ?? undefined,
            type: 3 as const,
            properties: feature.properties,
            extent: 4096,
            loadGeometry: () => feature.rings.map(ring => ring.map(([x, y]) => new Point(x, y)))
        },
        id: feature.id ?? index,
        index,
        sourceLayerIndex: 0
    }));
}

export function createSyntheticLegacyPointFeatures(features: SyntheticPointFeature[] = syntheticPointFeatures()): IndexedFeature[] {
    return features.map((feature, index) => ({
        feature: {
            id: feature.id ?? undefined,
            type: 1 as const,
            properties: feature.properties,
            extent: 4096,
            loadGeometry: () => [[new Point(feature.point[0], feature.point[1])]]
        },
        id: feature.id ?? index,
        index,
        sourceLayerIndex: 0
    }));
}
