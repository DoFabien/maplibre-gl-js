import {expect, test} from 'vitest';
import {classifyFilter} from '../../../../test/integration/lib/mlt_filter_audit.ts';

test('separates supported filters, valid gaps and invalid style filters', () => {
    expect(classifyFilter(['==', ['+', ['get', 'rank'], 1], 4]).status).toBe('supported');
    expect(classifyFilter(['==', ['zoom'], 3]).status).toBe('supported');
    expect(classifyFilter(['is-supported-script', ['get', 'name']]).status).toBe('supported');
    expect(classifyFilter(['<', ['distance', {type: 'Point', coordinates: [0, 0]}], 1000]).status).toBe('valid-unsupported');
    expect(classifyFilter(['==', ['feature-state', 'selected'], true]).status).toBe('spec-invalid');
    expect(classifyFilter(['==', ['get', 'rank'], ['global-state', 'rank']], {rank: 3}).status).toBe('supported');
});
