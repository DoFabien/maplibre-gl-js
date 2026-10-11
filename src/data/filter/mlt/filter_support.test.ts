import {describe, expect, test} from 'vitest';
import path from 'path';
import {readdirSync, readFileSync} from 'fs';
import {isColumnarMltFilter} from './filter';

const mltRenderStyleRoot = path.join(__dirname, '../../../../test/integration/render/tests/mlt');
type UnsupportedMltRenderFixtureFilter = {file: string; layerId: string; reason: string; filter: any};
const expectedUnsupportedMltRenderFixtureFilters: UnsupportedMltRenderFixtureFilter[] = [];
const columnarMltLayerTypes = new Set(['line', 'fill', 'circle', 'fill-extrusion', 'symbol', 'heatmap']);

function expectSupported(filter: any, globalState?: Record<string, unknown>) {
    expect(() => isColumnarMltFilter(filter, globalState)).not.toThrow();
}

function expectInvalid(filter: any) {
    expect(() => isColumnarMltFilter(filter)).toThrow(/: (Expected|Unknown|Branch|Cannot)/);
}

function expectRowEvaluated(filter: any, globalState?: Record<string, unknown>) {
    expect(isColumnarMltFilter(filter, globalState)).toBe(false);
}

function findStyleJsonFiles(directory: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            result.push(...findStyleJsonFiles(entryPath));
        } else if (entry.name === 'style.json') {
            result.push(entryPath);
        }
    }
    return result;
}

function collectMltRenderStyleFilters(): Array<{file: string; layerId: string; filter: any}> {
    const filters = [];

    for (const file of findStyleJsonFiles(mltRenderStyleRoot)) {
        const style = JSON.parse(readFileSync(file, 'utf8'));
        const hasMltSource = Object.values(style.sources ?? {}).some((source: any) => source?.encoding === 'mlt');
        if (!hasMltSource) continue;

        for (const layer of style.layers ?? []) {
            if (layer.filter) {
                filters.push({file, layerId: layer.id, filter: layer.filter});
            }
        }
    }

    return filters;
}

function relativeRenderStylePath(file: string): string {
    return path.relative(path.join(__dirname, '../../../..'), file);
}

function collectUnsupportedMltRenderStyleFilters(): UnsupportedMltRenderFixtureFilter[] {
    return collectMltRenderStyleFilters().flatMap(({file, layerId, filter}) => {
        try {
            isColumnarMltFilter(filter);
            return [];
        } catch (error) {
            return [{file: relativeRenderStylePath(file), layerId, filter, reason: (error as Error).message}];
        }
    });
}

function collectUnsupportedMltRenderLayerTypes(): Array<{file: string; layerId: string; type: string}> {
    const unsupported = [];

    for (const file of findStyleJsonFiles(mltRenderStyleRoot)) {
        const style = JSON.parse(readFileSync(file, 'utf8'));
        const mltSourceIds = new Set(
            Object.entries(style.sources ?? {})
                .filter(([, source]: [string, any]) => source?.encoding === 'mlt')
                .map(([sourceId]) => sourceId)
        );
        if (mltSourceIds.size === 0) continue;

        for (const layer of style.layers ?? []) {
            if (!layer.source || !mltSourceIds.has(layer.source)) continue;
            if (!columnarMltLayerTypes.has(layer.type)) {
                unsupported.push({
                    file: relativeRenderStylePath(file),
                    layerId: layer.id,
                    type: layer.type
                });
            }
        }
    }

    return unsupported;
}

