import {lineClipPropertyNames} from '../line_clip_properties.ts';

import type {StyleLayer} from '../../../style/style_layer.ts';

const legacyFilterPropertyOperators = new Set(['==', '!=', '>', '>=', '<', '<=', 'in', '!in']);

export function collectTokenPropertyNames(value: string, neededProperties: Set<string>): void {
    for (const match of value.matchAll(/{([^{}]+)}/g)) {
        neededProperties.add(match[1]);
    }
}

export function collectExpressionPropertyDependencies(expression: unknown, neededProperties: Set<string>): boolean {
    if (typeof expression === 'string') {
        collectTokenPropertyNames(expression, neededProperties);
        return true;
    }

    if (!Array.isArray(expression)) {
        if (expression && typeof expression === 'object') {
            return collectObjectPropertyDependencies(expression as Record<string, unknown>, neededProperties);
        }
        return true;
    }

    const operator = expression[0];
    if (operator === 'literal') return true;
    if (operator === 'properties') return false;
    if (operator === 'id' || operator === 'geometry-type' || operator === 'global-state' || operator === 'feature-state') {
        return true;
    }

    if (operator === 'get' || operator === 'has') {
        if (expression.length !== 2 || typeof expression[1] !== 'string') return false;
        neededProperties.add(expression[1]);
        return true;
    }

    for (let i = 1; i < expression.length; i++) {
        if (!collectExpressionPropertyDependencies(expression[i], neededProperties)) return false;
    }
    return true;
}

export function collectFilterPropertyDependencies(expression: unknown, neededProperties: Set<string>): boolean {
    if (!Array.isArray(expression)) return collectExpressionPropertyDependencies(expression, neededProperties);

    const operator = expression[0];
    if ((operator === 'all' || operator === 'any' || operator === 'none') && expression.length > 1) {
        for (let i = 1; i < expression.length; i++) {
            if (!collectFilterPropertyDependencies(expression[i], neededProperties)) return false;
        }
        return true;
    }

    if ((operator === 'has' || operator === '!has') && typeof expression[1] === 'string') {
        neededProperties.add(expression[1]);
        return true;
    }

    if (legacyFilterPropertyOperators.has(operator) && typeof expression[1] === 'string') {
        neededProperties.add(expression[1]);
        return true;
    }

    return collectExpressionPropertyDependencies(expression, neededProperties);
}

export function collectLayerPropertyDependencies(layer: StyleLayer): Set<string> | null {
    const neededProperties = new Set<string>();
    const serializedLayer = layer.serialize();

    if (layer.filter !== undefined && !collectFilterPropertyDependencies(layer.filter, neededProperties)) {
        return null;
    }

    if (!collectObjectPropertyDependencies(serializedLayer.layout ?? {}, neededProperties)) {
        return null;
    }
    if (!collectObjectPropertyDependencies(serializedLayer.paint ?? {}, neededProperties)) {
        return null;
    }
    if (serializedLayer.type === 'line' && serializedLayer.paint?.['line-gradient'] !== undefined) {
        for (const [startKey, endKey] of lineClipPropertyNames) {
            neededProperties.add(startKey);
            neededProperties.add(endKey);
        }
    }

    return neededProperties;
}

function collectObjectPropertyDependencies(value: Record<string, unknown>, neededProperties: Set<string>): boolean {
    if (typeof value.property === 'string') {
        neededProperties.add(value.property);
    }

    for (const childValue of Object.values(value)) {
        if (!collectExpressionPropertyDependencies(childValue, neededProperties)) return false;
    }

    return true;
}
