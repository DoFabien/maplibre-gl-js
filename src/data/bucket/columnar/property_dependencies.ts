import {expression as styleExpression} from '@maplibre/maplibre-gl-style-spec';
import {GEOJSONVT_CLIP_END, GEOJSONVT_CLIP_START} from '@maplibre/geojson-vt';

import type {StyleLayer} from '../../../style/style_layer.ts';

/** Expression operators that read a feature other than through its properties. */
const FEATURE_ACCESSORS = new Set(['id', 'geometry-type', 'within', 'distance', 'accumulated', 'line-progress', 'heatmap-density']);

/** What a style value reads of a feature: the properties it names, and whether it reads anything else. */
type FeatureReads = {
    names: Set<string>;
    otherData: boolean;
};

/**
 * Adds to `reads` what a style value reads of a feature: an expression, a legacy function, or a string with
 * `{token}`s. Returns false when the value reads properties it does not name, through `["properties"]` or a
 * `["get"]` or `["has"]` of a computed name.
 */
function read(value: unknown, reads: FeatureReads): boolean {
    if (typeof value === 'string') {
        for (const match of value.matchAll(/{([^{}]+)}/g)) reads.names.add(match[1]);
        return true;
    }
    if (Array.isArray(value)) {
        const operator = value[0];
        if (operator === 'literal') return true;
        if (operator === 'properties') return false;
        if (operator === 'get' || operator === 'has') {
            if (value.length !== 2 || typeof value[1] !== 'string') return false;
            reads.names.add(value[1]);
            return true;
        }
        if (FEATURE_ACCESSORS.has(operator)) reads.otherData = true;
        return value.every((item, index) => index === 0 || read(item, reads));
    }
    if (value && typeof value === 'object') {
        const property = (value as {property?: unknown}).property;
        if (typeof property === 'string') reads.names.add(property);
        else if (property !== undefined) return false;
        return Object.values(value).every(item => read(item, reads));
    }
    return true;
}

/** Adds to `reads` what a layer filter reads, in the legacy syntax, where a string names a property, or as an expression. */
function readFilter(filter: unknown, reads: FeatureReads): boolean {
    if (styleExpression.isExpressionFilter(filter)) return read(filter, reads);
    if (!Array.isArray(filter)) return true;
    const [operator, key] = filter;
    if (operator === 'all' || operator === 'any' || operator === 'none') {
        return filter.slice(1).every(child => readFilter(child, reads));
    }
    if (typeof key === 'string' && key !== '$type' && key !== '$id') reads.names.add(key);
    return true;
}

/**
 * The properties a data-driven paint or layout value reads, when they are all it reads of a feature, or null
 * when it also reads the id, the geometry or properties it does not name.
 */
export function readOnlyPropertyNames(value: unknown): Set<string> | null {
    const reads: FeatureReads = {names: new Set(), otherData: false};
    return read(value, reads) && !reads.otherData ? reads.names : null;
}

/**
 * The properties a layer reads in its filter, layout and paint, or null when it reads properties it does not
 * name. A line gradient reads the clip columns of the line.
 */
export function collectLayerPropertyDependencies(layer: StyleLayer): Set<string> | null {
    const reads: FeatureReads = {names: new Set(), otherData: false};
    const {layout, paint} = layer.serialize();
    if (!readFilter(layer.filter, reads) || !read(layout ?? {}, reads) || !read(paint ?? {}, reads)) return null;
    if (layer.type === 'line' && paint?.['line-gradient'] !== undefined) {
        reads.names.add(GEOJSONVT_CLIP_START);
        reads.names.add(GEOJSONVT_CLIP_END);
    }
    return reads.names;
}
