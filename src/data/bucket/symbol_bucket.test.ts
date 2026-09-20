import {describe, test, expect, vi, beforeAll} from 'vitest';
import Point from '@mapbox/point-geometry';
import fs from 'fs';
import path from 'path';
import {PbfReader} from 'pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {SymbolBucket, type SymbolFeature} from './symbol_bucket.ts';
import {CollisionBoxArray} from '../../data/array_types.g.ts';
import {performSymbolLayout} from '../../symbol/symbol_layout.ts';
import {Placement} from '../../symbol/placement.ts';
import {CanonicalTileID, OverscaledTileID} from '../../tile/tile_id.ts';
import {Tile} from '../../tile/tile.ts';
import {CrossTileSymbolIndex} from '../../symbol/cross_tile_symbol_index.ts';
import {FeatureIndex} from '../../data/feature_index.ts';
import {createSymbolBucket, createSymbolIconBucket, createSymbolStyleLayer} from '../../../test/unit/lib/create_symbol_layer.ts';
import {RGBAImage} from '../../util/image.ts';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../../util/mlt_materialization_stats.ts';
import {ImagePosition} from '../../render/image_atlas.ts';
import {SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings.ts';
import {forEachColumnarSymbolLine} from '../../symbol/columnar_symbol_geometry.ts';
import {MercatorTransform} from '../../geo/projection/mercator_transform.ts';
import {LngLat} from '../../geo/lng_lat.ts';
import {createPopulateOptions, getFeaturesFromLayer, loadVectorTile} from '../../../test/unit/lib/tile.ts';
import {MLTVectorTile} from '../../source/vector_tile_mlt.ts';
import {SymbolStyleLayer} from '../../style/style_layer/symbol_style_layer.ts';
import {EXTENT} from '../extent.ts';
import {
    createConstGeometryVector,
    FeatureTable,
    GEOMETRY_TYPE,
    IntFlatVector,
    TopologyVector
} from '@maplibre/mlt';
import {
    createSyntheticLegacyPointFeatures,
    createSyntheticPointFeatureTable,
    syntheticPointLayer,
} from '../../../test/unit/lib/mlt_synthetic.ts';
import glyphs from '../../../test/unit/assets/fontstack-glyphs.json' with {type: 'json'};

import type {BucketParameters} from '../bucket.ts';
import type {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {IndexedFeature, PopulateParameters} from '../bucket.ts';
import type {StyleImage} from '../../style/style_image.ts';
import type {StyleGlyph} from '../../style/style_glyph.ts';

const collisionBoxArray = new CollisionBoxArray();
const transform = new MercatorTransform();
transform.resize(100, 100);

const glyphsByCluster = {
    'Test': Object.fromEntries(
        Object.entries(glyphs).map(([codePoint, glyph]) => [String.fromCodePoint(Number(codePoint)), glyph])
    )
} as unknown as Record<string, Record<string, StyleGlyph>>;
const glyphPositions = glyphsByCluster as any;

function bucketSetup(text = 'abcde') {
    return createSymbolBucket('test', 'Test', text, collisionBoxArray);
}

function createIndexedFeature(id: number, index: number, iconId: string): IndexedFeature {
    return {
        feature: {
            extent: 8192,
            type: 1,
            id,
            properties: {
                icon: iconId
            },
            loadGeometry() {
                return [[{x: 0, y: 0}]];
            }
        },
        id,
        index,
        sourceLayerIndex: 0
    } as any as IndexedFeature;
}

function loadMltTile(tilePath: string): MLTVectorTile {
    const rawTile = fs.readFileSync(tilePath);
    return new MLTVectorTile(rawTile.buffer.slice(rawTile.byteOffset, rawTile.byteOffset + rawTile.byteLength));
}

function loadVectorTileFromPath(tilePath: string): VectorTile {
    return new VectorTile(new PbfReader(fs.readFileSync(tilePath)));
}

function createRealSymbolBucket(
    layerSpec: LayerSpecification,
    zoom: number,
    sourceLayerIndex = 0,
    encoding: 'mvt' | 'mlt' = 'mlt',
    bucketCollisionBoxArray = collisionBoxArray,
) {
    const layer = new SymbolStyleLayer(layerSpec, {});
    layer.recalculate({zoom, zoomHistory: {}} as EvaluationParameters, []);
    return new SymbolBucket({
        overscaling: 1,
        zoom,
        collisionBoxArray: bucketCollisionBoxArray,
        layers: [layer],
        sourceLayerIndex,
        sourceID: 'source',
        encoding
    } as BucketParameters<SymbolStyleLayer>);
}

function structArrayBytes(array: {arrayBuffer: ArrayBuffer; length: number; bytesPerElement: number}): number[] {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

function summarizeSymbolGeometry(feature: SymbolFeature) {
    if (!feature.columnarFeatureTable) {
        return feature.geometry.map(part => part.map(point => ({x: point.x, y: point.y})));
    }

    const parts: Array<Array<{x: number; y: number}>> = [];
    forEachColumnarSymbolLine(feature, (line) => {
        const part: Array<{x: number; y: number}> = [];
        for (let pointIndex = 0; pointIndex < line.length; pointIndex += 2) {
            part.push({x: line[pointIndex], y: line[pointIndex + 1]});
        }
        parts.push(part);
    });
    return parts;
}

function summarizeSymbolFeatures(bucket: SymbolBucket) {
    return bucket.features.map((feature) => ({
        text: feature.text ? feature.text.toString() : null,
        icon: feature.icon?.name ?? null,
        type: feature.type,
        geometry: summarizeSymbolGeometry(feature)
    }));
}

function createImageFixtures(iconNames: string[], imageSizes: {[key: string]: {width: number; height: number}} = {}) {
    const imageMap: {[key: string]: StyleImage} = {};
    const imagePositions: {[key: string]: ImagePosition} = {};

    for (const [index, iconName] of iconNames.entries()) {
        const imageSize = imageSizes[iconName] || {width: 16, height: 16};
        const image = {
            data: new RGBAImage(
                imageSize,
                new Uint8Array(imageSize.width * imageSize.height * 4).fill(255)
            ),
            pixelRatio: 1,
            sdf: false
        } as any as StyleImage;
        imageMap[iconName] = image;
        imagePositions[iconName] = new ImagePosition({x: index * (imageSize.width + 2), y: 0, w: imageSize.width, h: imageSize.height}, image);
    }

    return {imageMap, imagePositions};
}

function performRealSymbolLayout(bucket: SymbolBucket, iconNames: string[] = [], imageSizes: {[key: string]: {width: number; height: number}} = {}) {
    const {imageMap, imagePositions} = createImageFixtures(iconNames, imageSizes);
    performSymbolLayout({
        bucket,
        glyphMap: glyphsByCluster,
        glyphPositions,
        imageMap,
        imagePositions,
        subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
    } as any);
}

function createSymbolTile(tileID: OverscaledTileID, bucket: SymbolBucket, layerId: string) {
    const tile = new Tile(tileID, 512);
    tile.latestFeatureIndex = new FeatureIndex(tileID);
    tile.buckets = {[layerId]: bucket};
    tile.collisionBoxArray = collisionBoxArray;
    return tile;
}

function placeSymbolTile(placement: Placement, layer: SymbolStyleLayer, tile: Tile) {
    const parts = [];
    placement.getBucketParts(parts, layer, tile, false);
    for (const part of parts) {
        placement.placeLayerBucketPart(part, {}, false);
    }
}

function summarizeVisibleIcons(tileID: OverscaledTileID, bucket: SymbolBucket, placement: Placement) {
    return Array.from({length: bucket.symbolInstances.length}, (_, i) => {
        const symbolInstance = bucket.symbolInstances.get(i);
        const jointPlacement = placement.placements[symbolInstance.crossTileID];
        const feature = bucket.features.find(candidate => candidate.index === symbolInstance.featureIndex);

        return {
            visible: jointPlacement?.icon ?? false,
            crossTileID: symbolInstance.crossTileID,
            sourceFeatureIndex: symbolInstance.featureIndex,
            worldX: tileID.canonical.x * EXTENT + symbolInstance.anchorX,
            worldY: tileID.canonical.y * EXTENT + symbolInstance.anchorY,
            icon: feature?.icon?.name ?? null
        };
    })
        .filter((entry) => entry.visible)
        .sort((a, b) => a.worldY - b.worldY || a.worldX - b.worldX || a.sourceFeatureIndex - b.sourceFeatureIndex);
}

function summarizeVisibleText(tileID: OverscaledTileID, bucket: SymbolBucket, placement: Placement) {
    return Array.from({length: bucket.symbolInstances.length}, (_, i) => {
        const symbolInstance = bucket.symbolInstances.get(i);
        const jointPlacement = placement.placements[symbolInstance.crossTileID];
        const feature = bucket.features[symbolInstance.featureIndex];

        return {
            visible: jointPlacement?.text ?? false,
            crossTileID: symbolInstance.crossTileID,
            worldX: tileID.canonical.x * EXTENT + symbolInstance.anchorX,
            worldY: tileID.canonical.y * EXTENT + symbolInstance.anchorY,
            text: feature?.text ? feature.text.toString() : null
        };
    })
        .filter((entry) => entry.visible)
        .sort((a, b) => a.worldY - b.worldY || a.worldX - b.worldX || String(a.text).localeCompare(String(b.text)));
}

function glyphsRequestedFor(text: string): string[] {
    const bucket = createSymbolBucket('test', 'Test', text, collisionBoxArray);
    const options = createPopulateOptions([]);
    const feature = {
        type: 1,
        id: 1,
        properties: {},
        loadGeometry: () => [[{x: 0, y: 0}]],
    };

    bucket.populate(
        [{feature, id: 1, index: 0, sourceLayerIndex: 0} as unknown as IndexedFeature],
        options,
        new CanonicalTileID(0, 0, 0),
    );

    return Object.keys(options.glyphDependencies.Test ?? {});
}

describe('SymbolBucket', () => {
    let features: IndexedFeature[];
    beforeAll(() => {
        // Load point features from fixture tile.
        const sourceLayer = loadVectorTile().layers.place_label;
        features = [{feature: sourceLayer.feature(10)} as unknown as IndexedFeature];
    });
    test('SymbolBucket', () => {
        const bucketA = bucketSetup();
        const bucketB = bucketSetup();
        const options = createPopulateOptions([]);
        const placement = new Placement(transform, undefined, 0, true);
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        const crossTileSymbolIndex = new CrossTileSymbolIndex();

        // add feature from bucket A
        bucketA.populate(features, options, undefined);
        performSymbolLayout(
            {
                bucket: bucketA,
                glyphMap: glyphsByCluster,
                glyphPositions: {},
                subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
            } as any);
        const tileA = new Tile(tileID, 512);
        tileA.latestFeatureIndex = new FeatureIndex(tileID);
        tileA.buckets = {test: bucketA};
        tileA.collisionBoxArray = collisionBoxArray;

        // add same feature from bucket B
        bucketB.populate(features, options, undefined);
        performSymbolLayout({
            bucket: bucketB, glyphMap: glyphsByCluster, glyphPositions: {}, subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        } as any);
        const tileB = new Tile(tileID, 512);
        tileB.buckets = {test: bucketB};
        tileB.collisionBoxArray = collisionBoxArray;

        crossTileSymbolIndex.addLayer(bucketA.layers[0], [tileA, tileB], undefined);

        const place = (layer, tile) => {
            const parts = [];
            placement.getBucketParts(parts, layer, tile, false);
            for (const part of parts) {
                placement.placeLayerBucketPart(part, {}, false);
            }
        };
        const a = placement.collisionIndex.grid.keysLength();
        place(bucketA.layers[0], tileA);
        const b = placement.collisionIndex.grid.keysLength();
        expect(a).not.toBe(b);

        const a2 = placement.collisionIndex.grid.keysLength();
        place(bucketB.layers[0], tileB);
        const b2 = placement.collisionIndex.grid.keysLength();
        expect(b2).toBe(a2);
    });

    test('SymbolBucket integer overflow', () => {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const bucket = bucketSetup();
        bucket.maxGlyphs = 5;

        const options = {iconDependencies: {}, glyphDependencies: {}} as PopulateParameters;

        bucket.populate(features, options, undefined);
        const fakeGlyph = {rect: {w: 10, h: 10}, metrics: {left: 10, top: 10, advance: 10}};
        performSymbolLayout({
            bucket,
            glyphMap: glyphsByCluster,
            glyphPositions: {'Test': {a: fakeGlyph, b: fakeGlyph, c: fakeGlyph, d: fakeGlyph, e: fakeGlyph, f: fakeGlyph} as any},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        } as any);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toContain('Too many glyphs being rendered in a tile.');
    });

    test('SymbolBucket image undefined sdf', () => {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        spy.mockReset();

        const imageMap = {
            a: {
                data: new RGBAImage({width: 0, height: 0})
            },
            b: {
                data: new RGBAImage({width: 0, height: 0}),
                sdf: false
            }
        } as any as { [_: string]: StyleImage };
        const imagePos = {
            a: new ImagePosition({x: 0, y: 0, w: 10, h: 10}, 1 as any as StyleImage),
            b: new ImagePosition({x: 10, y: 0, w: 10, h: 10}, 1 as any as StyleImage)
        };
        const bucket = createSymbolIconBucket('test', 'icon', collisionBoxArray);
        const options = createPopulateOptions([]);

        bucket.populate(
            [
                createIndexedFeature(0, 0, 'a'),
                createIndexedFeature(1, 1, 'b'),
                createIndexedFeature(2, 2, 'a')
            ],
            options, undefined
        );

        const icons = options.iconDependencies;
        expect(icons.a).toBe(true);
        expect(icons.b).toBe(true);

        performSymbolLayout({
            bucket, imageMap, imagePositions: imagePos,
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        } as any);

        // undefined SDF should be treated the same as false SDF - no warning raised
        expect(spy).not.toHaveBeenCalledTimes(1);
    });

    test('SymbolBucket image mismatched sdf', () => {
        const originalWarn = console.warn;
        console.warn = vi.fn();

        const imageMap = {
            a: {
                data: new RGBAImage({width: 0, height: 0}),
                sdf: true
            },
            b: {
                data: new RGBAImage({width: 0, height: 0}),
                sdf: false
            }
        } as any as { [_: string]: StyleImage };
        const imagePos = {
            a: new ImagePosition({x: 0, y: 0, w: 10, h: 10}, 1 as any as StyleImage),
            b: new ImagePosition({x: 10, y: 0, w: 10, h: 10}, 1 as any as StyleImage)
        };
        const bucket = createSymbolIconBucket('test', 'icon', collisionBoxArray);
        const options = createPopulateOptions([]);

        bucket.populate(
            [
                createIndexedFeature(0, 0, 'a'),
                createIndexedFeature(1, 1, 'b'),
                createIndexedFeature(2, 2, 'a')
            ],
            options, undefined
        );

        const icons = options.iconDependencies;
        expect(icons.a).toBe(true);
        expect(icons.b).toBe(true);

        performSymbolLayout({bucket, imageMap, imagePositions: imagePos, subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision} as any);

        // true SDF and false SDF in same bucket should trigger warning
        expect(console.warn).toHaveBeenCalledTimes(1);
        console.warn = originalWarn;
    });

    test('SymbolBucket detects rtl text', () => {
        const rtlBucket = bucketSetup('مرحبا');
        const ltrBucket = bucketSetup('hello');
        const options = createPopulateOptions([]);
        rtlBucket.populate(features, options, undefined);
        ltrBucket.populate(features, options, undefined);

        expect(rtlBucket.hasRTLText).toBeTruthy();
        expect(ltrBucket.hasRTLText).toBeFalsy();
    });

    test('SymbolBucket shapes rtl text', () => {
        expect(glyphsRequestedFor('مرحبا')).toEqual(['ﻣ', 'ﺮ', 'ﺣ', 'ﺒ', 'ﺎ']);
    });

    test('SymbolBucket shapes columnar RTL labels and requests their glyphs', () => {
        const bucket = createRealSymbolBucket({
            id: 'rtl-label', type: 'symbol', source: 'source', 'source-layer': syntheticPointLayer,
            layout: {'text-field': 'مرحبا', 'text-font': ['Test']}
        }, 0, 0, 'mlt');
        const options = createPopulateOptions([]);
        bucket.populate(createSyntheticPointFeatureTable(), options, new CanonicalTileID(0, 0, 0));

        expect(bucket.hasRTLText).toBe(true);
        expect(bucket.features.length).toBeGreaterThan(0);
        expect(Object.keys(options.glyphDependencies.Test)).toEqual(['ﻣ', 'ﺮ', 'ﺣ', 'ﺒ', 'ﺎ']);
        expect(bucket.features.every(feature => feature.geometry.length === 0)).toBe(true);
    });

    test('SymbolBucket detects rtl text mixed with ltr text', () => {
        const mixedBucket = bucketSetup('مرحبا translates to hello');
        const options = createPopulateOptions([]);
        mixedBucket.populate(features, options, undefined);

        expect(mixedBucket.hasRTLText).toBeTruthy();
    });

    test('SymbolBucket columnar populate matches wrapper-based MLT populate for render-labels fixture', () => {
        const tilePath = path.resolve(__dirname, '../../../test/integration/assets/tiles/mlt/5/22/12.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.place;
        const canonical = new OverscaledTileID(5, 0, 5, 22, 12).canonical;
        const layerSpec = {
            id: 'place_label_other',
            type: 'symbol',
            source: 'source',
            'source-layer': 'place',
            layout: {
                'text-field': '{name:latin}',
                'text-font': ['Noto Sans Regular'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 3, 12, 8, 22]
            },
            paint: {
                'text-color': '#ffffff'
            }
        } as LayerSpecification;

        const legacyBucket = createRealSymbolBucket(layerSpec, 5.7, 0, 'mvt');
        legacyBucket.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions([]), canonical);

        const columnarBucket = createRealSymbolBucket(layerSpec, 5.7, 0, 'mlt');
        columnarBucket.populate((sourceLayer as any).featureTable, createPopulateOptions([]), canonical);

        expect(summarizeSymbolFeatures(columnarBucket)).toEqual(summarizeSymbolFeatures(legacyBucket));
    });

    test('SymbolBucket places columnar points without geometry objects', () => {
        const geometryVector = createConstGeometryVector(
            1,
            GEOMETRY_TYPE.POINT,
            new TopologyVector(null, null, null),
            null,
            new Int32Array([12, 34])
        ) as any;
        geometryVector.getGeometries = vi.fn(() => {
            throw new Error('getGeometries should not be called');
        });
        const featureTable = new FeatureTable(
            'place',
            geometryVector,
            new IntFlatVector('id', new Int32Array([7]), 1),
            []
        );
        const layerSpec = {
            id: 'place-label',
            type: 'symbol',
            source: 'source',
            'source-layer': 'place',
            layout: {
                'text-field': 'Hello',
                'text-font': ['Test'],
                'text-size': 12
            }
        } as LayerSpecification;

        const bucket = createRealSymbolBucket(layerSpec, 5, 0, 'mlt');
        const options = createPopulateOptions([]);
        options.skipLayerFeatureFilter = true;
        const stats = createMltMaterializationStats({
            strict: true,
            forbiddenCounters: ['pointObjects', 'geometryPartsMaterialized', 'propertyObjects', 'propertyProxyMisses']
        });
        const deactivate = activateMltMaterializationStats(stats);
        try {
            bucket.populate(featureTable, options, new OverscaledTileID(5, 0, 5, 0, 0).canonical);
            performRealSymbolLayout(bucket);
        } finally {
            deactivate();
        }

        expect(geometryVector.getGeometries).not.toHaveBeenCalled();
        expect(bucket.features[0].geometry).toHaveLength(0);
        expect(bucket.features[0].columnarFeatureTable).toBeUndefined();
        expect(bucket.features[0].columnarEvaluationFeature).toBeUndefined();
        expect(Object.keys(bucket.features[0].properties)).toHaveLength(0);
        expect(bucket.symbolInstances).toHaveLength(1);
        expect(bucket.symbolInstances.get(0)).toMatchObject({anchorX: 24, anchorY: 68});
        expect(stats.counters.geometryPartsMaterialized).toBe(0);
        expect(stats.counters.pointObjects).toBe(0);
        expect(stats.counters.propertyObjects).toBe(0);
        expect(stats.counters.propertyProxyMisses).toBe(0);
        expect(summarizeSymbolFeatures(bucket)).toEqual([{
            text: 'Hello',
            icon: null,
            type: 'Point',
            geometry: []
        }]);
    });

    test('SymbolBucket places columnar multipoints without per-feature geometry arrays', () => {
        const geometryVector = createConstGeometryVector(
            2,
            GEOMETRY_TYPE.MULTIPOINT,
            new TopologyVector(new Uint32Array([0, 2, 5]), null, null),
            null,
            new Int32Array([
                100, 100,
                200, 200,
                300, 300,
                400, 400,
                500, 500
            ])
        ) as any;
        geometryVector.getGeometries = vi.fn(() => {
            throw new Error('getGeometries should not be called');
        });
        const featureTable = new FeatureTable(
            'multipoint-place',
            geometryVector,
            new IntFlatVector('id', new Int32Array([7, 8]), 2),
            []
        );
        const layerSpec = {
            id: 'multipoint-place-label',
            type: 'symbol',
            source: 'source',
            'source-layer': 'multipoint-place',
            layout: {
                'text-field': 'Hello',
                'text-font': ['Test'],
                'text-size': 12
            }
        } as LayerSpecification;
        const bucket = createRealSymbolBucket(layerSpec, 5, 0, 'mlt');
        const options = createPopulateOptions([]);
        options.skipLayerFeatureFilter = true;
        const stats = createMltMaterializationStats({
            strict: true,
            forbiddenCounters: ['pointObjects', 'geometryPartsMaterialized']
        });
        const deactivate = activateMltMaterializationStats(stats);

        try {
            bucket.populate(featureTable, options, new OverscaledTileID(5, 0, 5, 0, 0).canonical);
            performRealSymbolLayout(bucket);
        } finally {
            deactivate();
        }

        expect(geometryVector.getGeometries).not.toHaveBeenCalled();
        expect(bucket.features).toHaveLength(2);
        expect(bucket.features[0].geometry).toBe(bucket.features[1].geometry);
        expect(bucket.features[0].geometry).toHaveLength(0);
        expect(bucket.features.every(feature => feature.columnarFeatureTable === undefined)).toBe(true);
        expect(Array.from({length: bucket.symbolInstances.length}, (_value, index) => {
            const instance = bucket.symbolInstances.get(index);
            return [instance.anchorX, instance.anchorY, instance.featureIndex];
        })).toEqual([
            [200, 200, 0],
            [400, 400, 0],
            [600, 600, 1],
            [800, 800, 1],
            [1000, 1000, 1]
        ]);
        expect(stats.counters.geometryPartsMaterialized).toBe(0);
        expect(stats.counters.pointObjects).toBe(0);
    });

    test('SymbolBucket columnar populate matches synthetic legacy labels, icons, filters and sort keys', () => {
        const canonical = new OverscaledTileID(0, 0, 0, 0, 0).canonical;
        const layerSpec = {
            id: 'synthetic-symbols',
            type: 'symbol',
            source: 'source',
            'source-layer': syntheticPointLayer,
            filter: ['!=', ['get', 'category'], 'hidden'],
            layout: {
                'text-field': ['get', 'label'],
                'text-font': ['Test'],
                'text-size': 12,
                'icon-image': ['get', 'icon'],
                'icon-allow-overlap': true,
                'text-allow-overlap': true,
                'symbol-sort-key': ['get', 'sort']
            }
        } as LayerSpecification;
        const summarize = (bucket: SymbolBucket) => bucket.features.map((feature) => ({
            text: feature.text ? feature.text.toString() : null,
            icon: feature.icon?.name ?? null,
            type: feature.type,
            geometry: summarizeSymbolGeometry(feature),
            category: feature.properties.category,
            sort: feature.properties.sort
        }));

        const legacyBucket = createRealSymbolBucket(layerSpec, 0, 0, 'mvt');
        legacyBucket.populate(createSyntheticLegacyPointFeatures(), createPopulateOptions(['marker', 'star']), canonical);

        const columnarBucket = createRealSymbolBucket(layerSpec, 0, 0, 'mlt');
        const stats = createMltMaterializationStats({
            strict: true,
            forbiddenCounters: ['propertyObjects', 'propertyProxyMisses']
        });
        const deactivate = activateMltMaterializationStats(stats);
        try {
            columnarBucket.populate(createSyntheticPointFeatureTable(), createPopulateOptions(['marker', 'star']), canonical);
        } finally {
            deactivate();
        }

        expect(summarize(columnarBucket)).toEqual(summarize(legacyBucket));
        expect(Object.keys(columnarBucket.features[0].properties).sort()).toEqual(['category', 'icon', 'label', 'sort']);
        expect(stats.counters.propertyObjects).toBe(0);
        expect(stats.counters.propertyProxyMisses).toBe(0);
    });

    test('SymbolBucket columnar populate matches wrapper-based MLT populate for render-housenr fixture', () => {
        const tilePath = path.resolve(__dirname, '../../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.housenumber;
        const canonical = new OverscaledTileID(14, 0, 14, 8716, 5685).canonical;
        const layerSpec = {
            id: 'housenumber',
            type: 'symbol',
            source: 'source',
            'source-layer': 'housenumber',
            layout: {
                'text-field': '{housenumber}',
                'text-font': ['Noto Sans Regular'],
                'text-size': 30
            },
            paint: {
                'text-color': '#ffffff'
            }
        } as LayerSpecification;

        const legacyBucket = createRealSymbolBucket(layerSpec, 17.81, 0, 'mvt');
        legacyBucket.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions([]), canonical);

        const columnarBucket = createRealSymbolBucket(layerSpec, 17.81, 0, 'mlt');
        columnarBucket.populate((sourceLayer as any).featureTable, createPopulateOptions([]), canonical);

        expect(summarizeSymbolFeatures(columnarBucket)).toEqual(summarizeSymbolFeatures(legacyBucket));
    });

    test('SymbolBucket columnar populate matches wrapper-based MLT populate for real place icons', () => {
        const tilePath = path.resolve(__dirname, '../../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.place;
        const canonical = new OverscaledTileID(14, 0, 14, 8716, 5685).canonical;
        const layerSpec = {
            id: 'place-icons',
            type: 'symbol',
            source: 'source',
            'source-layer': 'place',
            filter: [
                'all',
                ['has', 'rank'],
                ['any',
                    ['==', ['get', 'class'], 'suburb'],
                    ['==', ['get', 'class'], 'neighbourhood']
                ],
                ['!', ['==', ['get', 'name'], 'Nymphenburg']]
            ],
            layout: {
                'icon-image': [
                    'match',
                    ['get', 'class'],
                    'suburb',
                    'fav-circle-18',
                    'neighbourhood',
                    'fav-square-18',
                    'fav-marker-18'
                ],
                'icon-size': 1,
                'icon-allow-overlap': true,
                'symbol-sort-key': ['get', 'rank']
            }
        } as LayerSpecification;

        const legacyBucket = createRealSymbolBucket(layerSpec, 14.92, 0, 'mvt');
        legacyBucket.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions([]), canonical);

        const columnarBucket = createRealSymbolBucket(layerSpec, 14.92, 0, 'mlt');
        columnarBucket.populate((sourceLayer as any).featureTable, createPopulateOptions([]), canonical);

        expect(summarizeSymbolFeatures(columnarBucket)).toEqual(summarizeSymbolFeatures(legacyBucket));
    });

    test('SymbolBucket columnar populate matches wrapper-based MLT populate for line placement labels', () => {
        const tilePath = path.resolve(__dirname, '../../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.transportation;
        const canonical = new OverscaledTileID(14, 0, 14, 8716, 5685).canonical;
        const layerSpec = {
            id: 'transportation-labels',
            type: 'symbol',
            source: 'source',
            'source-layer': 'transportation',
            filter: [
                'all',
                ['has', 'class'],
                ['any',
                    ['==', ['get', 'class'], 'path'],
                    ['==', ['get', 'class'], 'service']
                ]
            ],
            layout: {
                'symbol-placement': 'line',
                'text-field': ['to-string', ['get', 'class']],
                'text-font': ['Noto Sans Regular'],
                'text-size': 14
            },
            paint: {
                'text-color': '#ffffff'
            }
        } as LayerSpecification;

        const legacyBucket = createRealSymbolBucket(layerSpec, 15.8, 0, 'mvt');
        legacyBucket.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions([]), canonical);

        const columnarBucket = createRealSymbolBucket(layerSpec, 15.8, 0, 'mlt');
        columnarBucket.populate((sourceLayer as any).featureTable, createPopulateOptions([]), canonical);

        expect(summarizeSymbolFeatures(columnarBucket)).toEqual(summarizeSymbolFeatures(legacyBucket));
    }, 60000);

    test('SymbolBucket places and merges columnar lines without geometry objects', () => {
        const rawLines = [
            [256, 4096, 3000, 4096],
            [6000, 4096, 7936, 4096],
            [3000, 4096, 6000, 4096],
        ];
        const geometryVector = createConstGeometryVector(
            3,
            GEOMETRY_TYPE.LINESTRING,
            new TopologyVector(null, new Uint32Array([0, 2, 4, 6]), null),
            null,
            new Int32Array(rawLines.flat())
        ) as any;
        geometryVector.getGeometries = vi.fn(() => {
            throw new Error('getGeometries should not be called');
        });
        const featureTable = new FeatureTable(
            'roads',
            geometryVector,
            new IntFlatVector('id', new Int32Array([1, 2, 3]), 3),
            [],
            8192
        );
        const layerSpec = {
            id: 'road-label',
            type: 'symbol',
            source: 'source',
            'source-layer': 'roads',
            layout: {
                'symbol-placement': 'line',
                'text-field': 'Road',
                'text-font': ['Test'],
                'text-size': 12
            }
        } as LayerSpecification;
        const legacyBucket = createRealSymbolBucket(layerSpec, 5, 0, 'mvt', new CollisionBoxArray());
        const legacyFeatures = rawLines.map((line, index) => ({
            feature: {
                extent: 8192,
                type: 2,
                id: index + 1,
                properties: {},
                loadGeometry: () => [[new Point(line[0], line[1]), new Point(line[2], line[3])]],
            },
            id: index + 1,
            index,
            sourceLayerIndex: 0,
        }) as unknown as IndexedFeature);
        const legacyOptions = createPopulateOptions([]);
        legacyOptions.skipLayerFeatureFilter = true;
        legacyBucket.populate(legacyFeatures, legacyOptions, new OverscaledTileID(5, 0, 5, 0, 0).canonical);
        performRealSymbolLayout(legacyBucket);

        const bucket = createRealSymbolBucket(layerSpec, 5, 0, 'mlt', new CollisionBoxArray());
        const options = createPopulateOptions([]);
        options.skipLayerFeatureFilter = true;
        const stats = createMltMaterializationStats({
            strict: true,
            forbiddenCounters: [
                'vectorTileFeatureWrappers',
                'pointObjects',
                'geometryPartsMaterialized',
                'propertyObjects',
                'propertyProxyMisses',
                'temporaryScalarBuffers',
                'temporaryScalarValues',
                'coordinateTuples',
                'propertyDescriptors',
            ]
        });
        const deactivate = activateMltMaterializationStats(stats);
        try {
            bucket.populate(featureTable, options, new OverscaledTileID(5, 0, 5, 0, 0).canonical);
            performRealSymbolLayout(bucket);
        } finally {
            deactivate();
        }

        expect(geometryVector.getGeometries).not.toHaveBeenCalled();
        expect(bucket.features).toHaveLength(1);
        expect(bucket.features[0].geometry).toHaveLength(0);
        expect(bucket.features[0].columnarFeatureTable).toBeUndefined();
        expect(bucket.features[0].columnarLineSlices).toBeUndefined();
        expect(bucket.symbolInstances.length).toBeGreaterThan(0);
        expect(bucket.lineVertexArray.length).toBeGreaterThan(0);
        expect(Array.from({length: bucket.symbolInstances.length}, (_, index) => {
            const instance = bucket.symbolInstances.get(index);
            return [instance.anchorX, instance.anchorY];
        })).toEqual(Array.from({length: legacyBucket.symbolInstances.length}, (_, index) => {
            const instance = legacyBucket.symbolInstances.get(index);
            return [instance.anchorX, instance.anchorY];
        }));
        expect(structArrayBytes(bucket.symbolInstances)).toEqual(structArrayBytes(legacyBucket.symbolInstances));
        expect(structArrayBytes(bucket.lineVertexArray)).toEqual(structArrayBytes(legacyBucket.lineVertexArray));
        expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
        expect(stats.counters.geometryPartsMaterialized).toBe(0);
        expect(stats.counters.pointObjects).toBe(0);
        expect(stats.counters.propertyObjects).toBe(0);
        expect(stats.counters.propertyProxyMisses).toBe(0);
        expect(stats.counters.temporaryScalarBuffers).toBe(0);
        expect(stats.counters.temporaryScalarValues).toBe(0);
        expect(stats.counters.coordinateTuples).toBe(0);
        expect(stats.counters.propertyDescriptors).toBe(0);
    });

    test('SymbolBucket places columnar line-center labels without geometry objects', () => {
        const geometryVector = createConstGeometryVector(
            1,
            GEOMETRY_TYPE.LINESTRING,
            new TopologyVector(null, new Uint32Array([0, 2]), null),
            null,
            new Int32Array([256, 4096, 7936, 4096])
        ) as any;
        geometryVector.getGeometries = vi.fn(() => {
            throw new Error('getGeometries should not be called');
        });
        const featureTable = new FeatureTable(
            'roads',
            geometryVector,
            new IntFlatVector('id', new Int32Array([1]), 1),
            [],
            8192
        );
        const layerSpec = {
            id: 'road-center-label',
            type: 'symbol',
            source: 'source',
            'source-layer': 'roads',
            layout: {
                'symbol-placement': 'line-center',
                'text-field': 'Road',
                'text-font': ['Test'],
                'text-size': 12
            }
        } as LayerSpecification;
        const bucket = createRealSymbolBucket(layerSpec, 5, 0, 'mlt');
        const options = createPopulateOptions([]);
        options.skipLayerFeatureFilter = true;
        const stats = createMltMaterializationStats({
            strict: true,
            forbiddenCounters: ['pointObjects', 'geometryPartsMaterialized', 'propertyObjects', 'propertyProxyMisses']
        });
        const deactivate = activateMltMaterializationStats(stats);
        try {
            bucket.populate(featureTable, options, new OverscaledTileID(5, 0, 5, 0, 0).canonical);
            performRealSymbolLayout(bucket);
        } finally {
            deactivate();
        }

        expect(geometryVector.getGeometries).not.toHaveBeenCalled();
        expect(bucket.features[0].geometry).toHaveLength(0);
        expect(bucket.features[0].columnarFeatureTable).toBeUndefined();
        expect(bucket.symbolInstances).toHaveLength(1);
        expect(bucket.symbolInstances.get(0)).toMatchObject({anchorX: 4096, anchorY: 4096});
        expect(bucket.lineVertexArray.length).toBeGreaterThan(0);
        expect(stats.counters.geometryPartsMaterialized).toBe(0);
        expect(stats.counters.pointObjects).toBe(0);
        expect(stats.counters.propertyObjects).toBe(0);
        expect(stats.counters.propertyProxyMisses).toBe(0);
    });

    test('SymbolBucket columnar populate matches wrapper-based MLT populate for mixed place labels and icons', () => {
        const tilePath = path.resolve(__dirname, '../../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.place;
        const canonical = new OverscaledTileID(14, 0, 14, 8716, 5685).canonical;
        const layerSpec = {
            id: 'place-mixed',
            type: 'symbol',
            source: 'source',
            'source-layer': 'place',
            filter: [
                'all',
                ['has', 'rank'],
                ['any',
                    ['==', ['get', 'class'], 'suburb'],
                    ['==', ['get', 'class'], 'neighbourhood']
                ],
                ['!', ['==', ['get', 'name'], 'Nymphenburg']]
            ],
            layout: {
                'text-field': ['get', 'name'],
                'text-font': ['Noto Sans Regular'],
                'text-size': 13,
                'icon-image': [
                    'match',
                    ['get', 'class'],
                    'suburb',
                    'fav-circle-18',
                    'neighbourhood',
                    'fav-square-18',
                    'fav-marker-18'
                ],
                'icon-size': 0.85,
                'icon-text-fit': 'none',
                'icon-allow-overlap': true,
                'text-allow-overlap': true,
                'symbol-sort-key': ['get', 'rank']
            },
            paint: {
                'text-color': '#f8fafc'
            }
        } as LayerSpecification;

        const legacyBucket = createRealSymbolBucket(layerSpec, 14.92, 0, 'mvt');
        legacyBucket.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions([]), canonical);

        const columnarBucket = createRealSymbolBucket(layerSpec, 14.92, 0, 'mlt');
        columnarBucket.populate((sourceLayer as any).featureTable, createPopulateOptions([]), canonical);

        expect(summarizeSymbolFeatures(columnarBucket)).toEqual(summarizeSymbolFeatures(legacyBucket));
    });

    test('SymbolBucket columnar layout preserves crossTile IDs for mixed symbols on real MLT tile updates', () => {
        const tilePath = path.resolve(__dirname, '../../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.place;
        const canonical = new OverscaledTileID(14, 0, 14, 8716, 5685).canonical;
        const tileID = new OverscaledTileID(14, 0, 14, 8716, 5685);
        const layerSpec = {
            id: 'place-mixed-crosstile',
            type: 'symbol',
            source: 'source',
            'source-layer': 'place',
            filter: [
                'all',
                ['has', 'rank'],
                ['any',
                    ['==', ['get', 'class'], 'suburb'],
                    ['==', ['get', 'class'], 'neighbourhood']
                ],
                ['!', ['==', ['get', 'name'], 'Nymphenburg']]
            ],
            layout: {
                'text-field': ['get', 'name'],
                'text-font': ['Test'],
                'text-size': 13,
                'icon-image': [
                    'match',
                    ['get', 'class'],
                    'suburb',
                    'fav-circle-18',
                    'neighbourhood',
                    'fav-square-18',
                    'fav-marker-18'
                ],
                'icon-size': 0.85,
                'symbol-sort-key': ['get', 'rank']
            }
        } as LayerSpecification;

        const legacyBucket = createRealSymbolBucket(layerSpec, 14.92, 0, 'mvt');
        legacyBucket.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions([]), canonical);
        performRealSymbolLayout(legacyBucket, ['fav-circle-18', 'fav-square-18', 'fav-marker-18']);

        const columnarBucket = createRealSymbolBucket(layerSpec, 14.92, 0, 'mlt');
        columnarBucket.populate((sourceLayer as any).featureTable, createPopulateOptions([]), canonical);
        performRealSymbolLayout(columnarBucket, ['fav-circle-18', 'fav-square-18', 'fav-marker-18']);

        const crossTileSymbolIndex = new CrossTileSymbolIndex();
        const legacyTile = createSymbolTile(tileID, legacyBucket, layerSpec.id);
        const columnarTile = createSymbolTile(tileID, columnarBucket, layerSpec.id);

        crossTileSymbolIndex.addLayer(legacyBucket.layers[0], [legacyTile], 0);
        const legacyCrossTileIDs = Array.from({length: legacyBucket.symbolInstances.length}, (_, i) => legacyBucket.symbolInstances.get(i).crossTileID);

        crossTileSymbolIndex.addLayer(columnarBucket.layers[0], [columnarTile], 0);
        const columnarCrossTileIDs = Array.from({length: columnarBucket.symbolInstances.length}, (_, i) => columnarBucket.symbolInstances.get(i).crossTileID);

        expect(columnarCrossTileIDs).toEqual(legacyCrossTileIDs);
    });

    test('SymbolBucket columnar placement does not duplicate mixed symbols across real MLT tile updates', () => {
        const tilePath = path.resolve(__dirname, '../../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.place;
        const canonical = new OverscaledTileID(14, 0, 14, 8716, 5685).canonical;
        const tileID = new OverscaledTileID(14, 0, 14, 8716, 5685);
        const layerSpec = {
            id: 'place-mixed-placement',
            type: 'symbol',
            source: 'source',
            'source-layer': 'place',
            filter: [
                'all',
                ['has', 'rank'],
                ['any',
                    ['==', ['get', 'class'], 'suburb'],
                    ['==', ['get', 'class'], 'neighbourhood']
                ],
                ['!', ['==', ['get', 'name'], 'Nymphenburg']]
            ],
            layout: {
                'text-field': ['get', 'name'],
                'text-font': ['Test'],
                'text-size': 13,
                'icon-image': [
                    'match',
                    ['get', 'class'],
                    'suburb',
                    'fav-circle-18',
                    'neighbourhood',
                    'fav-square-18',
                    'fav-marker-18'
                ],
                'icon-size': 0.85,
                'icon-allow-overlap': false,
                'text-allow-overlap': false,
                'symbol-sort-key': ['get', 'rank']
            }
        } as LayerSpecification;

        const bucketA = createRealSymbolBucket(layerSpec, 14.92, 0, 'mlt');
        bucketA.populate((sourceLayer as any).featureTable, createPopulateOptions([]), canonical);
        performRealSymbolLayout(bucketA, ['fav-circle-18', 'fav-square-18', 'fav-marker-18']);

        const bucketB = createRealSymbolBucket(layerSpec, 14.92, 0, 'mlt');
        bucketB.populate((sourceLayer as any).featureTable, createPopulateOptions([]), canonical);
        performRealSymbolLayout(bucketB, ['fav-circle-18', 'fav-square-18', 'fav-marker-18']);

        const tileA = createSymbolTile(tileID, bucketA, layerSpec.id);
        const tileB = createSymbolTile(tileID, bucketB, layerSpec.id);
        const crossTileSymbolIndex = new CrossTileSymbolIndex();
        const placement = new Placement(transform, undefined, 0, true);

        crossTileSymbolIndex.addLayer(bucketA.layers[0], [tileA, tileB], 0);

        const place = (tileToPlace: Tile) => {
            const parts = [];
            placement.getBucketParts(parts, bucketA.layers[0], tileToPlace, false);
            for (const part of parts) {
                placement.placeLayerBucketPart(part, {}, false);
            }
        };

        const before = placement.collisionIndex.grid.keysLength();
        place(tileA);
        const afterFirstPlacement = placement.collisionIndex.grid.keysLength();
        place(tileB);
        const afterSecondPlacement = placement.collisionIndex.grid.keysLength();

        expect(before).toBeLessThan(afterFirstPlacement);
        expect(afterSecondPlacement).toBe(afterFirstPlacement);
    });

    test('SymbolBucket columnar line placement preserves crossTile IDs for real MLT tile updates', () => {
        const tilePath = path.resolve(__dirname, '../../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.transportation;
        const canonical = new OverscaledTileID(14, 0, 14, 8716, 5685).canonical;
        const tileID = new OverscaledTileID(14, 0, 14, 8716, 5685);
        const layerSpec = {
            id: 'transportation-line-crosstile',
            type: 'symbol',
            source: 'source',
            'source-layer': 'transportation',
            filter: [
                'all',
                ['has', 'class'],
                ['any',
                    ['==', ['get', 'class'], 'path'],
                    ['==', ['get', 'class'], 'service']
                ]
            ],
            layout: {
                'symbol-placement': 'line',
                'text-field': ['to-string', ['get', 'class']],
                'text-font': ['Test'],
                'text-size': 14
            }
        } as LayerSpecification;

        const legacyBucket = createRealSymbolBucket(layerSpec, 15.8, 0, 'mvt');
        legacyBucket.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions([]), canonical);
        performRealSymbolLayout(legacyBucket);

        const columnarBucket = createRealSymbolBucket(layerSpec, 15.8, 0, 'mlt');
        columnarBucket.populate((sourceLayer as any).featureTable, createPopulateOptions([]), canonical);
        performRealSymbolLayout(columnarBucket);

        const crossTileSymbolIndex = new CrossTileSymbolIndex();
        const legacyTile = createSymbolTile(tileID, legacyBucket, layerSpec.id);
        const columnarTile = createSymbolTile(tileID, columnarBucket, layerSpec.id);

        crossTileSymbolIndex.addLayer(legacyBucket.layers[0], [legacyTile], 0);
        const legacyCrossTileIDs = Array.from({length: legacyBucket.symbolInstances.length}, (_, i) => legacyBucket.symbolInstances.get(i).crossTileID);

        crossTileSymbolIndex.addLayer(columnarBucket.layers[0], [columnarTile], 0);
        const columnarCrossTileIDs = Array.from({length: columnarBucket.symbolInstances.length}, (_, i) => columnarBucket.symbolInstances.get(i).crossTileID);

        expect(columnarCrossTileIDs).toEqual(legacyCrossTileIDs);
    }, 60000);

    test('SymbolBucket columnar variable anchors match legacy placement decisions on real MLT tiles', () => {
        const tilePath = path.resolve(__dirname, '../../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.place;
        const canonical = new OverscaledTileID(14, 0, 14, 8716, 5685).canonical;
        const tileID = new OverscaledTileID(14, 0, 14, 8716, 5685);
        const layerSpec = {
            id: 'place-variable-anchor',
            type: 'symbol',
            source: 'source',
            'source-layer': 'place',
            filter: [
                'all',
                ['has', 'rank'],
                ['any',
                    ['==', ['get', 'class'], 'suburb'],
                    ['==', ['get', 'class'], 'neighbourhood']
                ],
                ['!', ['==', ['get', 'name'], 'Nymphenburg']]
            ],
            layout: {
                'text-field': ['get', 'name'],
                'text-font': ['Test'],
                'text-size': 13,
                'text-variable-anchor': ['center', 'left', 'right', 'top', 'bottom'],
                'text-radial-offset': 0.75
            }
        } as LayerSpecification;

        const legacyBucket = createRealSymbolBucket(layerSpec, 14.92, 0, 'mvt');
        legacyBucket.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions([]), canonical);
        performRealSymbolLayout(legacyBucket);

        const columnarBucket = createRealSymbolBucket(layerSpec, 14.92, 0, 'mlt');
        columnarBucket.populate((sourceLayer as any).featureTable, createPopulateOptions([]), canonical);
        performRealSymbolLayout(columnarBucket);

        const legacyTile = createSymbolTile(tileID, legacyBucket, layerSpec.id);
        const columnarTile = createSymbolTile(tileID, columnarBucket, layerSpec.id);
        const legacyCrossTileIndex = new CrossTileSymbolIndex();
        const columnarCrossTileIndex = new CrossTileSymbolIndex();

        legacyCrossTileIndex.addLayer(legacyBucket.layers[0], [legacyTile], 0);
        columnarCrossTileIndex.addLayer(columnarBucket.layers[0], [columnarTile], 0);

        const legacyPlacement = new Placement(transform, undefined, 0, true);
        const columnarPlacement = new Placement(transform, undefined, 0, true);

        placeSymbolTile(legacyPlacement, legacyBucket.layers[0], legacyTile);
        placeSymbolTile(columnarPlacement, columnarBucket.layers[0], columnarTile);

        const summarizePlacement = (placement: Placement) =>
            Object.entries(placement.variableOffsets)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([crossTileID, offset]) => ({
                    crossTileID: Number(crossTileID),
                    anchor: offset.anchor,
                    textPlaced: placement.placements[crossTileID]?.text ?? false
                }));

        expect(summarizePlacement(columnarPlacement)).toEqual(summarizePlacement(legacyPlacement));
    });

    test('SymbolBucket columnar variable anchor offsets match legacy placement decisions on real MLT tiles', () => {
        const tilePath = path.resolve(__dirname, '../../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.place;
        const canonical = new OverscaledTileID(14, 0, 14, 8716, 5685).canonical;
        const tileID = new OverscaledTileID(14, 0, 14, 8716, 5685);
        const layerSpec = {
            id: 'place-variable-anchor-offset',
            type: 'symbol',
            source: 'source',
            'source-layer': 'place',
            filter: [
                'all',
                ['has', 'rank'],
                ['any',
                    ['==', ['get', 'class'], 'suburb'],
                    ['==', ['get', 'class'], 'neighbourhood']
                ],
                ['!', ['==', ['get', 'name'], 'Nymphenburg']]
            ],
            layout: {
                'text-field': ['get', 'name'],
                'text-font': ['Test'],
                'text-size': 13,
                'text-variable-anchor-offset': [
                    'top', [0, 0.3],
                    'bottom', [0, -0.3],
                    'left', [0.8, 0],
                    'right', [-0.8, 0]
                ]
            }
        } as LayerSpecification;

        const legacyBucket = createRealSymbolBucket(layerSpec, 14.92, 0, 'mvt');
        legacyBucket.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions([]), canonical);
        performRealSymbolLayout(legacyBucket);

        const columnarBucket = createRealSymbolBucket(layerSpec, 14.92, 0, 'mlt');
        columnarBucket.populate((sourceLayer as any).featureTable, createPopulateOptions([]), canonical);
        performRealSymbolLayout(columnarBucket);

        const legacyTile = createSymbolTile(tileID, legacyBucket, layerSpec.id);
        const columnarTile = createSymbolTile(tileID, columnarBucket, layerSpec.id);
        const legacyCrossTileIndex = new CrossTileSymbolIndex();
        const columnarCrossTileIndex = new CrossTileSymbolIndex();

        legacyCrossTileIndex.addLayer(legacyBucket.layers[0], [legacyTile], 0);
        columnarCrossTileIndex.addLayer(columnarBucket.layers[0], [columnarTile], 0);

        const legacyPlacement = new Placement(transform, undefined, 0, true);
        const columnarPlacement = new Placement(transform, undefined, 0, true);

        placeSymbolTile(legacyPlacement, legacyBucket.layers[0], legacyTile);
        placeSymbolTile(columnarPlacement, columnarBucket.layers[0], columnarTile);

        const summarizePlacement = (placement: Placement) =>
            Object.entries(placement.variableOffsets)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([crossTileID, offset]) => ({
                    crossTileID: Number(crossTileID),
                    anchor: offset.anchor,
                    offsetX: offset.textOffset[0],
                    offsetY: offset.textOffset[1],
                    textPlaced: placement.placements[crossTileID]?.text ?? false
                }));

        expect(summarizePlacement(columnarPlacement)).toEqual(summarizePlacement(legacyPlacement));
    });

    test('SymbolBucket columnar point icon placement matches legacy visibility decisions across adjacent tiles', () => {
        const tileSpecs = [
            {tileID: new OverscaledTileID(14, 0, 14, 8802, 5374), name: '14-8802-5374'},
            {tileID: new OverscaledTileID(14, 0, 14, 8802, 5375), name: '14-8802-5375'},
            {tileID: new OverscaledTileID(14, 0, 14, 8803, 5374), name: '14-8803-5374'},
            {tileID: new OverscaledTileID(14, 0, 14, 8803, 5375), name: '14-8803-5375'}
        ] as const;

        const layerSpec = {
            id: 'poi-restaurants-point',
            type: 'symbol',
            source: 'source',
            'source-layer': 'poi_label',
            filter: ['==', 'maki', 'restaurant'],
            layout: {
                'icon-image': '{maki}-12',
                'symbol-placement': 'point'
            }
        } as LayerSpecification;

        const legacyBuckets = [];
        const columnarBuckets = [];
        const legacyTiles = [];
        const columnarTiles = [];

        for (const {tileID, name} of tileSpecs) {
            const canonical = tileID.canonical;
            const mvtPath = path.resolve(__dirname, `../../../test/integration/assets/tiles/${name}.mvt`);
            const mltPath = path.resolve(__dirname, `../../../test/integration/assets/tiles/mlt/gl-js/${name}.mlt`);

            const mvtTile = loadVectorTileFromPath(mvtPath);
            const mltTile = loadMltTile(mltPath);

            const legacyBucket = createRealSymbolBucket(layerSpec, 14.92, 0, 'mvt');
            legacyBucket.populate(getFeaturesFromLayer(mvtTile.layers.poi_label), createPopulateOptions(['restaurant-12']), canonical);
            performRealSymbolLayout(legacyBucket, ['restaurant-12'], {'restaurant-12': {width: 22, height: 22}});
            legacyBuckets.push({tileID, bucket: legacyBucket});
            legacyTiles.push(createSymbolTile(tileID, legacyBucket, layerSpec.id));

            const columnarBucket = createRealSymbolBucket(layerSpec, 14.92, 0, 'mlt');
            columnarBucket.populate((mltTile.layers.poi_label as any).featureTable, createPopulateOptions(['restaurant-12']), canonical);
            performRealSymbolLayout(columnarBucket, ['restaurant-12'], {'restaurant-12': {width: 22, height: 22}});
            columnarBuckets.push({tileID, bucket: columnarBucket});
            columnarTiles.push(createSymbolTile(tileID, columnarBucket, layerSpec.id));
        }

        const legacyCrossTileIndex = new CrossTileSymbolIndex();
        legacyCrossTileIndex.addLayer(legacyBuckets[0].bucket.layers[0], legacyTiles, 0);
        const columnarCrossTileIndex = new CrossTileSymbolIndex();
        columnarCrossTileIndex.addLayer(columnarBuckets[0].bucket.layers[0], columnarTiles, 0);

        const renderTransform = new MercatorTransform();
        renderTransform.resize(256, 256);
        renderTransform.setZoom(14);
        renderTransform.setCenter(new LngLat(13.418056, 52.499167));

        const legacyPlacement = new Placement(renderTransform, undefined, 0, true);
        for (const tile of legacyTiles) {
            placeSymbolTile(legacyPlacement, legacyBuckets[0].bucket.layers[0], tile);
        }

        const columnarPlacement = new Placement(renderTransform, undefined, 0, true);
        for (const tile of columnarTiles) {
            placeSymbolTile(columnarPlacement, columnarBuckets[0].bucket.layers[0], tile);
        }

        const legacyVisible = legacyBuckets.flatMap(({tileID, bucket}) => summarizeVisibleIcons(tileID, bucket, legacyPlacement));
        const columnarVisible = columnarBuckets.flatMap(({tileID, bucket}) => summarizeVisibleIcons(tileID, bucket, columnarPlacement));

        expect(columnarVisible).toEqual(legacyVisible);
    });

    test('SymbolBucket columnar point-on-polygon placement matches original MVT on converted gl-js building tile', () => {
        const tileID = new OverscaledTileID(14, 0, 14, 9579, 5520);
        const canonical = tileID.canonical;
        const mvtPath = path.resolve(__dirname, '../../../test/integration/assets/tiles/14-9579-5520.mvt');
        const mltPath = path.resolve(__dirname, '../../../test/integration/assets/tiles/mlt/gl-js/14-9579-5520.mlt');
        const mvtTile = loadVectorTileFromPath(mvtPath);
        const mltTile = loadMltTile(mltPath);
        const layerSpec = {
            id: 'building-pole-of-inaccessibility',
            type: 'symbol',
            source: 'source',
            'source-layer': 'building',
            layout: {
                'text-field': 'Test',
                'text-font': ['Test'],
                'text-size': 10
            }
        } as LayerSpecification;

        const legacyBucket = createRealSymbolBucket(layerSpec, 18, 0, 'mvt');
        legacyBucket.populate(getFeaturesFromLayer(mvtTile.layers.building), createPopulateOptions([]), canonical);

        const columnarBucket = createRealSymbolBucket(layerSpec, 18, 0, 'mlt');
        columnarBucket.populate((mltTile.layers.building as any).featureTable, createPopulateOptions([]), canonical);

        expect(summarizeSymbolFeatures(columnarBucket)).toEqual(summarizeSymbolFeatures(legacyBucket));

        performRealSymbolLayout(legacyBucket);
        performRealSymbolLayout(columnarBucket);
        expect(columnarBucket.features.every(feature => feature.geometry.length === 0)).toBe(true);

        const legacyTile = createSymbolTile(tileID, legacyBucket, layerSpec.id);
        const columnarTile = createSymbolTile(tileID, columnarBucket, layerSpec.id);
        const legacyCrossTileIndex = new CrossTileSymbolIndex();
        const columnarCrossTileIndex = new CrossTileSymbolIndex();

        legacyCrossTileIndex.addLayer(legacyBucket.layers[0], [legacyTile], 0);
        columnarCrossTileIndex.addLayer(columnarBucket.layers[0], [columnarTile], 0);

        const legacyPlacement = new Placement(transform, undefined, 0, true);
        const columnarPlacement = new Placement(transform, undefined, 0, true);

        placeSymbolTile(legacyPlacement, legacyBucket.layers[0], legacyTile);
        placeSymbolTile(columnarPlacement, columnarBucket.layers[0], columnarTile);

        expect(summarizeVisibleText(tileID, columnarBucket, columnarPlacement))
            .toEqual(summarizeVisibleText(tileID, legacyBucket, legacyPlacement));
    });

    test('SymbolBucket asks for one glyph per character of plain text and nothing besides', () => {
        expect(glyphsRequestedFor('abc').sort()).toEqual(['a', 'b', 'c']);
    });

    test('SymbolBucket asks for a cluster as a whole, and for its codepoints to fall back to', () => {
        const hebrew = glyphsRequestedFor('שְׁ');
        expect(hebrew).toContain('שְׁ');
        expect(hebrew).toEqual(expect.arrayContaining(['ש', 'ְ', 'ׁ']));

        const devanagari = glyphsRequestedFor('दि');
        expect(devanagari).toContain('दि');
        expect(devanagari).toEqual(expect.arrayContaining(['द', 'ि']));
    });
});

describe('SymbolBucket.addFeatures cross-tile key', () => {
    const symbolLayer = createSymbolStyleLayer('test', 'Test', 'abcde');
    const promoteId = 'name';
    const parentTileID = new OverscaledTileID(6, 0, 6, 8, 8);
    const northWestChildTileID = new OverscaledTileID(7, 0, 7, 16, 16);
    const anchorInParentTile = {x: 1000, y: 1000};
    const sameSpotInNorthWestChildTile = {x: anchorInParentTile.x * 2, y: anchorInParentTile.y * 2};

    type Label = {id: number | string; anchor: {x: number; y: number}; properties: Record<string, unknown>};

    /**
     * Lays out one point label per entry, in order, with the feature id the worker would have resolved through
     * `featureIndex`.
     */
    function createTileWithLabels(featureIndex: FeatureIndex, labels: Label[]): Tile {
        const features = labels.map(({id, anchor, properties}, index) => ({
            feature: {extent: 8192, type: 1, id, properties, loadGeometry: () => [[anchor]]},
            id,
            index,
            sourceLayerIndex: 0
        }) as any as IndexedFeature);
        const bucket = new SymbolBucket({overscaling: 1, zoom: 0, collisionBoxArray, layers: [symbolLayer]} as BucketParameters<SymbolStyleLayer>);
        const options = {...createPopulateOptions([]), featureIndex};
        bucket.populate(features, options, featureIndex.tileID.canonical);
        bucket.addFeatures({
            options,
            canonical: featureIndex.tileID.canonical,
            glyphMap: glyphsByCluster,
            glyphPositions: {},
            iconMap: {},
            iconPositions: {},
            patternMap: {},
            patternPositions: {},
            dashPositions: {},
            showCollisionBoxes: false
        });
        const tile = new Tile(featureIndex.tileID, 512);
        tile.buckets = {[symbolLayer.id]: bucket};
        return tile;
    }

    function crossTileIDOfLabel(tile: Tile, featureId: number | string): number {
        const bucket = tile.getBucket(symbolLayer) as SymbolBucket;
        for (let i = 0; i < bucket.symbolInstances.length; i++) {
            const symbolInstance = bucket.symbolInstances.get(i);
            if (bucket.features[symbolInstance.featureIndex].id === featureId) {
                return symbolInstance.crossTileID;
            }
        }
        throw new Error(`No label for feature ${featureId}`);
    }

    test('with promoteId, a label matches the same feature\'s label in the parent tile, not another feature\'s label laid out first at the same spot', () => {
        const parentTile = createTileWithLabels(new FeatureIndex(parentTileID, promoteId), [
            {id: 'a', anchor: anchorInParentTile, properties: {}}
        ]);
        const childTile = createTileWithLabels(new FeatureIndex(northWestChildTileID, promoteId), [
            {id: 'b', anchor: sameSpotInNorthWestChildTile, properties: {}},
            {id: 'a', anchor: sameSpotInNorthWestChildTile, properties: {}}
        ]);

        new CrossTileSymbolIndex().addLayer(symbolLayer, [parentTile, childTile], 0);

        expect(crossTileIDOfLabel(childTile, 'a')).toBe(crossTileIDOfLabel(parentTile, 'a'));
        expect(crossTileIDOfLabel(childTile, 'b')).not.toBe(crossTileIDOfLabel(parentTile, 'a'));
    });

    test('without promoteId, a label matches the label at the same spot in the parent tile whatever the two feature ids are', () => {
        const parentTile = createTileWithLabels(new FeatureIndex(parentTileID), [
            {id: 1, anchor: anchorInParentTile, properties: {}}
        ]);
        const childTile = createTileWithLabels(new FeatureIndex(northWestChildTileID), [
            {id: 2, anchor: sameSpotInNorthWestChildTile, properties: {}}
        ]);

        new CrossTileSymbolIndex().addLayer(symbolLayer, [parentTile, childTile], 0);

        expect(crossTileIDOfLabel(childTile, 2)).toBe(crossTileIDOfLabel(parentTile, 1));
    });

    test('with promoteId, a cluster label matches the cluster label at the same spot in the parent tile although a cluster has a different id at every zoom', () => {
        const parentTile = createTileWithLabels(new FeatureIndex(parentTileID, promoteId), [
            {id: 100, anchor: anchorInParentTile, properties: {cluster: true, cluster_id: 100}}
        ]);
        const childTile = createTileWithLabels(new FeatureIndex(northWestChildTileID, promoteId), [
            {id: 200, anchor: sameSpotInNorthWestChildTile, properties: {cluster: true, cluster_id: 200}}
        ]);

        new CrossTileSymbolIndex().addLayer(symbolLayer, [parentTile, childTile], 0);

        expect(crossTileIDOfLabel(childTile, 200)).toBe(crossTileIDOfLabel(parentTile, 100));
    });
});
