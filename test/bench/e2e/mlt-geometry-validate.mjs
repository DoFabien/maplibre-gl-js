import assert from 'node:assert/strict';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {PNG} from 'pngjs';

const [directory, output, ...workerPaths] = process.argv.slice(2);
assert.ok(directory && output && !existsSync(output), 'Pass the browser directory, a new output JSON and optional worker reports');
const evidence = {};
function read(path) { const bytes = readFileSync(path); evidence[path] = hash(bytes); return bytes; }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function json(path) { return JSON.parse(read(path)); }
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function signature(features) { return hash(JSON.stringify(features.map(feature => JSON.stringify(canonical(feature))).sort())); }
function median(values) {
    const sorted = values.toSorted((a, b) => a - b);
    assert.ok(sorted.length && sorted.every(Number.isFinite));
    return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
}
function manifest(data) { for (const [path, expected] of Object.entries(data)) assert.equal(hash(read(path)), expected.sha256 ?? expected, path); }

/** Recomputes complete query signatures, exact image pairs and per-session timings, without inheriting a whole-product certificate. */
const browser = json(`${directory}/results.json`);
assert.equal(browser.status, 'passed');
const {runs, samples, warmup} = browser.options;
assert.ok(runs >= 3 && samples >= 20 && warmup >= 5, 'Pilot samples are not a repeated browser comparison');
assert.equal(browser.sessions.length, runs * 4);
const variantOrder = ['before/mvt', 'before/mlt', 'after/mvt', 'after/mlt'];
for (let run = 0; run < runs; run++) {
    assert.deepEqual(browser.sessions.filter(session => session.run === run).map(session => `${session.version}/${session.encoding}`),
        [...variantOrder.slice(run % 4), ...variantOrder.slice(0, run % 4)]);
}
for (const files of Object.values(browser.manifests)) manifest(files);
manifest(Object.fromEntries(Object.entries(browser.harnessHashes).map(([name, value]) => [`test/bench/e2e/${name}`, value])));
const references = new Map(); const images = new Map();
const metrics = ['firstRenderMs', 'settledMs', 'queryMs'];
for (const session of browser.sessions) {
    assert.deepEqual(session.phases.map(phase => phase.phase), ['native', 'overzoom']);
    if (browser.gpu === 'hardware') assert.doesNotMatch(session.info.renderer, /swiftshader|llvmpipe|software/i);
    for (const phase of session.phases) {
        assert.equal(phase.rows.length, samples);
        for (const row of [phase.first, ...phase.rows]) {
            for (const key of metrics) assert.ok(Number.isFinite(row[key]) && row[key] > 0);
            assert.ok(row.settledMs >= row.firstRenderMs);
            const identity = {counts: row.counts, hashes: row.hashes};
            if (references.has(phase.phase)) assert.deepEqual(identity, references.get(phase.phase));
            else references.set(phase.phase, identity);
        }
        const queries = JSON.parse(gunzipSync(read(phase.queries)));
        for (const name of ['source', 'rendered']) {
            assert.ok(queries[name].length > 0); assert.equal(queries[name].length, phase.first.counts[name]);
            assert.equal(signature(queries[name]), phase.first.hashes[name]);
        }
        const png = PNG.sync.read(read(phase.image)); assert.equal(png.width, 800); assert.equal(png.height, 600);
        if (images.has(phase.phase)) assert.deepEqual(png.data, images.get(phase.phase)); else images.set(phase.phase, png.data);
    }
}
const summary = []; const memory = [];
for (const version of ['before', 'after']) for (const encoding of ['mvt', 'mlt']) for (const phase of ['native', 'overzoom']) {
    const sessions = browser.sessions.filter(session => session.version === version && session.encoding === encoding);
    assert.equal(sessions.length, runs); assert.deepEqual(sessions.map(session => session.run).sort((a, b) => a - b), Array.from({length: runs}, (_, i) => i));
    const phases = sessions.map(session => session.phases.find(item => item.phase === phase));
    const sessionMedians = phases.map(item => Object.fromEntries(metrics.map(key => [key, median(item.rows.map(row => row[key]))])));
    summary.push({version, encoding, phase, sessionMedians, medianOfSessionMedians:
        Object.fromEntries(metrics.map(key => [key, median(sessionMedians.map(row => row[key]))]))});
    memory.push({version, encoding, phase, main: Object.fromEntries(['usedSize', 'backingStorageSize'].map(key =>
        [key, median(phases.map(item => item.heaps.main[key]))])), workers: Object.fromEntries(['usedSize', 'backingStorageSize'].map(key =>
        [key, median(phases.map(item => item.heaps.workers.reduce((sum, heap) => sum + heap[key], 0)))]))});
}
assert.deepEqual(browser.summary, summary);

/** Worker reports prove the captured position/triangle buffers and public-result hashes, not unrecorded paint/outline buffers or browser transfers. */
function workerReport(path) {
    const data = json(path); assert.equal(data.status, 'passed'); assert.ok(data.samples >= 30 && data.warmup >= 10);
    assert.ok(['native', 'overzoom'].includes(data.zoomMode));
    for (const encoding of ['mvt', 'mlt']) {
        const path = `test/integration/assets/tiles/${encoding === 'mlt' ? 'mlt/gl-js/' : ''}14-8802-5374.${encoding}`;
        assert.equal(hash(read(path)), data.fixtureHashes[encoding]);
    }
    const caches = data.zoomMode === 'native' ? ['fresh'] : ['cold', 'warm'];
    assert.equal(data.rows.length, data.samples * 4 * caches.length);
    for (const key of ['renderHash', 'queryHash']) assert.equal(new Set(data.rows.map(row => row[key])).size, 1);
    for (const moduleDirectory of [data.before, data.after]) {
        const module = json(`${moduleDirectory}/manifest.json`);
        assert.equal(hash(read(`${moduleDirectory}/pipeline.mjs`)), module.bundle);
        manifest(module.sources);
    }
    const results = [];
    for (const encoding of ['mvt', 'mlt']) for (const cache of caches) {
        const rows = {};
        for (const version of ['before', 'after']) {
            rows[version] = data.rows.filter(row => row.version === version && row.encoding === encoding && row.cache === cache);
            assert.equal(rows[version].length, data.samples);
            assert.deepEqual(rows[version].map(row => row.iteration).sort((a, b) => a - b), Array.from({length: data.samples}, (_, i) => i));
        }
        results.push({encoding, cache, beforeMs: median(rows.before.map(row => row.workerMs)), afterMs: median(rows.after.map(row => row.workerMs)),
            medianPairedRatio: median(rows.after.map(row => row.workerMs / rows.before.find(before => before.iteration === row.iteration).workerMs))});
    }
    return {path, zoomMode: data.zoomMode, results};
}

const workers = workerPaths.map(workerReport);
writeFileSync(output, JSON.stringify({status: 'verified-geometry-browser-comparison', checkedAt: new Date().toISOString(),
    scope: 'Repeated performance and exact captured parity only; not the complete test suite or universal style parity.',
    limitation: browser.limitation, scenario: browser.options.scenario, runs, samples, balancedVariantOrder: runs % 4 === 0,
    verifiedImages: browser.sessions.length * 2, nonReferenceImageComparisons: (browser.sessions.length - 1) * 2,
    summary, memory, workers, evidence}, null, 2));
console.log(`Verified ${browser.sessions.length} browser sessions and ${workers.length} worker reports`);
