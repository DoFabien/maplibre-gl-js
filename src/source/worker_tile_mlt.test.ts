import {describe, expect, test} from 'vitest';
import fs from 'fs';
import {createHash} from 'crypto';
import path from 'path';
import {PbfReader} from 'pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {WorkerTile} from './worker_tile.ts';
import {MLTVectorTile} from './vector_tile_mlt.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';
import {StructArray} from '../util/struct_array.ts';

import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {VectorTileLike} from '@maplibre/vt-pbf';
import type {Bucket} from '../data/bucket.ts';
import type {WorkerTileParameters, WorkerTileWithData} from './worker_source.ts';

const tiles = path.join(__dirname, '../../test/integration/assets/tiles');

/** Layers of the Mapbox Streets tiles of gl-js, with filters on the columns and filters evaluated row by row. */
const glJsLayerIndex = new StyleLayerIndex(([
    {id: 'landuse', type: 'fill', 'source-layer': 'landuse', filter: ['in', 'class', 'park', 'grass', 'wood'],
        paint: {'fill-color': ['match', ['get', 'class'], 'park', '#00ff00', '#006600']}},
    {id: 'water', type: 'fill', 'source-layer': 'water'},
    {id: 'building', type: 'fill-extrusion', 'source-layer': 'building', paint: {'fill-extrusion-height': 10}},
    {id: 'building-outline', type: 'line', 'source-layer': 'building'},
    {id: 'roads', type: 'line', 'source-layer': 'road', filter: ['!=', ['get', 'class'], 'path'],
        layout: {'line-join': 'round'},
        paint: {
            'line-color': {property: 'class', type: 'categorical', stops: [['street', 'blue'], ['main', 'purple']]},
            'line-width': ['match', ['get', 'class'], ['main', 'street'], 4, 1],
        }},
    {id: 'tunnels', type: 'line', 'source-layer': 'tunnel', filter: ['>', ['length', ['to-string', ['get', 'class']]], 4]},
    {id: 'pois', type: 'circle', 'source-layer': 'poi_label', filter: ['has', 'maki'],
        paint: {'circle-radius': ['case', ['==', ['get', 'maki'], 'restaurant'], 4, 2]}},
] as LayerSpecification[]).map(layer => ({...layer, source: 'source'})));

/** Layers of an OpenMapTiles tile, whose string columns are dictionaries and FSST dictionaries. */
const omtLayerIndex = new StyleLayerIndex(([
    {id: 'landcover', type: 'fill', 'source-layer': 'landcover', paint: {'fill-color': ['match', ['get', 'class'], 'wood', '#006600', '#99cc66']}},
    {id: 'water', type: 'fill', 'source-layer': 'water'},
    {id: 'roads', type: 'line', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'minor']]],
        layout: {'line-sort-key': ['match', ['get', 'class'], 'primary', 3, 'secondary', 2, 1]},
        paint: {'line-width': ['match', ['get', 'class'], 'primary', 6, 2]}},
    {id: 'pois', type: 'circle', 'source-layer': 'poi', filter: ['<=', ['get', 'rank'], 5], paint: {'circle-radius': ['get', 'rank']}},
] as LayerSpecification[]).map(layer => ({...layer, source: 'source'})));

function loadMlt(file: string): MLTVectorTile {
    const bytes = fs.readFileSync(path.join(tiles, file));
    return new MLTVectorTile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function loadMvt(file: string): VectorTile {
    return new VectorTile(new PbfReader(fs.readFileSync(path.join(tiles, file))));
}

async function parse(data: VectorTileLike, encoding: 'mvt' | 'mlt', tileID: OverscaledTileID, layerIndex: StyleLayerIndex): Promise<WorkerTileWithData> {
    const workerTile = new WorkerTile({
        tileID, uid: encoding, source: 'source', zoom: tileID.overscaledZ, tileSize: 512, pixelRatio: 1, encoding,
    } as WorkerTileParameters);
    return await workerTile.parse(data, layerIndex, [], {sendAsync: async () => ({})}, SubdivisionGranularitySetting.noSubdivision) as WorkerTileWithData;
}

/** A digest of the elements of a struct array, which compares large arrays faster than their bytes. */
function digest(array: StructArray): string {
    return createHash('sha1').update(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement)).digest('hex');
}

/** The vertex, index and paint arrays and the segments a bucket hands to the main thread. */
function bucketArrays(bucket: Bucket): Record<string, unknown> {
    const arrays: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(bucket)) {
        if (value instanceof StructArray) arrays[key] = digest(value);
    }
    arrays.segments = (bucket as {segments?: {get(): unknown}}).segments?.get();
    const configurations = (bucket as {programConfigurations?: {programConfigurations: Record<string, {binders: Record<string, {paintVertexArray?: StructArray}>}>}}).programConfigurations;
    for (const [layerId, configuration] of Object.entries(configurations?.programConfigurations ?? {})) {
        for (const [property, binder] of Object.entries(configuration.binders)) {
            if (binder.paintVertexArray) arrays[`${layerId}.${property}`] = digest(binder.paintVertexArray);
        }
    }
    return arrays;
}

describe('WorkerTile with real MLT tiles', () => {
    test.each([
        {label: 'gl-js 14/8802/5374', mlt: 'mlt/gl-js/14-8802-5374.mlt', mvt: '14-8802-5374.mvt', tileID: new OverscaledTileID(14, 0, 14, 8802, 5374), layerIndex: glJsLayerIndex},
        {label: 'gl-js 14/8802/5375', mlt: 'mlt/gl-js/14-8802-5375.mlt', mvt: '14-8802-5375.mvt', tileID: new OverscaledTileID(14, 0, 14, 8802, 5375), layerIndex: glJsLayerIndex},
        {label: 'gl-js 14/8803/5374', mlt: 'mlt/gl-js/14-8803-5374.mlt', mvt: '14-8803-5374.mvt', tileID: new OverscaledTileID(14, 0, 14, 8803, 5374), layerIndex: glJsLayerIndex},
        {label: 'gl-js 14/8803/5375', mlt: 'mlt/gl-js/14-8803-5375.mlt', mvt: '14-8803-5375.mvt', tileID: new OverscaledTileID(14, 0, 14, 8803, 5375), layerIndex: glJsLayerIndex},
        {label: 'OpenMapTiles 14/8299/5635', mlt: 'mlt/omt/14/8299/5635.mlt', mvt: 'omt/14/8299/5635.mvt', tileID: new OverscaledTileID(14, 0, 14, 8299, 5635), layerIndex: omtLayerIndex},
    ])('builds the buckets of $label as from the MVT tile', async ({mlt, mvt, tileID, layerIndex}) => {
        const mvtResult = await parse(loadMvt(mvt), 'mvt', tileID, layerIndex);
        const mltResult = await parse(loadMlt(mlt), 'mlt', tileID, layerIndex);

        expect(mvtResult.buckets.length).toBeGreaterThanOrEqual(4);
        expect(mltResult.buckets.map(bucket => bucket.layerIds)).toEqual(mvtResult.buckets.map(bucket => bucket.layerIds));
        for (let i = 0; i < mvtResult.buckets.length; i++) {
            expect(bucketArrays(mltResult.buckets[i])).toEqual(bucketArrays(mvtResult.buckets[i]));
        }
        expect(digest(mltResult.featureIndex.featureIndexArray)).toBe(digest(mvtResult.featureIndex.featureIndexArray));
    }, 30000);
});
