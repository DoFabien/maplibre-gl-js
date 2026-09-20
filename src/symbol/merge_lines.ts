import {
    appendColumnarFirstLine,
    getColumnarFirstLineEndpointKey,
    prependColumnarFirstLine,
} from './columnar_symbol_geometry.ts';

import type Point from '@mapbox/point-geometry';
import type {SymbolFeature} from '../data/bucket/symbol_bucket.ts';

type LineChunk = {
    points: Point[];
    next: LineChunk | null;
};

type MergedLine = {
    feature: SymbolFeature;
    first: LineChunk;
    last: LineChunk;
};

function getKey(text: string, line: MergedLine, onRight?: boolean) {
    const points = onRight ? line.last.points : line.first.points;
    const point = onRight ? points[points.length - 1] : points[0];
    return `${text}:${point.x}:${point.y}`;
}

function joinChunks(line: MergedLine): Point[] {
    const first = line.first.points;
    let length = first.length;
    for (let chunk = line.first.next; chunk; chunk = chunk.next) {
        length += chunk.points.length - 1;
    }

    const points = new Array<Point>(length);
    for (let i = 0; i < first.length; i++) {
        points[i] = first[i];
    }

    let at = first.length;
    for (let chunk = line.first.next; chunk; chunk = chunk.next) {
        const from = chunk.points;
        for (let i = 1; i < from.length; i++) {
            points[at++] = from[i];
        }
    }
    return points;
}

function mergeFromRight(merged: MergedLine[], rightIndex: Record<string, number>, leftKey: string, rightKey: string, line: MergedLine) {
    const i = rightIndex[leftKey];
    delete rightIndex[leftKey];
    rightIndex[rightKey] = i;

    const target = merged[i];
    target.last.next = line.first;
    target.last = line.last;
    return i;
}

function mergeFromLeft(merged: MergedLine[], leftIndex: Record<string, number>, leftKey: string, rightKey: string, line: MergedLine) {
    const i = leftIndex[rightKey];
    delete leftIndex[rightKey];
    leftIndex[leftKey] = i;

    const target = merged[i];
    line.last.next = target.first;
    target.first = line.first;
    return i;
}

export function mergeLines(features: SymbolFeature[]): SymbolFeature[] {
    if (features.some(feature => feature.columnarFeatureTable)) return mergeColumnarLines(features);
    const leftIndex: Record<string, number> = {};
    const rightIndex: Record<string, number> = {};
    const merged: MergedLine[] = [];

    for (const feature of features) {
        const text = feature.text ? feature.text.toString() : null;

        const chunk: LineChunk = {points: feature.geometry[0], next: null};
        const line: MergedLine = {feature, first: chunk, last: chunk};

        if (!text) {
            merged.push(line);
            continue;
        }

        const leftKey = getKey(text, line),
            rightKey = getKey(text, line, true);

        if ((leftKey in rightIndex) && (rightKey in leftIndex) && (rightIndex[leftKey] !== leftIndex[rightKey])) {
            // found lines with the same text adjacent to both ends of the current line, merge all three
            const j = mergeFromLeft(merged, leftIndex, leftKey, rightKey, line);
            const i = mergeFromRight(merged, rightIndex, leftKey, rightKey, merged[j]);

            delete leftIndex[leftKey];
            delete rightIndex[rightKey];

            rightIndex[getKey(text, merged[i], true)] = i;
            merged[j].feature.geometry = null;

        } else if (leftKey in rightIndex) {
            // found mergeable line adjacent to the start of the current line, merge
            mergeFromRight(merged, rightIndex, leftKey, rightKey, line);

        } else if (rightKey in leftIndex) {
            // found mergeable line adjacent to the end of the current line, merge
            mergeFromLeft(merged, leftIndex, leftKey, rightKey, line);

        } else {
            // no adjacent lines, add as a new item
            const i = merged.push(line) - 1;
            leftIndex[leftKey] = i;
            rightIndex[rightKey] = i;
        }
    }

    const result: SymbolFeature[] = [];
    for (const line of merged) {
        const feature = line.feature;
        if (!feature.geometry) continue;
        if (line.first.next) feature.geometry[0] = joinChunks(line);
        result.push(feature);
    }
    return result;
}

