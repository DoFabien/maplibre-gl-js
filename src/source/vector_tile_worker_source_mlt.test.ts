import {describe, beforeEach, afterEach, test, expect} from 'vitest';
import {fakeServer, type FakeServer} from 'nise';
import {encodeTile} from '@maplibre/mlt';
import {createMltDecodeOptions, VectorTileWorkerSource} from './vector_tile_worker_source.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';
import {OverscaledTileID, CanonicalTileID} from '../tile/tile_id.ts';

import type {WorkerTileParameters, WorkerTileWithData} from './worker_source.ts';
import type {IActor} from '../util/actor.ts';

describe('vector tile worker source with MLT tiles', () => {
    const actor = {sendAsync: () => Promise.resolve({})} as IActor;
    let server: FakeServer;

    beforeEach(() => {
        global.fetch = null;
        server = fakeServer.create();
    });

    afterEach(() => {
        server.restore();
    });

    test('decodes the MLT layers and property columns that the style reads', () => {
        const layerIndex = new StyleLayerIndex([
            {
                id: 'roads', source: 'source', 'source-layer': 'road', type: 'line',
                filter: ['==', ['get', 'class'], 'street'],
                paint: {
                    'line-color': {property: 'surface', type: 'categorical', stops: [['paved', 'red']]},
                    'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#000000', 1, '#ffffff'],
                },
            },
            {
                id: 'pois', source: 'source', 'source-layer': 'poi', type: 'symbol',
                filter: ['all', ['==', 'maki', 'restaurant'], ['any', ['has', 'name'], ['==', '$type', 'Point']]],
                layout: {'text-field': ['get', 'name']},
            },
            {
                id: 'labels', source: 'source', 'source-layer': 'label', type: 'symbol',
                layout: {'text-field': ['get', ['concat', 'name_', 'en']]},
            },
        ] as any);

        const options = createMltDecodeOptions({source: 'source', promoteId: {road: 'fid'}} as any as WorkerTileParameters, layerIndex);

        expect([...options.layerNames].sort()).toEqual(['label', 'poi', 'road']);
        expect([...options.propertyColumnNamesByLayer.get('road')].sort()).toEqual(['class', 'fid', 'geojsonvt_clip_end', 'geojsonvt_clip_start', 'surface']);
        expect([...options.propertyColumnNamesByLayer.get('poi')].sort()).toEqual(['maki', 'name']);
        expect(options.propertyColumnNamesByLayer.has('label')).toBe(false);
    });

    test('keeps the properties the style does not read in overzoomed MLT tiles', async () => {
        const rawData = encodeTile([{name: 'roads', features: [{
            id: 42, geometry: {type: 'LineString', coordinates: [[1800, 10], [2300, 10]]}, properties: {width: 2, 'public-only': 73},
        }]}]).buffer as ArrayBuffer;
        const source = new VectorTileWorkerSource(actor, new StyleLayerIndex([{
            id: 'line', source: 'source', 'source-layer': 'roads', type: 'line', paint: {'line-width': ['get', 'width']}
        }]), []);
        server.respondWith(request => {
            request.respond(200, {'Content-Type': 'application/octet-stream'}, rawData as any);
        });

        const pending = source.loadTile({
            uid: 'overzoomed', source: 'source', encoding: 'mlt', zoom: 15, tileSize: 512, pixelRatio: 1,
            tileID: new OverscaledTileID(15, 0, 15, 0, 0),
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
            request: {url: 'http://localhost/roads.mlt'},
            overzoomParameters: {maxZoomTileID: new CanonicalTileID(14, 0, 0), overzoomRequest: {url: 'http://localhost/roads.mlt'}},
        } as WorkerTileParameters);
        server.respond();
        const result = await pending as WorkerTileWithData;
        result.featureIndex.rawTileData = result.rawTileData;
        result.featureIndex.encoding = result.encoding;

        expect(result.featureIndex.loadVTLayers().roads.feature(0).properties).toEqual({width: 2, 'public-only': 73});
    });

});
