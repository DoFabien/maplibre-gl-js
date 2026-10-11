import {describe, expect, test, vi} from 'vitest';
import {createSyntheticMltTile, syntheticPolygonLayer} from '../../../../test/unit/lib/mlt_synthetic.ts';
import {getMltFeatureTable} from '../../../source/vector_tile_mlt.ts';
import {loadGeometry} from '../../load_geometry.ts';
import {loadFeatureGeometry} from './geometry_traversal.ts';
import {GEOMETRY_TYPE, type FeatureTable} from '@maplibre/mlt';

describe('loadFeatureGeometry', () => {
    test('matches the geometry of the vector tile feature', () => {
        const layer = createSyntheticMltTile().layers[syntheticPolygonLayer];
        const featureTable = getMltFeatureTable(layer);
        expect(loadFeatureGeometry(featureTable, 0)).toEqual(loadGeometry(layer.feature(0)).map(part => part.map(point => point.div(8192 / featureTable.extent))));
    });

    test('loads vertex-offset geometry', () => {
        const geometryVector = {
            numGeometries: 1,
            geometryType: () => GEOMETRY_TYPE.LINESTRING,
            topologyVector: {partOffsets: new Uint32Array([0, 2])},
            vertexOffsets: new Uint32Array([1, 0]),
            vertexBuffer: new Int32Array([10, 20, 30, 40]),
        };
        const featureTable = {name: 'offset-line', extent: 4096, geometryVector} as unknown as FeatureTable;

        expect(loadFeatureGeometry(featureTable, 0).map((part) => part.map(({x, y}) => [x, y])))
            .toEqual([[[30, 40], [10, 20]]]);
    });

    test('decodes each Morton vertex exactly once when loading geometry', () => {
        const getVertex = vi.fn((index: number): [number, number] => [10 + index, 20 + index]);
        const geometryVector = {
            numGeometries: 1,
            geometryType: () => GEOMETRY_TYPE.LINESTRING,
            containsPolygonGeometry: () => false,
            topologyVector: {partOffsets: new Uint32Array([0, 2])},
            vertexBuffer: new Uint32Array(),
            mortonSettings: {numBits: 4, coordinateShift: 0},
            getVertex,
        };
        const featureTable = {
            name: 'morton-line',
            extent: 4096,
            geometryVector,
        } as unknown as FeatureTable;

        expect(loadFeatureGeometry(featureTable, 0).map((part) => part.map(({x, y}) => [x, y])))
            .toEqual([[[10, 20], [11, 21]]]);
        expect(getVertex).toHaveBeenCalledTimes(2);

        getVertex.mockClear();
        expect(loadFeatureGeometry(featureTable, 0, 2).map((part) => part.map(({x, y}) => [x, y])))
            .toEqual([[[20, 40], [22, 42]]]);
        expect(getVertex).toHaveBeenCalledTimes(2);
    });
});
