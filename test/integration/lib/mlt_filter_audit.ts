import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {validateStyleMin, type FilterSpecification, type StyleSpecification} from '@maplibre/maplibre-gl-style-spec';
import {getMltFilterSupport} from '../../../src/data/filter/mlt/filter.ts';

type AuditStatus = 'supported' | 'valid-unsupported' | 'spec-invalid';
type AuditEntry = {
    fixture: string;
    operation: string;
    layer: string;
    type: string;
    mlt: boolean;
    filter: FilterSpecification;
    status: AuditStatus;
    reasons: string[];
};

/** Separates style-spec rejection from a missing columnar implementation. */
export function classifyFilter(filter: FilterSpecification, globalState: Record<string, unknown> = {}): Pick<AuditEntry, 'status' | 'reasons'> {
    const state = Object.fromEntries(Object.entries(globalState).map(([key, value]) => [key, {default: value}]));
    const style = {
        version: 8, state,
        sources: {audit: {type: 'vector', tiles: ['https://example.invalid/{z}/{x}/{y}.pbf']}},
        layers: [{id: 'audit', type: 'circle', source: 'audit', 'source-layer': 'audit', filter}]
    } as StyleSpecification;
    const errors = validateStyleMin(style);
    if (errors.length) return {status: 'spec-invalid', reasons: errors.map(error => error.message)};
    const support = getMltFilterSupport(filter, globalState);
    return 'reason' in support
        ? {status: 'valid-unsupported', reasons: [support.reason]}
        : {status: 'supported', reasons: []};
}

/** Recursively audits initial and dynamic filters, with state values at each operation. */
export function auditRenderFilters(root: string): {entries: AuditEntry[]; layers: Record<string, number>; fixtures: number} {
    const entries: AuditEntry[] = [];
    const layers: Record<string, number> = {};
    const files = readdirSync(root, {recursive: true, withFileTypes: true})
        .filter(entry => entry.isFile() && entry.name === 'style.json')
        .map(entry => path.join(entry.parentPath, entry.name)).sort();
    for (const file of files) {
        const style = JSON.parse(readFileSync(file, 'utf8'));
        const globalState = Object.fromEntries(Object.entries(style.state ?? {}).map(([key, spec]: [string, any]) => [key, spec.default]));
        const sourceMap = {...style.sources};
        const layerMap = new Map<string, any>();
        function recordLayer(layer: any, operation: string) {
            const source = sourceMap[layer.source];
            if (!source || !['vector', 'geojson'].includes(source.type)) return;
            const mlt = source.encoding === 'mlt';
            const key = `${mlt ? 'mlt' : 'reference'}:${layer.type}`;
            layers[key] = (layers[key] ?? 0) + 1;
            if (!layer.filter) return;
            entries.push({fixture: path.relative(root, file), operation, layer: layer.id, type: layer.type,
                mlt, filter: layer.filter, ...classifyFilter(layer.filter, globalState)});
        }
        for (const layer of style.layers ?? []) {
            layerMap.set(layer.id, layer);
            recordLayer(layer, 'initial');
        }
        for (const [index, operation] of (style.metadata?.test?.operations ?? []).entries()) {
            const [name, id, value] = operation;
            if (name === 'addSource') sourceMap[id] = value;
            if (name === 'setGlobalStateProperty') globalState[id] = value;
            if (name === 'addLayer') layerMap.set(id.id, id);
            if (name === 'removeLayer') layerMap.delete(id);
            if (name === 'setFilter' && layerMap.has(id)) layerMap.set(id, {...layerMap.get(id), filter: value});
            if (name === 'addLayer') recordLayer(id, `${index}:${name}`);
            if (name === 'setFilter' && layerMap.has(id)) recordLayer(layerMap.get(id), `${index}:${name}`);
            if (name === 'setGlobalStateProperty') {
                for (const layer of layerMap.values()) recordLayer(layer, `${index}:${name}`);
            }
        }
    }
    return {entries, layers, fixtures: files.length};
}

/** Writes the complete, reviewable matrix only when explicitly invoked with an output path. */
export function writeFilterAudit(output: string): void {
    const audit = auditRenderFilters('test/integration/render/tests');
    const counts = Object.fromEntries(['supported', 'valid-unsupported', 'spec-invalid'].map(status => [
        status, audit.entries.filter(entry => entry.status === status).length
    ]));
    writeFileSync(output, `${JSON.stringify({counts, ...audit}, null, 2)}\n`);
    console.log(JSON.stringify({counts, fixtures: audit.fixtures, layers: audit.layers}, null, 2));
}

if (process.env.MLT_FILTER_AUDIT_OUTPUT) writeFilterAudit(process.env.MLT_FILTER_AUDIT_OUTPUT);
