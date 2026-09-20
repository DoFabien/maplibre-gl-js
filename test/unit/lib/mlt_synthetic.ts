import Point from '@mapbox/point-geometry';
import {
    BitVector,
    createConstGeometryVector,
    createStringFlatVector,
    FeatureTable,
    GEOMETRY_TYPE,
    IntFlatVector,
    TopologyVector,
    type Vector,
} from '@maplibre/mlt';
import {MLTVectorTile} from '../../../src/source/vector_tile_mlt.ts';

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
        mapbox_clip_start: number;
        mapbox_clip_end: number;
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

export function createNullableIntVector(name: string, values: Array<number | null>): IntFlatVector {
    const nullability = new BitVector(new Uint8Array(Math.ceil(values.length / 8)), values.length);
    for (let index = 0; index < values.length; index++) {
        if (values[index] !== null) {
            nullability.set(index, true);
        }
    }
    return new IntFlatVector(name, new Int32Array(values.map(value => value ?? 0)), nullability);
}

export function createNumberPropertyVector(name: string, values: number[]): Vector {
    return {
        name,
        size: values.length,
        getValue: (index: number) => values[index],
        has: () => true,
    } as unknown as Vector;
}

export function syntheticLineFeatures(): SyntheticLineFeature[] {
    return [
        {
            id: 11,
            parts: [
                [[256, 512], [1280, 512], [2304, 512]],
                [[2560, 512], [3328, 512]]
            ],
            properties: {kind: 'primary', rank: 1, sort: 2, width: 6, opacity: 9, dash: 1, pattern: 'stripe', mapbox_clip_start: 0.1, mapbox_clip_end: 0.8}
        },
        {
            id: null,
            parts: [
                [[256, 1024], [1280, 1024], [2304, 1024]],
                [[2560, 1024], [3328, 1024]]
            ],
            properties: {kind: 'secondary', rank: 2, sort: 0, width: 3, opacity: 6, dash: 0, pattern: 'dot', mapbox_clip_start: 0.0, mapbox_clip_end: 1.0}
        },
        {
            id: signedMltFeatureId,
            parts: [
                [[256, 1536], [1280, 1536], [2304, 1536]],
                [[2560, 1536], [3328, 1536]]
            ],
            properties: {kind: 'primary', rank: 3, sort: 1, width: 8, opacity: 4, dash: 1, pattern: 'stripe', mapbox_clip_start: 0.25, mapbox_clip_end: 0.75}
        },
        {
            id: 14,
            parts: [
                [[256, 2048], [1280, 2048], [2304, 2048]],
                [[2560, 2048], [3328, 2048]]
            ],
            properties: {kind: 'service', rank: 4, sort: 3, width: 2, opacity: 2, dash: 0, pattern: 'dot', mapbox_clip_start: 0.15, mapbox_clip_end: 0.9}
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

export function createSyntheticLineFeatureTable(features: SyntheticLineFeature[] = syntheticLineFeatures()): FeatureTable {
    const geometryOffsets = new Uint32Array(features.length + 1);
    const partOffsets: number[] = [0];
    const vertexBuffer: number[] = [];
    let partCount = 0;
    let vertexCount = 0;

    for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
        geometryOffsets[featureIndex] = partCount;
        for (const part of features[featureIndex].parts) {
            for (const [x, y] of part) {
                vertexBuffer.push(x, y);
                vertexCount++;
            }
            partCount++;
            partOffsets.push(vertexCount);
        }
    }
    geometryOffsets[features.length] = partCount;

    return new FeatureTable(
        syntheticLineLayer,
        createConstGeometryVector(
            features.length,
            GEOMETRY_TYPE.MULTILINESTRING,
            new TopologyVector(geometryOffsets, new Uint32Array(partOffsets), null),
            null,
            new Int32Array(vertexBuffer)
        ),
        createNullableIntVector('id', features.map(feature => feature.id ?? null)),
        [
            createStringFlatVector(features.map(feature => feature.properties.kind), 'kind'),
            new IntFlatVector('rank', new Int32Array(features.map(feature => feature.properties.rank)), features.length),
            new IntFlatVector('sort', new Int32Array(features.map(feature => feature.properties.sort)), features.length),
            new IntFlatVector('width', new Int32Array(features.map(feature => feature.properties.width)), features.length),
            new IntFlatVector('opacity', new Int32Array(features.map(feature => feature.properties.opacity)), features.length),
            new IntFlatVector('dash', new Int32Array(features.map(feature => feature.properties.dash)), features.length),
            createStringFlatVector(features.map(feature => feature.properties.pattern), 'pattern'),
            createNumberPropertyVector('mapbox_clip_start', features.map(feature => feature.properties.mapbox_clip_start)),
            createNumberPropertyVector('mapbox_clip_end', features.map(feature => feature.properties.mapbox_clip_end)),
        ]
    );
}

export function createSyntheticPolygonFeatureTable(features: SyntheticPolygonFeature[] = syntheticPolygonFeatures()): FeatureTable {
    const partOffsets = new Uint32Array(features.length + 1);
    const ringOffsets: number[] = [0];
    const vertexBuffer: number[] = [];
    let ringCount = 0;
    let vertexCount = 0;

    for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
        partOffsets[featureIndex] = ringCount;
        for (const ring of features[featureIndex].rings) {
            const lastPoint = ring[ring.length - 1];
            const isClosed = ring.length > 1 && ring[0][0] === lastPoint[0] && ring[0][1] === lastPoint[1];
            const vertexLength = ring.length - (isClosed ? 1 : 0);
            for (let vertexIndex = 0; vertexIndex < vertexLength; vertexIndex++) {
                const [x, y] = ring[vertexIndex];
                vertexBuffer.push(x, y);
                vertexCount++;
            }
            ringCount++;
            ringOffsets.push(vertexCount);
        }
    }
    partOffsets[features.length] = ringCount;

    return new FeatureTable(
        syntheticPolygonLayer,
        createConstGeometryVector(
            features.length,
            GEOMETRY_TYPE.POLYGON,
            new TopologyVector(new Uint32Array(0), partOffsets, new Uint32Array(ringOffsets)),
            null,
            new Int32Array(vertexBuffer)
        ),
        createNullableIntVector('id', features.map(feature => feature.id ?? null)),
        [
            createStringFlatVector(features.map(feature => feature.properties.kind), 'kind'),
            new IntFlatVector('height', new Int32Array(features.map(feature => feature.properties.height)), features.length),
            new IntFlatVector('base', new Int32Array(features.map(feature => feature.properties.base)), features.length),
            new IntFlatVector('sort', new Int32Array(features.map(feature => feature.properties.sort)), features.length),
            new IntFlatVector('opacity', new Int32Array(features.map(feature => feature.properties.opacity)), features.length),
            createStringFlatVector(features.map(feature => feature.properties.pattern), 'pattern'),
        ]
    );
}

export function createSyntheticPointFeatureTable(features: SyntheticPointFeature[] = syntheticPointFeatures()): FeatureTable {
    return new FeatureTable(
        syntheticPointLayer,
        createConstGeometryVector(
            features.length,
            GEOMETRY_TYPE.POINT,
            new TopologyVector(null, null, null),
            null,
            new Int32Array(features.flatMap(feature => feature.point))
        ),
        createNullableIntVector('id', features.map(feature => feature.id ?? null)),
        [
            createStringFlatVector(features.map(feature => feature.properties.category), 'category'),
            new IntFlatVector('radius', new Int32Array(features.map(feature => feature.properties.radius)), features.length),
            new IntFlatVector('sort', new Int32Array(features.map(feature => feature.properties.sort)), features.length),
            createStringFlatVector(features.map(feature => feature.properties.label), 'label'),
            createStringFlatVector(features.map(feature => feature.properties.icon), 'icon'),
        ]
    );
}

export function createSyntheticMltTile(): MLTVectorTile {
    return MLTVectorTile.fromFeatureTables([
        createSyntheticLineFeatureTable(),
        createSyntheticPolygonFeatureTable(),
        createSyntheticPointFeatureTable(),
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

export function getSyntheticFeatureRows(): {lines: SyntheticLineFeature[]; polygons: SyntheticPolygonFeature[]; points: SyntheticPointFeature[]} {
    return {
        lines: syntheticLineFeatures(),
        polygons: syntheticPolygonFeatures(),
        points: syntheticPointFeatures(),
    };
}
