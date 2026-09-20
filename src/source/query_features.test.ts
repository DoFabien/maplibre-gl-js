import {describe, test, expect, vi} from 'vitest';
import {
    flattenAndSortRenderedFeatures,
    queryRenderedFeatures,
    querySourceFeatures,
    type QueryProfile,
} from './query_features.ts';
import {TileManager} from '../tile/tile_manager.ts';
import {MercatorTransform} from '../geo/projection/mercator_transform.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';

import type Point from '@mapbox/point-geometry';

describe('QueryFeatures.rendered', () => {
    test('returns empty object if source returns no tiles', () => {
        const mockTileManager = {tilesIn () { return []; }} as any as TileManager;
        const transform = new MercatorTransform();
        const result = queryRenderedFeatures(mockTileManager, {}, undefined, [] as Point[], undefined, transform, undefined);
        expect(result).toEqual({});
    });

    test('preserves multi-tile order and wrapped deduplication with independent state outputs', () => {
        const transform = new MercatorTransform();
        transform.resize(512, 512);
        const firstTileID = new OverscaledTileID(1, 0, 1, 0, 0);
        const duplicateTileID = new OverscaledTileID(1, 0, 1, 0, 0);
        const distinctTileID = new OverscaledTileID(1, 0, 1, 1, 0);
        const item = (featureIndex: number, id: number, layerID = 'layer-a') => ({
            featureIndex,
            feature: {
                type: 'Feature',
                id,
                properties: {},
                layer: {
                    id: layerID,
                    source: 'source',
                    'source-layer': 'roads',
                    type: 'circle',
                    paint: {},
                    layout: {},
                },
            },
        });
        const tiles = [
            {
                tileID: firstTileID,
                queryResults: {
                    'layer-a': [item(2, 2), item(1, 1)],
                    'layer-b': [item(1, 11, 'layer-b')],
                },
            },
            {
                tileID: duplicateTileID,
                queryResults: {'layer-a': [item(1, 101), item(3, 3)]},
            },
            {
                tileID: distinctTileID,
                queryResults: {'layer-a': [item(1, 201)]},
            },
        ];
        const emptyState = {state: {}, stateChanges: {}, deletedStates: {}};
        const getFeatureState = vi.fn(() => ({unexpected: true}));
        const tileManager = {
            id: 'source',
            tilesIn: () => tiles.map(({tileID, queryResults}) => ({
                tileID,
                tile: {queryRenderedFeatures: () => queryResults},
                queryGeometry: [],
                cameraQueryGeometry: [],
                scale: 1,
            })),
            getState: () => emptyState,
            getFeatureState,
        } as any as TileManager;

        const profile: QueryProfile = {records: []};
        const result = queryRenderedFeatures(tileManager, {}, {}, [], undefined, transform, undefined, profile);
        const flattened = flattenAndSortRenderedFeatures(
            [result],
            {
                'layer-a': {type: 'circle'},
                'layer-b': {type: 'circle'},
            } as any,
            ['layer-b', 'layer-a'],
            profile,
        );

        expect(result['layer-a'].map(({feature}) => feature.id)).toEqual([2, 1, 3, 201]);
        expect(result['layer-b'].map(({feature}) => feature.id)).toEqual([11]);
        expect(getFeatureState).not.toHaveBeenCalled();
        expect(result['layer-a'][0].feature.source).toBe('source');
        expect(result['layer-a'][0].feature.sourceLayer).toBe('roads');
        expect(result['layer-a'][0].feature.state).toEqual({});
        expect(result['layer-a'][0].feature.state).not.toBe(result['layer-a'][1].feature.state);
        result['layer-a'][0].feature.state.selected = true;
        expect(result['layer-a'][1].feature.state).toEqual({});
        expect(flattened.map(feature => feature.id)).toEqual([2, 1, 3, 201, 11]);
        expect(profile.records.map(record => record.phase)).toEqual([
            'query.tilesIn',
            'query.sortTiles',
            'query.collectTile',
            'query.mergeDeduplicate',
            'query.collectTile',
            'query.mergeDeduplicate',
            'query.collectTile',
            'query.mergeDeduplicate',
            'query.enrich',
            'query.flattenSort',
        ]);
        expect(profile.records.every(record => record.kind === 'exclusive' && record.duration >= 0)).toBe(true);
        expect(profile.records.filter(record => record.phase === 'query.mergeDeduplicate').map(record => record.outputCount))
            .toEqual([3, 1, 1]);
        expect(profile.records.at(-1)).toMatchObject({inputCount: 5, outputCount: 5});
    });

    test('keeps feature-state lookups when a source has state', () => {
        const transform = new MercatorTransform();
        transform.resize(512, 512);
        const tileID = new OverscaledTileID(1, 0, 1, 0, 0);
        const feature = {
            type: 'Feature',
            id: 7,
            properties: {},
            layer: {id: 'layer', source: 'source', 'source-layer': 'roads', type: 'circle', paint: {}, layout: {}},
        };
        const getFeatureState = vi.fn(() => ({selected: true}));
        const tileManager = {
            id: 'source',
            tilesIn: () => [{
                tileID,
                tile: {queryRenderedFeatures: () => ({layer: [{featureIndex: 7, feature}]})},
                queryGeometry: [],
                cameraQueryGeometry: [],
                scale: 1,
            }],
            getState: () => ({state: {roads: {'7': {selected: true}}}, stateChanges: {}, deletedStates: {}}),
            getFeatureState,
        } as any as TileManager;

        const result = queryRenderedFeatures(tileManager, {}, {}, [], undefined, transform, undefined);

        expect(result.layer[0].feature.state).toEqual({selected: true});
        expect(getFeatureState).toHaveBeenCalledTimes(1);
    });

});

