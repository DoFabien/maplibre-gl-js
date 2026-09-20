import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {gzipSync, gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';

const [output, parityDirectory, browserDirectory, pipelinePath] = process.argv.slice(2);
assert.ok(pipelinePath, 'Use a new output, parity certificate directory, browser directory and isolated pipeline JSON');
mkdirSync(output);
const evidence = {};
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function read(path) { const bytes = readFileSync(path); evidence[path] = hash(bytes); return bytes; }
function json(path) { return JSON.parse(read(path)); }
function archive(name, path) { writeFileSync(`${output}/${name}.gz`, gzipSync(read(path))); }
function failures(report) { return report.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed').map(test => test.fullName)).sort(); }
function median(values) { const sorted = values.toSorted((a, b) => a - b); return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2; }

/** Consolidates current evidence; known GPU baseline failures remain failures rather than becoming passes. */
const report = {status: 'running', checkedAt: new Date().toISOString(), evidence};
try {
    const parity = json(`${parityDirectory}/validation.json`);
    assert.equal(parity.status, 'verified-direct-overzoom-parity');
    for (const [path, expected] of Object.entries(parity.sourceManifest)) assert.equal(hash(read(path)), expected);
    const gpuPath = '/tmp/mlt-direct-render-gpu-full-20260908.json';
    const gpu = json(gpuPath);
    const previousPath = 'test/bench/baselines/browser-motion-production-v3-20260907/gpu.json.gz';
    const previous = JSON.parse(gunzipSync(read(previousPath)));
    assert.equal(gpu.numTotalTests, 1923); assert.equal(gpu.numPendingTests, 0);
    assert.equal(gpu.numPassedTests, 1887); assert.equal(gpu.numFailedTests, 36);
    assert.deepEqual(failures(gpu), failures(previous));
    const countersPath = '/tmp/mlt-direct-render-gpu-workers-20260908.json';
    const counters = json(countersPath); assert.equal(Object.keys(counters).length, 1923);
    const forbidden = ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers', 'propertyObjects', 'pointObjects',
        'geometryPartsMaterialized', 'overzoomPointObjects', 'mvtReencodes', 'rawTileMainThreadDecodes', 'coordinateTuples', 'propertyDescriptors', 'propertyProxyMisses'];
    for (const workers of Object.values(counters)) for (const snapshot of workers) {
        for (const key of forbidden) assert.equal(snapshot[key], 0);
    }
    archive('gpu', gpuPath); archive('gpu-workers', countersPath);
    archive('gpu-metadata', '/tmp/mlt-direct-render-gpu-metadata-20260908.json');
    for (const path of ['dist/maplibre-gl-dev.mjs', 'dist/maplibre-gl-worker-dev.mjs', 'dist/maplibre-gl-shared-dev.mjs',
        'dist/mlt-validation/maplibre-gl-dev.mjs', 'dist/mlt-validation/maplibre-gl-worker-dev.mjs', 'dist/mlt-validation/maplibre-gl-shared-dev.mjs']) read(path);
    report.gpu = {passed: gpu.numPassedTests, failed: failures(gpu), newlyFailing: [], previousPath};
    const browser = json(`${browserDirectory}/results.json`);
    assert.equal(browser.status, 'passed'); assert.equal(browser.sessions.length, 12);
    for (const manifest of Object.values(browser.manifests)) for (const [path, expected] of Object.entries(manifest)) assert.equal(hash(read(path)), expected.sha256);
    const queryHashes = new Set(); let image;
    for (const session of browser.sessions) {
        assert.equal(session.rows.length, 40);
        for (const cache of ['cold', 'warm']) assert.equal(session.rows.filter(row => row.cache === cache).length, 20);
        for (const row of session.rows) {
            assert.ok(row.firstRenderMs > 0 && row.firstQueryMs > 0);
            assert.ok(row.counts.source > 0 && row.counts.rendered > 0); queryHashes.add(JSON.stringify(row.hashes));
        }
        const png = PNG.sync.read(read(session.image)); image ??= png.data; assert.deepEqual(png.data, image);
    }
    assert.equal(queryHashes.size, 1);
    report.browser = [];
    for (const version of ['before', 'after']) for (const encoding of ['mvt', 'mlt']) for (const cache of ['cold', 'warm']) {
        const sessions = browser.sessions.filter(session => session.version === version && session.encoding === encoding);
        const medians = sessions.map(session => Object.fromEntries(['firstRenderMs', 'idleMs', 'firstQueryMs'].map(key =>
            [key, median(session.rows.filter(row => row.cache === cache).map(row => row[key]))])));
        report.browser.push({version, encoding, cache, sessionMedians: medians,
            medianOfSessionMedians: Object.fromEntries(Object.keys(medians[0]).map(key => [key, median(medians.map(row => row[key]))]))});
    }
    const pipeline = json(pipelinePath); assert.equal(pipeline.status, 'passed'); assert.equal(pipeline.rows.length, 240);
    for (const name of ['renderHash', 'queryHash']) assert.equal(new Set(pipeline.rows.map(row => row[name])).size, 1);
    for (const directory of [pipeline.before, pipeline.after]) {
        const manifest = json(`${directory}/manifest.json`); assert.equal(hash(read(`${directory}/pipeline.mjs`)), manifest.bundle);
    }
    archive('browser', `${browserDirectory}/results.json`); archive('pipeline', pipelinePath);
    read('test/bench/baselines/direct-overzoom-before-20260908/workspace.tar.gz');
    archive('finalizer.mjs', 'test/bench/e2e/mlt-direct-finalize.mjs');
    report.status = 'qualified-with-known-gpu-baseline-failures-and-performance-tradeoffs';
} catch (error) { report.status = 'failed'; report.error = String(error); process.exitCode = 1; }
writeFileSync(`${output}/qualification.json`, JSON.stringify(report, null, 2));
console.log(report.status);
