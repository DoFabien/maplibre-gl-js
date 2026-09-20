import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance as clock} from 'node:perf_hooks';
import {expect, test} from 'vitest';
import {fakeServer} from 'nise';
import {setPerformance} from '../../../src/util/test/util.ts';
import type * as API from './mlt-direct-module.ts';
import type {WorkerTileParameters, WorkerTileWithData} from '../../../src/source/worker_source.ts';

/** Alternates frozen/current APIs over identical fixture bytes at native zoom or overzoom; browser/GPU costs are outside this diagnostic. */
test('measures worker, transfer and first-query costs without weakening MVT parity', async () => {
    const output = process.env.MLT_DIRECT_OUTPUT; const before = process.env.MLT_DIRECT_BEFORE; const after = process.env.MLT_DIRECT_AFTER;
    assert.ok(output && before && after && !existsSync(output), 'Pass frozen/current module directories and a new result path');
    const zoomMode = process.env.MLT_DIRECT_ZOOM ?? 'overzoom';
    assert.ok(['native', 'overzoom'].includes(zoomMode));
    const native = zoomMode === 'native';
    const [z, x, y] = native ? [14, 8802, 5374] : [15, 17604, 10748];
    const modules = {} as Record<string, typeof API>;
    for (const [version, directory] of Object.entries({before, after})) {
        const manifest = JSON.parse(readFileSync(`${directory}/manifest.json`, 'utf8'));
        assert.equal(hash(readFileSync(`${directory}/pipeline.mjs`)), manifest.bundle);
        modules[version] = await import(/* @vite-ignore */ pathToFileURL(resolve(directory, 'pipeline.mjs')).href);
    }
    global.fetch = null; setPerformance(); const server = fakeServer.create();
    let response: ArrayBuffer;
    server.respondWith(request => { request.respond(200, {}, response as any); return true; });
    const raw = Object.fromEntries(['mvt', 'mlt'].map(encoding => [encoding, Uint8Array.from(readFileSync(
        `test/integration/assets/tiles/${encoding === 'mlt' ? 'mlt/gl-js/' : ''}14-8802-5374.${encoding}`)).buffer]));
    const rows = []; const variants = [];
    const layers = [
        {id: 'building', source: 'source', 'source-layer': 'building', type: 'fill'},
        {id: 'road', source: 'source', 'source-layer': 'road', type: 'line', paint: {'line-width': ['match', ['get', 'class'], 'main', 4, 2]}},
    ] as const;
    for (const version of ['before', 'after']) for (const encoding of ['mvt', 'mlt'] as const) for (const cache of native ? ['fresh'] : ['cold', 'warm']) {
        const api = modules[version];
        variants.push({version, encoding, cache, api,
            source: new api.VectorTileWorkerSource({sendAsync: async () => ({})}, new api.StyleLayerIndex(layers as any), [])});
    }
    const reference = new Map<string, string>();
    try {
        for (let iteration = -10; iteration < 30; iteration++) {
            const offset = (iteration + 10) % variants.length;
            for (const variant of [...variants.slice(offset), ...variants.slice(0, offset)]) {
                const {api, source, encoding, cache, version} = variant;
                if (cache === 'cold') source.overzoomedTileResultCache.clear();
                response = raw[encoding];
                const params = {uid: 'measured', encoding, source: 'source', zoom: z, tileSize: 512, pixelRatio: 1,
                    tileID: new api.OverscaledTileID(z, 0, z, x, y),
                    subdivisionGranularity: api.SubdivisionGranularitySetting.noSubdivision,
                    ...(native ? {request: {url: 'http://localhost/native'}} : {
                        overzoomParameters: {maxZoomTileID: new api.CanonicalTileID(14, 8802, 5374), overzoomRequest: {url: 'http://localhost/parent'}}
                    })
                } as WorkerTileParameters;
                const start = clock.now(); const pending = source.loadTile(params); server.respond();
                const result = await pending as WorkerTileWithData; const workerMs = clock.now() - start;
                const renderHash = hash(JSON.stringify(result.buckets.map(bucket => {
                    const b = bucket as any;
                    return [bytes(b.layoutVertexArray), bytes(b.indexArray)];
                })));
                const transferables: Transferable[] = []; const rawBytes = result.rawTileData.byteLength;
                const transferStart = clock.now(); const serialized = api.serialize(result, transferables);
                const transferredBytes = [...new Set(transferables)].reduce<number>((sum, item) => sum + (item instanceof ArrayBuffer ? item.byteLength : 0), 0);
                const received = api.deserialize(structuredClone(serialized, {transfer: [...new Set(transferables)]})) as WorkerTileWithData;
                const transferMs = clock.now() - transferStart;
                received.featureIndex.encoding = encoding; received.featureIndex.rawTileData = received.rawTileData;
                const queryStart = clock.now(); const queryLayers = received.featureIndex.loadVTLayers(); const features = [];
                for (const name of ['building', 'road']) {
                    const layer = queryLayers[name];
                    for (let i = 0; i < layer.length; i++) {
                        const feature = layer.feature(i);
                        features.push({layer: name, feature: new api.GeoJSONFeature(feature, z, x, y, feature.id).toJSON()});
                    }
                }
                const firstQueryMs = clock.now() - queryStart;
                const queryHash = hash(JSON.stringify(features.map(canonical).map(value => JSON.stringify(value)).sort()));
                for (const [kind, value] of Object.entries({renderHash, queryHash})) {
                    if (!reference.has(kind)) reference.set(kind, value);
                    assert.equal(value, reference.get(kind), `${version}/${encoding}/${cache}/${kind}`);
                }
                if (iteration >= 0) rows.push({iteration, version, encoding, cache, workerMs, transferMs, firstQueryMs,
                    rawBytes, transferredBytes, cacheBudgetBytes: source.overzoomedTileResultCache.stats.bytes,
                    renderHash, queryHash, queryCount: features.length});
                await source.removeTile(params);
            }
        }
        expect(rows).toHaveLength(30 * variants.length);
        writeFileSync(output, JSON.stringify({status: 'passed', zoomMode, warmup: 10, samples: 30, rows,
            before, after, node: process.version, fixtureHashes: Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, hash(new Uint8Array(value))])),
            limitation: 'Node/jsdom fake HTTP, bundled unminified worker APIs; no GPU upload, presentation or browser timing. Overzoom cold explicitly clears the worker cache; native uses fresh loads, without a decoded native-tile cache. This direct WorkerSource diagnostic does not acknowledge parent IDs or install the main-thread parent registry: all raw bytes are returned and queries use the independent fallback, not the shared browser protocol. Query and transfer measured separately; captures outside timed work.'}, null, 2));
    } finally { server.restore(); }
});

function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function bytes(array: {arrayBuffer: ArrayBuffer; length: number; bytesPerElement: number}): string {
    return hash(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
}