function mergeColumnarLines(features: SymbolFeature[]): SymbolFeature[] {
    const leftIndex = new Map<string, Map<number | string, number>>();
    const rightIndex = new Map<string, Map<number | string, number>>();
    const mergedFeatures: Array<SymbolFeature | null> = [];

    function add(k: number) {
        mergedFeatures.push(features[k]);
    }

    function get(index: Map<string, Map<number | string, number>>, text: string, endpoint: number | string): number | undefined {
        return index.get(text)?.get(endpoint);
    }

    function set(index: Map<string, Map<number | string, number>>, text: string, endpoint: number | string, value: number): void {
        let endpoints = index.get(text);
        if (!endpoints) {
            endpoints = new Map();
            index.set(text, endpoints);
        }
        endpoints.set(endpoint, value);
    }

    function remove(index: Map<string, Map<number | string, number>>, text: string, endpoint: number | string): void {
        const endpoints = index.get(text);
        if (!endpoints) return;
        endpoints.delete(endpoint);
        if (endpoints.size === 0) index.delete(text);
    }

    function compact(featuresToCompact: Array<SymbolFeature | null>): asserts featuresToCompact is SymbolFeature[] {
        let writeIndex = 0;
        for (const feature of featuresToCompact) {
            if (feature) featuresToCompact[writeIndex++] = feature;
        }
        featuresToCompact.length = writeIndex;
    }

    function mergeFirstLine(target: SymbolFeature, incoming: SymbolFeature, fromLeft: boolean): void {
        if (target.columnarFeatureTable || incoming.columnarFeatureTable) {
            if (!target.columnarFeatureTable || !incoming.columnarFeatureTable) {
                throw new Error('Cannot merge legacy and columnar symbol lines');
            }
            if (fromLeft) {
                prependColumnarFirstLine(target, incoming);
            } else {
                appendColumnarFirstLine(target, incoming);
            }
            return;
        }

        if (fromLeft) {
            target.geometry[0].shift();
            target.geometry[0] = incoming.geometry[0].concat(target.geometry[0]);
        } else {
            target.geometry[0].pop();
            target.geometry[0] = target.geometry[0].concat(incoming.geometry[0]);
        }
    }

    function mergeFromRight(text: string, leftKey: number | string, rightKey: number | string, incoming: SymbolFeature) {
        const i = get(rightIndex, text, leftKey);
        remove(rightIndex, text, leftKey);
        set(rightIndex, text, rightKey, i);

        mergeFirstLine(mergedFeatures[i], incoming, false);
        return i;
    }

    function mergeFromLeft(text: string, leftKey: number | string, rightKey: number | string, incoming: SymbolFeature) {
        const i = get(leftIndex, text, rightKey);
        remove(leftIndex, text, rightKey);
        set(leftIndex, text, leftKey, i);

        mergeFirstLine(mergedFeatures[i], incoming, true);
        return i;
    }

    function getKey(feature: SymbolFeature, onRight = false): number | string {
        if (feature.columnarFeatureTable) {
            return getColumnarFirstLineEndpointKey(feature, onRight);
        }
        const geometry = feature.geometry;
        const point = onRight ? geometry[0][geometry[0].length - 1] : geometry[0][0];
        return `${point.x}:${point.y}`;
    }

    for (let k = 0; k < features.length; k++) {
        const feature = features[k];
        const text = feature.text ? feature.text.toString() : null;

        if (!text) {
            add(k);
            continue;
        }

        const leftKey = getKey(feature),
            rightKey = getKey(feature, true);
        const rightMatch = get(rightIndex, text, leftKey);
        const leftMatch = get(leftIndex, text, rightKey);

        if (rightMatch !== undefined && leftMatch !== undefined && rightMatch !== leftMatch) {
            // found lines with the same text adjacent to both ends of the current line, merge all three
            const j = mergeFromLeft(text, leftKey, rightKey, feature);
            const middle = mergedFeatures[j];
            const i = mergeFromRight(text, leftKey, rightKey, middle);

            remove(leftIndex, text, leftKey);
            remove(rightIndex, text, rightKey);

            set(rightIndex, text, getKey(mergedFeatures[i], true), i);
            mergedFeatures[j] = null;

        } else if (rightMatch !== undefined) {
            // found mergeable line adjacent to the start of the current line, merge
            mergeFromRight(text, leftKey, rightKey, feature);

        } else if (leftMatch !== undefined) {
            // found mergeable line adjacent to the end of the current line, merge
            mergeFromLeft(text, leftKey, rightKey, feature);

        } else {
            // no adjacent lines, add as a new item
            add(k);
            const mergedIndex = mergedFeatures.length - 1;
            set(leftIndex, text, leftKey, mergedIndex);
            set(rightIndex, text, rightKey, mergedIndex);
        }
    }

    compact(mergedFeatures);
    return mergedFeatures;
}
