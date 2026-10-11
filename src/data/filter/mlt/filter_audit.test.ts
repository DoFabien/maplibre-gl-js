import {expect, test} from 'vitest';
import {classifyFilter} from '../../../../test/integration/lib/mlt_filter_audit.ts';

test('separates columnar filters, row-evaluated filters and invalid style filters', () => {
    expect(classifyFilter(['==', ['get', 'class'], 'street']).status).toBe('columnar');
    expect(classifyFilter(['==', ['get', 'rank'], ['global-state', 'rank']], {rank: 3}).status).toBe('columnar');
    expect(classifyFilter(['==', ['+', ['get', 'rank'], 1], 4]).status).toBe('row-evaluated');
    expect(classifyFilter(['==', ['zoom'], 3]).status).toBe('row-evaluated');
    expect(classifyFilter(['is-supported-script', ['get', 'name']]).status).toBe('row-evaluated');
    expect(classifyFilter(['<', ['distance', {type: 'Point', coordinates: [0, 0]}], 1000]).status).toBe('row-evaluated');
    expect(classifyFilter(['==', ['feature-state', 'selected'], true]).status).toBe('spec-invalid');
});