describe('QueryFeatures.source', () => {
    test('returns empty result when source has no features', () => {
        const tileManager = new TileManager('test', {
            type: 'geojson',
            data: {type: 'FeatureCollection', features: []}
        }, {
            getActor() {}
        } as any);
        const result = querySourceFeatures(tileManager, {});
        expect(result).toEqual([]);
    });

    test('queries each canonical data tile once while preserving renderable order', () => {
        const firstTileID = new OverscaledTileID(1, 0, 1, 0, 0);
        const wrappedDuplicateID = new OverscaledTileID(1, 1, 1, 0, 0);
        const distinctTileID = new OverscaledTileID(1, 0, 1, 1, 0);
        const firstQuery = vi.fn((result) => result.push({id: 'first'}));
        const duplicateQuery = vi.fn((result) => result.push({id: 'duplicate'}));
        const distinctQuery = vi.fn((result) => result.push({id: 'distinct'}));
        const tiles = {
            first: {tileID: firstTileID, querySourceFeatures: firstQuery},
            duplicate: {tileID: wrappedDuplicateID, querySourceFeatures: duplicateQuery},
            distinct: {tileID: distinctTileID, querySourceFeatures: distinctQuery},
        };
        const tileManager = {
            getRenderableIds: () => ['first', 'duplicate', 'distinct'],
            getTileByID: (id: keyof typeof tiles) => tiles[id],
        } as any as TileManager;

        const profile: QueryProfile = {records: []};
        const result = querySourceFeatures(tileManager, {}, profile);

        expect(result.map((feature: any) => feature.id)).toEqual(['first', 'distinct']);
        expect(firstQuery).toHaveBeenCalledTimes(1);
        expect(duplicateQuery).not.toHaveBeenCalled();
        expect(distinctQuery).toHaveBeenCalledTimes(1);
        expect(profile.records.map(record => [record.phase, record.outputCount])).toEqual([
            ['query.sourceDeduplicate', 1],
            ['query.sourceCollectTile', 1],
            ['query.sourceDeduplicate', 0],
            ['query.sourceDeduplicate', 1],
            ['query.sourceCollectTile', 1],
        ]);
        expect(profile.records.every(record => record.kind === 'exclusive' && record.duration >= 0)).toBe(true);
    });

});
