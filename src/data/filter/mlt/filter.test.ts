import fs from 'fs';
import path from 'path';
import {describe, expect, test, vi} from 'vitest';
import {featureFilter, type FilterSpecification} from '@maplibre/maplibre-gl-style-spec';
import filter from './filter.ts';
import {ColumnarEvaluationFeature} from '../../bucket/columnar/evaluation_feature.ts';
import {toEvaluationFeature} from '../../evaluation_feature.ts';
import {normalizeMltFeatureId} from '../../../util/mlt_feature_id.ts';
import {MLTVectorTile, getMltFeatureTable} from '../../../source/vector_tile_mlt.ts';
import {CanonicalTileID} from '../../../tile/tile_id.ts';
import {
    createSyntheticLineFeatureTable,
    createSyntheticPointFeatureTable,
    createSyntheticPolygonFeatureTable,
    encodeMltFeatureTable,
    signedMltFeatureId,
} from '../../../../test/unit/lib/mlt_synthetic.ts';

import type {FeatureInput, FeatureTable} from '@maplibre/mlt';

const tiles = path.join(__dirname, '../../../../test/integration/assets/tiles/mlt');

function loadTable(file: string, layer: string): FeatureTable {
    const bytes = fs.readFileSync(path.join(tiles, file));
    return getMltFeatureTable(new MLTVectorTile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).layers[layer]);
}

/** Eight points whose `visible` column is true, false or missing, next to an integer `rank` column. */
function createBooleanFeatureTable(): FeatureTable {
    const visible = [true, false, true, false, true, null, false, true];
    return encodeMltFeatureTable({name: 'booleans', features: visible.map((value, i) => ({
        geometry: {type: 'Point', coordinates: [100 + i * 20, 110 + i * 20]},
        properties: {visible: value, rank: i + 1},
    }))});
}

/** Points, lines and polygons in one layer, with a dictionary string column. */
function createMixedGeometryFeatureTable(): FeatureTable {
    const geometries: Array<FeatureInput['geometry']> = [
        {type: 'Point', coordinates: [10, 10]},
        {type: 'LineString', coordinates: [[0, 0], [20, 20]]},
        {type: 'Polygon', coordinates: [[[0, 0], [30, 0], [30, 30]]]},
        {type: 'MultiPoint', coordinates: [[40, 40], [50, 50]]},
        {type: 'MultiLineString', coordinates: [[[0, 40], [40, 0]], [[60, 60], [70, 70]]]},
    ];
    return encodeMltFeatureTable({name: 'mixed', features: geometries.map((geometry, i) => ({
        id: i + 1, geometry, properties: {class: i % 2 ? 'road' : 'park', rank: i},
    }))}, {stringEncodings: {class: 'dictionary'}});
}

/** A polygon around the whole Web Mercator world. */
const world = {type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]]};

/** Up to three distinct non-null values of a column, as vector tiles decode them. */
function sampleValues(table: FeatureTable, name: string): unknown[] {
    const vector = table.getPropertyVector(name);
    const values = new Set<unknown>();
    for (let i = 0; i < table.numFeatures && values.size < 3; i++) {
        if (!vector.has(i)) continue;
        const value = vector.getValue(i);
        values.add(typeof value === 'bigint' ? Number(value) : value);
    }
    return [...values];
}

/**
 * Filters built from a table's columns: leaves with matching, mismatched and null values, legacy and
 * expression syntax, and the negations, combinations and expressions that only the style evaluator runs.
 */
