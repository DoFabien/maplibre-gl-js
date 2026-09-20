import {describe, test, expect, vi, afterEach} from 'vitest';
import {GlobeProjection} from './globe_projection.ts';
import {EvaluationParameters} from '../../style/evaluation_parameters.ts';

import type {TransitionParameters} from '../../style/properties.ts';
import type {ProjectionDefinitionT} from '@maplibre/maplibre-gl-style-spec';

test.each([
    {definition: ['mercator', 'vertical-perspective', 0.5], expected: 0.5},
    {definition: ['vertical-perspective', 'mercator', 0.25], expected: 0.75},
    {definition: ['mercator', 'mercator', 0.5], expected: 0},
    {definition: ['vertical-perspective', 'vertical-perspective', 0.5], expected: 1}
])('evaluates a literal projection tuple: $definition', ({definition, expected}) => {
    const projection = new GlobeProjection({type: definition as ProjectionDefinitionT}, {});
    expect(projection.transitionState).toBe(expected);
    projection.destroy();
});

describe('GlobeProjection runtime error logging', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('warns with the projection property location when an expression errors at runtime', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const projection = new GlobeProjection(undefined, {});
        // global-state defeats constant-folding, so this fails at evaluation time (not parse time).
        projection.setProjection({type: ['string', ['global-state', 'missing']]} as any);
        projection.updateTransitions({transition: false} as any as TransitionParameters);
        projection.recalculate(new EvaluationParameters(16));

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toBe('projection.type: Expected value to be of type string, but found null instead. Falling back to mercator.');
    });
});
