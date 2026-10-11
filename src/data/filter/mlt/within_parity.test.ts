import {expect, test} from 'vitest';
import Point from '@mapbox/point-geometry';
import {featureFilter, type ExpressionSpecification} from '@maplibre/maplibre-gl-style-spec';
import {createConstGeometryVector, FeatureTable, GEOMETRY_TYPE} from '@maplibre/mlt';
import filter, {isColumnarMltFilter} from './filter.ts';
import {CanonicalTileID} from '../../../tile/tile_id.ts';

const polygon = {type: 'Polygon', coordinates: [[[-90, -60], [90, -60], [90, 60], [-90, 60], [-90, -60]]]};
// Inside, outside, and on the boundary of the polygon.
const vertices = new Int32Array([4096, 4096, 100, 100, 2048, 4096]);
const table = new FeatureTable('points', createConstGeometryVector(3, GEOMETRY_TYPE.POINT, null, null, vertices), undefined, undefined, 8192);
const canonical = new CanonicalTileID(0, 0, 0);

function expectStandardSelection(expression: ExpressionSpecification): number[] {
    const reference = featureFilter(expression, 'layers[0].filter');
    const expected = [0, 1, 2].filter(index => reference.filter({zoom: 0}, {
        type: 'Point', properties: {}, geometry: [[new Point(vertices[index * 2], vertices[index * 2 + 1])]]
    }, canonical));
    const selection = filter(table, expression, undefined, canonical);
    expect(Array.from({length: selection.limit}, (_, index) => Number(selection.getIndex(index)))).toEqual(expected);
    return expected;
}

test('within and its negation match the standard evaluator', () => {
    for (const expression of [
        ['within', polygon],
        ['!', ['within', polygon]],
        ['all', ['within', polygon], ['==', ['geometry-type'], 'Point']],
    ] as ExpressionSpecification[]) {
        expectStandardSelection(expression);
    }
});

test('within nested in computed expressions matches the standard evaluator row by row', () => {
    const expression = ['all', ['==', ['within', polygon], true], ['!=', ['case', ['within', polygon], 1, 2], 2]] as ExpressionSpecification;
    expect(isColumnarMltFilter(expression)).toBe(false);
    expect(expectStandardSelection(expression)).toEqual([0]);
});
