import {expect, test} from 'vitest';
import Point from '@mapbox/point-geometry';
import {featureFilter, type ExpressionSpecification} from '@maplibre/maplibre-gl-style-spec';
import {createConstGeometryVector, FeatureTable, GEOMETRY_TYPE} from '@maplibre/mlt';
import filter, {getMltFilterSupport} from './filter.ts';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../../../util/mlt_materialization_stats.ts';
import {CanonicalTileID} from '../../../tile/tile_id.ts';

test('nested within matches the standard evaluator for inside, outside and boundary points', () => {
    const polygon = {type: 'Polygon', coordinates: [[[-90, -60], [90, -60], [90, 60], [-90, 60], [-90, -60]]]};
    const expression = ['all', ['==', ['within', polygon], true], ['!=', ['case', ['within', polygon], 1, 2], 2]] as ExpressionSpecification;
    const vertices = new Int32Array([4096, 4096, 100, 100, 2048, 4096]);
    const table = new FeatureTable('points', createConstGeometryVector(3, GEOMETRY_TYPE.POINT, null, null, vertices), undefined, undefined, 8192);
    const canonical = new CanonicalTileID(0, 0, 0);
    const reference = featureFilter(expression, 'layers[0].filter');
    const expected = [0, 1, 2].filter(index => reference.filter({zoom: 0}, {
        type: 'Point', properties: {}, geometry: [[new Point(vertices[index * 2], vertices[index * 2 + 1])]]
    }, canonical));
    expect(expected).toEqual([0]);
    expect(getMltFilterSupport(expression)).toEqual({supported: true});
    const stats = createMltMaterializationStats({strict: true});
    const deactivate = activateMltMaterializationStats(stats);
    try {
        const selection = filter(table, expression, undefined, canonical);
        expect(Array.from({length: selection.limit}, (_, index) => Number(selection.getIndex(index)))).toEqual(expected);
    } finally {
        deactivate();
    }
    expect(stats.counters.geometryPartsMaterialized).toBe(0);
});