function generateFilters(table: FeatureTable): unknown[] {
    const filters: unknown[] = [];
    const leaves: unknown[] = [
        ['==', ['geometry-type'], 'LineString'], ['==', ['id'], 1], ['has', '$id'], ['==', '$type', 'Polygon'],
        ['==', ['geometry-type'], 'MultiLineString'], ['in', '$type', 'Unknown', 'Polygon'], ['!=', '$type', 'Unknown'],
        ['>=', ['geometry-type'], 'Point'],
    ];
    for (const name of table.availablePropertyNames.slice(0, 3)) {
        const values = sampleValues(table, name);
        const value = values[0] ?? 'x';
        const other = typeof value === 'number' ? 'text' : 3;
        for (const op of ['==', '!=', '<', '<=', '>', '>=']) {
            leaves.push([op, ['get', name], value], [op, ['get', name], other]);
        }
        leaves.push(
            ['==', ['get', name], null], ['!=', ['get', name], null],
            ['in', ['get', name], ['literal', values.length ? values : ['x']]],
            ['!', ['in', ['get', name], ['literal', values.slice(0, 1)]]],
            ['has', name], ['!', ['has', name]],
            ['match', ['get', name], values.length ? values.slice(0, 2) : ['x'], true, false],
            ['coalesce', ['get', name], false], ['coalesce', ['get', name], true],
        );
        filters.push(
            ['==', name, value], ['!=', name, value], ['<', name, value], ['in', name, ...values], ['!in', name, ...values],
            ['has', name], ['!has', name], ['all', ['==', name, value], ['has', name]], ['none', ['==', name, value]],
            ['!', ['==', name, value]], ['all', ['==', name, value], ['==', ['get', name], value]],
            ['let', 'value', ['get', name], ['==', ['var', 'value'], value]],
            ['==', ['get', name], String(value).toUpperCase(), ['collator', {'case-sensitive': false}]],
            ['==', ['feature-state', name], null],
            ['case', ['has', name], ['==', ['typeof', ['get', name]], 'string'], false],
            ['has', ['literal', name]], ['match', ['get', name], [value, 'x'], false, true], ['match', ['get', name], value, true, false],
            ['case', ['==', ['get', name], value], false, false], ['!in', ['get', name], ['literal', values]],
            ['case', ['==', ['get', name], value], false, ['has', name], true, false],
            ['all', ['==', ['get', name], value], ['in', ['geometry-type'], ['literal', ['Point', 'LineString']]]],
            ['all', ['has', name], ['!=', '$type', 'Polygon']], ['all', ['has', name], ['==', '$type', 'Point']],
            ['all', ['has', name], ['all', ['==', ['get', name], value], ['==', ['to-string', ['get', name]], 'x']]],
            ['any', false, ['==', name, value]], ['all', true, ['==', name, value]],
            ['all', ['has', name], ['>=', ['get', name], value]], ['all', ['has', name], ['<', name, value]],
            ['==', ['get', name], ['global-state', 'list']],
        );
    }
    filters.push(
        true, false, ['literal', true], ['global-state', 'flag'], ['global-state', 'count'], ['all'], ['any'], ['has', '$type'], ['!has', '$type'],
        ['==', ['get', 'missing'], 1], ['!=', 'missing', 1], ['in', 'missing', 1], ['!in', 'missing', 1], ['has', 'missing'], ['!has', 'missing'],
        ['all', ['has', '$id'], ['!=', ['get', 'missing'], 1]], ['all', ['has', '$id'], ['==', 'missing', 1]],
        ['within', world], ['!', ['within', world]], ['<', ['distance', {type: 'Point', coordinates: [0, 0]}], 1e7],
    );
    filters.push(...leaves);
    for (let i = 0; i + 1 < leaves.length; i += 3) {
        const [a, b] = [leaves[i], leaves[i + 1]];
        filters.push(
            ['all', a, b], ['any', a, b], ['!', ['all', a, b]], ['!', ['any', a, b]], ['case', a, true, b, false, true],
            ['all', a, ['>=', ['zoom'], ['step', ['zoom'], 5, 10, 20]]],
            ['any', a, ['<', ['length', ['to-string', ['get', 'class']]], 5]],
        );
    }
    return filters;
}

function isValidStyleFilter(expression: unknown): boolean {
    try {
        featureFilter(expression as FilterSpecification, 'validation');
        return true;
    } catch {
        return false;
    }
}

function selectRows(table: FeatureTable, expression: FilterSpecification): number[] {
    const selection = filter(table, expression);
    return Array.from({length: selection.limit}, (_, i) => Number(selection.getIndex(i)));
}

