import {describe, expect, test} from 'vitest';
import path from 'path';
import {readdirSync, readFileSync} from 'fs';
import {getMltFilterSupport} from './filter';

const mltRenderStyleRoot = path.join(__dirname, '../../../../test/integration/render/tests/mlt');
type UnsupportedMltRenderFixtureFilter = {file: string; layerId: string; reason: string; filter: any};
const expectedUnsupportedMltRenderFixtureFilters: UnsupportedMltRenderFixtureFilter[] = [];
const columnarMltLayerTypes = new Set(['line', 'fill', 'circle', 'fill-extrusion', 'symbol', 'heatmap']);

function expectSupported(filter: any, globalState?: Record<string, unknown>) {
    expect(getMltFilterSupport(filter, globalState)).toEqual({supported: true});
}

function expectUnsupported(filter: any, reason: RegExp, globalState?: Record<string, unknown>) {
    const support = getMltFilterSupport(filter, globalState);
    if (support.supported) {
        throw new Error(`Expected unsupported MLT filter: ${JSON.stringify(filter)}`);
    }
    expect((support as {supported: false; reason: string}).reason).toMatch(reason);
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
        const support = getMltFilterSupport(filter);
        return !('reason' in support) ? [] : [{
            file: relativeRenderStylePath(file),
            layerId,
            filter,
            reason: support.reason
        }];
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

describe('getMltFilterSupport', () => {
    test('accepts filters covered by the columnar MLT filter path', () => {
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

    test('rejects expressions that require legacy feature-filter semantics', () => {
        expectUnsupported(['==', ['global-state', 'rank'], 1], /not available/);
        expectUnsupported(['==', ['get', 'rank'], ['global-state', 'targetRank']], /not available/);
        expectUnsupported(['==', ['get', 'rank'], ['global-state', 'targetRank']], /primitive/, {targetRank: [3]});
        expectUnsupported(['global-state', 'class'], /boolean/, {class: 'primary'});
        expectUnsupported(['literal', 'visible'], /boolean/);
        expectUnsupported(['!=', 'class', ['global-state', 'hiddenClass']], /legacy filters only support primitive comparison/, {hiddenClass: 'secondary'});
        expectUnsupported(['==', ['feature-state', 'selected'], true], /feature-state/);
        expectUnsupported(['case', ['==', ['get', 'rank'], 1], 'yes', false], /Expected boolean/);
        expectUnsupported(['case', ['==', '$type', 'Polygon'], true, ['==', ['get', 'class'], 'primary'], true, false], /not both/);
        expectUnsupported(['coalesce', null], /Expected boolean/);
        expectUnsupported(['all', ['coalesce', ['==', '$type', 'Polygon'], false], ['==', ['get', 'class'], 'primary']], /not both/);
        expectUnsupported(['all', ['coalesce', ['get', 'visible'], false], ['==', 'rank', 1]], /not both|Cannot compare types/);
        expectUnsupported(['coalesce', ['get', 'visible'], ['global-state', 'class']], /boolean values|boolean fallback/, {class: 'primary'});
        expectUnsupported(['coalesce', ['get', 'visible'], 'fallback'], /Expected boolean|filters only support expression arrays|boolean fallback/);
        expectUnsupported(['==', ['to-number', ['feature-state', 'rank']], 1], /feature-state/);
        expectUnsupported(['==', ['to-string', ['feature-state', 'rank']], '1'], /feature-state/);
        expectUnsupported(['==', ['to-boolean', ['feature-state', 'visible']], true], /feature-state/);
        expectUnsupported(['==', ['+', ['feature-state', 'rank'], 1], 2], /feature-state/);
        expectUnsupported(['==', ['length', ['feature-state', 'name']], 4], /feature-state/);
        expectUnsupported(['==', ['concat', ['feature-state', 'name'], '-x'], 'name-x'], /feature-state/);
        expectUnsupported(['==', ['var', 'missing'], 1], /Unknown variable/);
        expectUnsupported(['==', ['let', 'r', 1], 1], /Expected at least|let expressions require/);
        expectUnsupported(['==', ['let', ['get', 'name'], 1, ['var', 'name']], 1], /Expected string|binding names/);
        expectUnsupported(['==', ['let', 'r', 2, 'next', ['+', ['var', 'r'], 1], ['var', 'next']], 3], /Unknown variable/);
        expectUnsupported(['==', ['let', 'r', ['feature-state', 'rank'], ['var', 'r']], 1], /feature-state/);
        expectUnsupported(['let', 'r', 1, ['var', 'r']], /Expected boolean/);
        expectUnsupported(['==', ['step', ['feature-state', 'rank'], 0, 1, 1], 1], /feature-state/);
        expectUnsupported(['==', ['interpolate', ['cubic-bezier', 0, 0, 1, 1], ['to-number', ['get', 'rank']], 0, 0, 1, 1], 1], /interpolate type/);
        expectUnsupported(['==', ['slice', ['feature-state', 'name'], 0], 'a'], /feature-state/);
        expectUnsupported(['==', ['index-of', 'a', ['feature-state', 'name']], 0], /feature-state/);
        expectUnsupported(['==', ['upcase', ['feature-state', 'name']], 'A'], /feature-state/);
        expectUnsupported(['==', ['unknown', 'rank'], 1], /Unknown expression "unknown"/);
        expectUnsupported(['!', ['==', 'rank', '1']], /expression-style accessors/);
        expectUnsupported(['all', ['==', 'rank', 1], ['==', ['get', 'class'], 'primary']], /not both|Cannot compare types/);
        expectUnsupported(['!has', ['get', 'class']], /dynamic !has/);
        expectUnsupported(['has', ['string', ['get', 'class']]], /target expression: string/);
        expectUnsupported(['match', 'class', 'primary', true, false], /expression-style accessors/);
        expectUnsupported(['match', ['get', 'class'], 'primary', 'yes', false], /Expected boolean/);
        expectUnsupported(['match', ['get', 'class'], ['literal', ['primary']], true, false], /Branch labels/);
        expectUnsupported(['match', ['get', 'class'], ['primary', 'primary'], true, false], /unique/);
        expectUnsupported(['match', ['get', 'class'], [], true, false], /at least one branch label/);
        expectUnsupported(['==', ['case', ['feature-state', 'selected'], 1, 0], 1], /feature-state/);
        expectUnsupported(['==', ['match', ['feature-state', 'class'], 'primary', 1, 0], 1], /feature-state/);
        expectUnsupported(['==', ['in', 'a', ['feature-state', 'letters']], true], /feature-state/);
    });

    test('documents native and deterministically rejected MLT filter boundaries', () => {
        const nativeCases: Array<{label: string; filter: any; globalState?: Record<string, unknown>}> = [
            {
                label: 'legacy shorthand with primitive values',
                filter: ['all', ['==', 'rank', 1], ['has', 'class']],
            },
            {
                label: 'expression-style accessors and dynamic property names',
                filter: ['all', ['==', ['get', 'rank'], 1], ['!', ['has', ['get', 'propertyName']]]],
            },
            {
                label: 'boolean coalesce without an explicit fallback',
                filter: ['coalesce', ['get', 'visible']],
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
                label: 'feature id and geometry type accessors',
                filter: ['all', ['==', ['id'], 7], ['==', ['geometry-type'], 'Polygon']],
            },
            {
                label: 'within evaluates geometry directly from MLT columns',
                filter: ['within', {type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]]}],
            },
        ];
        const unsupportedCases: Array<{label: string; filter: any; reason: RegExp; globalState?: Record<string, unknown>}> = [
            {
                label: 'feature-state belongs to paint expressions, not layer filters',
                filter: ['==', ['feature-state', 'selected'], true],
                reason: /style specification only supports feature-state in paint expressions/,
            },
            {
                label: 'mixed legacy shorthand and expression accessors',
                filter: ['all', ['==', 'rank', 1], ['==', ['get', 'class'], 'primary']],
                reason: /not both|Cannot compare types/,
            },
            {
                label: 'not over legacy shorthand does not match expression semantics',
                filter: ['!', ['==', 'rank', '1']],
                reason: /expression-style accessors/,
            },
            {
                label: 'direct dynamic !has differs from expression-style negation',
                filter: ['!has', ['get', 'class']],
                reason: /dynamic !has/,
            },
            {
                label: 'match shorthand string input is a literal expression, not a property accessor',
                filter: ['match', 'class', 'primary', true, false],
                reason: /expression-style accessors/,
            },
            {
                label: 'filter expressions must resolve to booleans',
                filter: ['literal', 'visible'],
                reason: /boolean/,
            },
            {
                label: 'legacy shorthand global-state comparison is not resolved by the legacy evaluator',
                filter: ['!=', 'class', ['global-state', 'hiddenClass']],
                reason: /legacy filters only support primitive comparison/,
                globalState: {hiddenClass: 'secondary'},
            },
            {
                label: 'global-state membership haystacks must resolve to primitives',
                filter: ['in', ['get', 'class'], ['global-state', 'visibleClasses']],
                reason: /membership haystacks/,
                globalState: {visibleClasses: [{class: 'primary'}]},
            },
        ];

        for (const {filter, globalState} of nativeCases) {
            expectSupported(filter, globalState);
        }
        for (const {filter, reason, globalState} of unsupportedCases) {
            expectUnsupported(filter, reason, globalState);
        }
    });

    test('keeps the unsupported MLT render fixture filter allowlist empty', () => {
        expect(collectUnsupportedMltRenderStyleFilters()).toEqual(expectedUnsupportedMltRenderFixtureFilters);
    });

    test('keeps MLT render fixtures on columnar-capable layer types', () => {
        expect(collectUnsupportedMltRenderLayerTypes()).toEqual([]);
    });
});