describe('MLT filter support', () => {
    test('accepts every valid style filter', () => {
        for (const filter of [
            ['==', 'rank', 1],
            ['!=', 'rank', 1],
            ['<', 'rank', 2],
            ['<=', 'rank', 2],
            ['>', 'rank', 2],
            ['>=', 'rank', 2],
            ['in', 'class', 'primary', 'secondary'],
            ['!in', 'class', 'primary', 'secondary'],
            ['has', 'class'],
            ['!has', 'class'],
            ['has', ['literal', 'class']],
            ['!has', ['literal', 'class']],
            ['has', ['get', 'propertyName']],
            ['all', ['>=', 'rank', 1], ['has', 'class']],
            ['any', ['==', 'rank', 1], ['==', 'rank', 2]],
            ['none', ['==', 'rank', 1], ['==', 'rank', 2]],
            ['!', ['==', ['get', 'rank'], 1]],
            ['!', ['has', ['get', 'propertyName']]],
            ['match', ['get', 'class'], ['primary', 'secondary'], true, false],
            ['match', ['get', 'class'], ['primary', 'secondary'], false, true],
            ['case', ['==', ['get', 'rank'], 1], true, false],
            ['case', ['==', ['get', 'rank'], 1], false, true],
            ['case', ['==', ['get', 'rank'], 1], true, ['==', ['get', 'rank'], 2], true, false],
            ['case', ['==', ['get', 'rank'], 1], false, ['==', ['get', 'rank'], 2], false, true],
            ['case', ['==', ['get', 'rank'], 1], true, ['==', ['get', 'rank'], 2], false, true],
            ['case', true, true, false],
            ['coalesce', ['==', ['get', 'rank'], 1], false],
            ['coalesce', false, ['==', ['get', 'rank'], 1]],
            ['coalesce', true, false],
            ['coalesce', ['get', 'visible'], false],
            ['coalesce', ['get', 'visible'], ['literal', false]],
            ['coalesce', ['get', 'visible']],
            ['coalesce', ['get', 'visible'], true],
            ['coalesce', ['get', 'visible'], ['==', ['get', 'rank'], 1]],
            ['coalesce', ['get', 'visible'], ['boolean', ['get', 'fallbackVisible'], false]],
            ['case', ['coalesce', ['==', ['get', 'rank'], 1], false], true, false],
            ['case', ['coalesce', ['get', 'visible'], false], true, false],
            ['==', ['to-number', ['get', 'rank']], 3],
            ['==', ['to-number', ['get', 'rank'], 0], 3],
            ['==', ['to-string', ['get', 'rank']], '3'],
            ['==', ['to-boolean', ['get', 'visible']], true],
            ['boolean', ['get', 'visible'], false],
            ['to-boolean', ['get', 'rank']],
            ['literal', true],
            ['literal', false],
            ['==', ['coalesce', ['get', 'rank'], 0], 1],
            ['<', ['coalesce', ['get', 'rank'], 999], 10],
            ['all', ['==', ['to-number', ['get', 'rank']], 3], ['==', ['to-string', ['get', 'class']], 'primary']],
            ['==', ['+', ['get', 'rank'], 1], 4],
            ['==', ['-', ['get', 'rank'], 1], 2],
            ['==', ['-', ['get', 'rank']], -3],
            ['==', ['*', ['get', 'rank'], 2], 6],
            ['==', ['/', ['get', 'rank'], 2], 1.5],
            ['==', ['%', ['to-number', ['id']], 10], 7],
            ['==', ['min', ['get', 'rank'], 2], 2],
            ['==', ['max', ['get', 'rank'], 2], 3],
            ['==', ['length', ['get', 'class']], 7],
            ['==', ['concat', ['get', 'class'], '-', ['to-string', ['get', 'rank']]], 'primary-3'],
            ['==', ['let', 'r', ['to-number', ['get', 'rank']], ['var', 'r']], 3],
            ['==', ['let', 'r', 1, ['let', 'r', 2, ['var', 'r']]], 2],
            ['==', ['get', 'rank'], ['let', 'target', 3, ['var', 'target']]],
            ['==', ['get', 'rank'], ['get', 'other']],
            ['<', ['step', ['to-number', ['get', 'rank']], 999, 5, 10, 10, 20], 15],
            ['<', ['interpolate', ['linear'], ['to-number', ['get', 'rank']], 0, 0, 10, 100], 50],
            ['<', ['interpolate', ['exponential', 2], ['to-number', ['get', 'rank']], 0, 0, 10, 100], 50],
            ['==', ['typeof', ['get', 'rank']], 'number'],
            ['==', ['number', ['get', 'rank'], 0], 3],
            ['==', ['string', ['get', 'class'], 'fallback'], 'primary'],
            ['==', ['boolean', ['get', 'visible'], false], true],
            ['==', ['literal', 'primary'], ['get', 'class']],
            ['==', ['slice', ['get', 'class'], 0, 3], 'pri'],
            ['>=', ['index-of', 'mar', ['get', 'class']], 0],
            ['==', ['upcase', ['get', 'class']], 'PRIMARY'],
            ['==', ['downcase', ['get', 'class']], 'primary'],
            ['<', ['case', ['==', ['get', 'class'], 'primary'], 1, 9], 5],
            ['==', ['case', ['all', ['==', ['get', 'class'], 'primary'], ['>=', ['get', 'rank'], 2]], ['+', ['get', 'rank'], 1], 0], 4],
            ['==', ['match', ['get', 'class'], 'primary', 1, 'secondary', 2, 0], 1],
            ['==', ['match', ['to-string', ['get', 'rank']], ['1', '2'], 'low', 'other'], 'low'],
            ['match', ['to-string', ['get', 'class']], 'primary', true, false],
            ['match', ['get', 'class'], 'primary', ['==', ['get', 'rank'], 1], false],
            ['match', ['get', 'class'], 'primary', true, 'secondary', true, false],
            ['case', ['in', 'way', ['downcase', ['get', 'type']]], true, false],
            ['case', ['in', ['literal', 'way'], ['downcase', ['get', 'type']]], true, false],
            ['case', ['==', ['get', 'class'], 'primary'], ['==', ['get', 'rank'], 1], false],
            ['case', ['==', ['get', 'class'], 'primary'], true, ['==', ['get', 'class'], 'secondary'], ['==', ['get', 'rank'], 2], false],
            ['let', 'visible', ['boolean', ['get', 'visible'], false], ['case', ['var', 'visible'], ['==', ['get', 'rank'], 1], false]],
            ['==', ['in', ['get', 'class'], ['literal', ['primary', 'secondary']]], true],
            ['==', ['in', 'way', ['downcase', ['get', 'type']]], true],
            ['==', ['case', ['==', ['get', 'rank'], 1], ['all', ['==', ['get', 'class'], 'primary'], ['has', 'type']], false], true],
            ['case', ['<', ['let', 'r', ['to-number', ['get', 'rank']], ['var', 'r']], 5], true, false],
            ['let', 'r', ['to-number', ['get', 'rank']], ['<', ['var', 'r'], 5]],
            ['all', ['let', 'r', ['to-number', ['get', 'rank']], ['<', ['var', 'r'], 5]], ['==', ['get', 'class'], 'primary']],
            ['==', '$type', 'Polygon'],
            ['!in', '$type', 'Polygon'],
            ['==', '$id', 7],
            ['==', ['get', 'rank'], 1],
            ['==', ['id'], 7],
            ['==', ['geometry-type'], 'Polygon'],
            ['in', ['get', 'class'], ['literal', ['primary', 'secondary']]],
            ['within', {type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]]}],
        ]) {
            expectSupported(filter);
        }
    });

    test('accepts global-state values resolved before columnar filtering', () => {
        expectSupported(['==', ['get', 'rank'], ['global-state', 'targetRank']], {targetRank: 3});
        expectSupported(['!=', ['get', 'class'], ['global-state', 'hiddenClass']], {hiddenClass: 'secondary'});
        expectSupported(['all', ['global-state', 'visible'], ['>=', ['get', 'rank'], ['global-state', 'minRank']]], {visible: true, minRank: 2});
        expectSupported(['coalesce', ['get', 'visible'], ['global-state', 'showFeatures']], {showFeatures: false});
        expectSupported(['global-state', 'visible'], {visible: false});
        expectSupported(['in', ['get', 'class'], ['global-state', 'visibleClasses']], {visibleClasses: ['primary', 'secondary']});
        expectSupported(['in', ['literal', 'way'], ['global-state', 'typeSearch']], {typeSearch: 'footway'});
    });

    test('rejects filters the style specification rejects', () => {
        for (const filter of [
            ['literal', 'visible'],
            ['case', ['==', ['get', 'rank'], 1], 'yes', false],
            ['coalesce', null],
            ['coalesce', ['get', 'visible'], 'fallback'],
            ['all', ['coalesce', ['get', 'visible'], false], ['==', 'rank', 1]],
            ['all', ['==', 'rank', 1], ['==', ['get', 'class'], 'primary']],
            ['==', ['var', 'missing'], 1],
            ['==', ['let', 'r', 1], 1],
            ['==', ['let', ['get', 'name'], 1, ['var', 'name']], 1],
            ['==', ['let', 'r', 2, 'next', ['+', ['var', 'r'], 1], ['var', 'next']], 3],
            ['let', 'r', 1, ['var', 'r']],
            ['==', ['unknown', 'rank'], 1],
            ['match', ['get', 'class'], 'primary', 'yes', false],
            ['match', ['get', 'class'], ['literal', ['primary']], true, false],
            ['match', ['get', 'class'], ['primary', 'primary'], true, false],
            ['match', ['get', 'class'], [], true, false],
        ]) {
            expectInvalid(filter);
        }
    });

    test('evaluates valid filters the columns cannot run row by row, as the style specification does', () => {
        const cases: Array<[any, Record<string, unknown>?]> = [
            [['==', ['global-state', 'rank'], 1]],
            [['==', ['get', 'rank'], ['global-state', 'targetRank']]],
            [['==', ['get', 'rank'], ['global-state', 'targetRank']], {targetRank: [3]}],
            [['global-state', 'class'], {class: 'primary'}],
            [['!=', 'class', ['global-state', 'hiddenClass']], {hiddenClass: 'secondary'}],
            [['in', ['get', 'class'], ['global-state', 'visibleClasses']], {visibleClasses: [{class: 'primary'}]}],
            [['coalesce', ['get', 'visible'], ['global-state', 'class']], {class: 'primary'}],
            [['==', ['feature-state', 'selected'], true]],
            [['==', ['to-number', ['feature-state', 'rank']], 1]],
            [['==', ['let', 'r', ['feature-state', 'rank'], ['var', 'r']], 1]],
            [['==', ['step', ['feature-state', 'rank'], 0, 1, 1], 1]],
            [['==', ['interpolate', ['cubic-bezier', 0, 0, 1, 1], ['to-number', ['get', 'rank']], 0, 0, 1, 1], 1]],
            [['==', ['slice', ['feature-state', 'name'], 0], 'a']],
            [['==', ['index-of', 'a', ['feature-state', 'name']], 0]],
            [['==', ['upcase', ['feature-state', 'name']], 'A']],
            [['==', ['concat', ['feature-state', 'name'], '-x'], 'name-x']],
            [['==', ['case', ['feature-state', 'selected'], 1, 0], 1]],
            [['==', ['match', ['feature-state', 'class'], 'primary', 1, 0], 1]],
            [['==', ['in', 'a', ['feature-state', 'letters']], true]],
            [['has', ['string', ['get', 'class']]]],
            [['!has', ['get', 'class']]],
        ];
        for (const [filter, globalState] of cases) {
            expectRowEvaluated(filter, globalState);
        }
    });

    test('documents columnar and row-evaluated filter boundaries', () => {
        const columnarCases: Array<{label: string; filter: any; globalState?: Record<string, unknown>}> = [
            {
                label: 'legacy shorthand with primitive values',
                filter: ['all', ['==', 'rank', 1], ['has', 'class']],
            },
            {
                label: 'expression-style accessors',
                filter: ['all', ['==', ['get', 'rank'], 1], ['!', ['has', 'class']]],
            },
            {
                label: 'primitive global-state in expression-style comparisons',
                filter: ['!=', ['get', 'class'], ['global-state', 'hiddenClass']],
                globalState: {hiddenClass: 'secondary'},
            },
            {
                label: 'match/case with expression-style accessors',
                filter: ['case', ['match', ['get', 'class'], 'primary', true, false], true, false],
            },
            {
                label: 'geometry type accessor',
                filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'LineString']]],
            },
        ];
        const rowEvaluatedCases: Array<{label: string; filter: any; globalState?: Record<string, unknown>}> = [
            {
                label: 'dynamic property names',
                filter: ['!', ['has', ['get', 'propertyName']]],
            },
            {
                label: 'feature id',
                filter: ['==', ['id'], 7],
            },
            {
                label: 'comparison with null, which a missing property equals',
                filter: ['==', ['get', 'class'], null],
            },
            {
                label: 'within',
                filter: ['within', {type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]]}],
            },
            {
                label: 'coalesce returns its first non-null value, which fails as a filter unless it is a boolean',
                filter: ['coalesce', ['get', 'visible']],
            },
            {
                label: 'feature-state evaluates as null in layer filters, as for vector tiles',
                filter: ['==', ['feature-state', 'selected'], true],
            },
            {
                label: 'legacy-looking targets inside an expression are literal strings',
                filter: ['!', ['==', 'rank', '1']],
            },
            {
                label: 'legacy-looking targets nested in an expression all',
                filter: ['all', ['coalesce', ['==', '$type', 'Polygon'], false], ['==', ['get', 'class'], 'primary']],
            },
            {
                label: 'case mixing legacy-looking and expression conditions',
                filter: ['case', ['==', '$type', 'Polygon'], true, ['==', ['get', 'class'], 'primary'], true, false],
            },
            {
                label: 'match shorthand string input is a literal expression, not a property accessor',
                filter: ['match', 'class', 'primary', true, false],
            },
            {
                label: 'legacy shorthand global-state comparison keeps the legacy evaluator semantics',
                filter: ['!=', 'class', ['global-state', 'hiddenClass']],
                globalState: {hiddenClass: 'secondary'},
            },
        ];

        for (const {filter, globalState} of columnarCases) {
            expect(isColumnarMltFilter(filter, globalState)).toBe(true);
        }
        for (const {filter, globalState} of rowEvaluatedCases) {
            expectRowEvaluated(filter, globalState);
        }
    });

    test('keeps the unsupported MLT render fixture filter allowlist empty', () => {
        expect(collectUnsupportedMltRenderStyleFilters()).toEqual(expectedUnsupportedMltRenderFixtureFilters);
    });

    test('keeps MLT render fixtures on columnar-capable layer types', () => {
        expect(collectUnsupportedMltRenderLayerTypes()).toEqual([]);
    });
});