/** The style filter evaluated on each row as a vector tile feature: ids are unsigned, a missing id is undefined. */
function styleSelection(table: FeatureTable, expression: unknown, canonical: CanonicalTileID, globalState: Record<string, unknown>): number[] {
    const reference = featureFilter(expression as FilterSpecification, 'reference', globalState);
    const view = new ColumnarEvaluationFeature(table);
    const selected: number[] = [];
    for (let i = 0; i < table.numFeatures; i++) {
        view.setIndex(i);
        const feature = {
            type: view.type,
            id: table.idVector?.has(i) ? normalizeMltFeatureId(table.idVector.getValue(i)) : undefined,
            properties: view.properties,
            geometry: reference.needGeometry ? toEvaluationFeature(view, true).geometry : [],
        };
        if (reference.filter({zoom: canonical.z}, feature, canonical)) selected.push(i);
    }
    return selected;
}

describe('MLT filters select the rows the style specification selects', () => {
    const globalState = {flag: true, count: 3, list: ['x']};
    const cases: Array<[string, () => FeatureTable, CanonicalTileID]> = [
        ['OpenMapTiles transportation_name, FSST and dictionary strings', () => loadTable('omt/14/8299/5635.mlt', 'transportation_name'), new CanonicalTileID(14, 8299, 5635)],
        ['booleans with missing values', createBooleanFeatureTable, new CanonicalTileID(0, 0, 0)],
        ['mixed geometry types and a dictionary column', createMixedGeometryFeatureTable, new CanonicalTileID(0, 0, 0)],
        ['gl-js road, 64-bit integers', () => loadTable('gl-js/14-8802-5374.mlt', 'road'), new CanonicalTileID(14, 8802, 5374)],
        ['gl-js poi_label', () => loadTable('gl-js/14-8802-5374.mlt', 'poi_label'), new CanonicalTileID(14, 8802, 5374)],
        ['synthetic lines', createSyntheticLineFeatureTable, new CanonicalTileID(0, 0, 0)],
        ['synthetic polygons', createSyntheticPolygonFeatureTable, new CanonicalTileID(0, 0, 0)],
        ['synthetic points', createSyntheticPointFeatureTable, new CanonicalTileID(0, 0, 0)],
    ];

    test.each(cases)('%s', (_label, createTable, canonical) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const table = createTable();
        const mismatches: string[] = [];
        let checked = 0;
        try {
            for (const expression of generateFilters(table)) {
                if (!isValidStyleFilter(expression)) continue;
                const selection = filter(table, expression as FilterSpecification, globalState, canonical, {zoom: canonical.z});
                const selected = Array.from({length: selection.limit}, (_, i) => Number(selection.getIndex(i))).sort((a, b) => a - b);
                const expected = styleSelection(table, expression, canonical, globalState);
                checked++;
                if (selected.length !== expected.length || selected.some((index, i) => index !== expected[i])) {
                    mismatches.push(`${JSON.stringify(expression)}: ${selected.length} rows instead of ${expected.length}`);
                }
            }
        } finally {
            warn.mockRestore();
        }
        expect(checked).toBeGreaterThan(100);
        expect(mismatches).toEqual([]);
    }, 30000);

    test('reads global state values updated in place', () => {
        const table = createBooleanFeatureTable();
        const globalState = {target: 1};
        const expression: FilterSpecification = ['==', ['get', 'rank'], ['global-state', 'target']];
        const rows = () => {
            const selection = filter(table, expression, globalState);
            return Array.from({length: selection.limit}, (_, i) => Number(selection.getIndex(i)));
        };

        expect(rows()).toEqual([0]);
        globalState.target = 2;
        expect(rows()).toEqual([1]);
    });

    test('compares feature ids as the unsigned 64-bit numbers vector tiles decode', () => {
        const table = createSyntheticLineFeatureTable();
        const unsigned = normalizeMltFeatureId(signedMltFeatureId);

        expect(selectRows(table, ['==', ['id'], unsigned])).toEqual([2]);
        expect(selectRows(table, ['==', ['id'], signedMltFeatureId])).toEqual([]);
        // The second row has no id: it is neither equal to nor, for vector tiles, `null`.
        expect(selectRows(table, ['==', ['id'], null])).toEqual([]);
        expect(selectRows(table, ['has', '$id'])).toEqual([0, 2, 3]);
    });
});
