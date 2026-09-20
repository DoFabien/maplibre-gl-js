import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {difference, signature} from './mlt-geography.ts';

const directory = 'test/bench/baselines/pretriangulated-checkpoint-20260908';
assert.ok(!existsSync(`${directory}/checkpoint.json`), 'Preserve the existing certificate');
const evidence = {};
const forbidden = ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers', 'propertyObjects', 'propertyProxyMisses',
    'pointObjects', 'geometryPartsMaterialized', 'overzoomPointObjects', 'mvtReencodes', 'rawTileMainThreadDecodes', 'coordinateTuples', 'propertyDescriptors'];

/** Hashes every input consumed by this audit. */
function read(path) { const bytes = readFileSync(path); evidence[path] = hash(bytes); return bytes; }
function json(path) { return JSON.parse(read(path)); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function manifest(values) { for (const [path, value] of Object.entries(values)) assert.equal(hash(read(path)), value.sha256 ?? value, path); }
function counters(values) { for (const name of forbidden) assert.equal(values[name], 0, name); }
function image(first, second) { read(first); read(second); assert.equal(difference(first, second).pixels, 0); }
function median(values) { const sorted = values.toSorted((a, b) => a - b); return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2; }
function sources(root, relative = '') {
    const result = {};
    for (const entry of readdirSync(`${root}/${relative}`, {withFileTypes: true})) {
        const path = `${relative}${entry.name}`;
        if (entry.isDirectory()) Object.assign(result, sources(root, `${path}/`));
        else if (entry.isFile()) result[path] = hash(readFileSync(`${root}/${path}`));
    }
    return result;
}

const suites = {};
for (const [name, count] of [['unit-final', 3788], ['integration', 178], ['build-final', 759], ['render-software', 243]]) {
    const path = `/tmp/mlt-pretriangulated-${name}-20260908.json`;
    const report = json(path);
    assert.equal(report.success, true); assert.equal(report.numPassedTests, count); assert.equal(report.numFailedTests, 0);
    suites[name] = {path, passed: count, pending: report.numPendingTests};
}
const gpu = json(`${directory}/gpu-comparison.json`);
assert.equal(gpu.status, 'same-seven-failures-and-exact-images');
assert.equal(hash(read(gpu.archive)), gpu.sha256); assert.equal(hash(read(gpu.reportPath)), gpu.reportSha256);
suites.gpu = {passed: 236, failed: 7, pending: 1680, unchangedFailureNamesAndImages: true};
for (const mode of ['gpu', 'software']) {
    const stats = json(`/tmp/mlt-pretriangulated-render-${mode}-workers-20260908.json`);
    assert.equal(Object.keys(stats).length, 243);
    for (const values of Object.values(stats).flat()) counters(values);
    const metadata = json(`/tmp/mlt-pretriangulated-render-${mode}-metadata-20260908.json`);
    assert.equal(metadata.strict, true);
}
const sizeCheck = json('/tmp/mlt-pretriangulated-build-size-initial-20260908.json');
assert.equal(sizeCheck.numPassedTests, 3); assert.equal(sizeCheck.numFailedTests, 1);
const sourceHashes = {gl: sources('src'), mlt: sources('../maplibre-tile-spec/ts/src')};
const before = json('test/bench/baselines/owned-indices-checkpoint-20260908/checkpoint.json');
assert.deepEqual(sourceHashes.mlt, before.sources.mlt);
for (const path of ['dist/maplibre-gl-shared.mjs.map', 'dist/maplibre-gl-shared-dev.mjs.map',
    'dist/mlt-validation/maplibre-gl-shared.mjs.map', 'dist/mlt-validation/maplibre-gl-shared-dev.mjs.map']) {
    const map = json(path);
    for (const name of ['pretriangulated_fill.ts', 'columnar_fill_bucket.ts']) {
        const index = map.sources.findIndex(value => value.endsWith(`/src/data/bucket/columnar/${name}`));
        assert.ok(index >= 0); assert.equal(map.sourcesContent[index], readFileSync(`src/data/bucket/columnar/${name}`, 'utf8'));
    }
}
const geography = {};
for (const [mode, suffix] of [['gpu', 'final-gpu'], ['software', 'software']]) {
    const root = `test/bench/baselines/browser-pretriangulated-geography-${suffix}-20260908`;
    const report = json(`${root}/results.json`);
    assert.equal(report.status, 'passed'); assert.equal(report.strict, true); assert.equal(report.steps.length, 23);
    manifest(report.manifest); manifest(report.harnessHashes);
    assert.deepEqual(report.sessions.mlt.checkpoints, report.sessions.mvt.checkpoints);
    for (const step of report.steps) {
        image(`${root}/mlt-${step.name}.png`, `${root}/mvt-${step.name}.png`);
        for (const encoding of ['mvt', 'mlt']) {
            const queries = JSON.parse(gunzipSync(read(`${root}/${encoding}-${step.name}.json.gz`)));
            const checkpoint = report.sessions[encoding].checkpoints[step.name];
            for (const [key, features] of Object.entries({...queries.source, rendered: queries.rendered})) {
                assert.equal(features.length, checkpoint.counts[key]); assert.equal(signature(features), checkpoint.hashes[key]);
            }
        }
    }
    for (const encoding of ['mvt', 'mlt']) {
        const session = report.sessions[encoding];
        assert.equal(session.repeats.length, report.cycles * 9);
        for (const repeat of session.repeats) assert.deepEqual(repeat.summary, session.checkpoints[repeat.name]);
        for (const snapshot of session.stats) for (const worker of snapshot.workers) counters(worker.counters);
    }
    const initial = report.sessions.mlt.stats[0].workers[0].counters;
    assert.equal(initial.pretriangulatedFillFeatures, 4925); assert.equal(initial.pretriangulatedFillTriangles, 27364);
    geography[mode] = {pairs: 23, repeatedStepsPerEncoding: report.cycles * 9, initialDirectFeatures: 4925, initialDirectTriangles: 27364};
}
const styleRoot = 'test/bench/baselines/browser-pretriangulated-styles-gpu-20260908';
const styles = json(`${styleRoot}/results.json`);
assert.equal(styles.status, 'passed'); assert.equal(styles.strict, true); assert.equal(Object.keys(styles.images).length, 25);
manifest(styles.manifest); manifest(styles.harnessHashes);
assert.deepEqual(styles.correctness.mvt.checkpoints, styles.correctness.mlt.checkpoints);
for (const encoding of ['mvt', 'mlt']) for (const worker of styles.correctness[encoding].workerStats) counters(worker.counters);
assert.ok(styles.correctness.mlt.workerStats.at(-1).counters.pretriangulatedFillFeatures > 0);
for (const name of Object.keys(styles.images)) image(`${styleRoot}/mlt-${name}.png`, `${styleRoot}/mvt-${name}.png`);

const comparison = json('test/bench/baselines/pretriangulated-browser-comparison-20260908.json');
assert.equal(comparison.status, 'verified-geometry-browser-comparison'); assert.equal(comparison.verifiedImages, 32); manifest(comparison.evidence);
const allocationRoot = 'test/bench/baselines/browser-pretriangulated-allocations-20260908';
execFileSync(process.execPath, ['test/bench/e2e/mlt-allocation-profile.ts', '--verify', allocationRoot], {stdio: 'inherit'});
const allocations = json(`${allocationRoot}/results.json`);
const memory = {};
for (const encoding of ['mvt', 'mlt']) for (const version of ['before', 'after']) {
    const sessions = allocations.sessions.filter(session => session.encoding === encoding && session.version === version);
    memory[`${version}-${encoding}`] = median(sessions.map(session => session.profiles.find(profile => profile.context === 'worker').summary.totalBytes));
}
const encoding = json('test/bench/baselines/pretriangulated-encoding-audit-20260908/final/manifest.json');
for (const tile of encoding.tiles) assert.deepEqual(tile.existingMlt, tile.pretriangulated);
const bufferBytes = {before: 0, after: 0};
for (const tile of encoding.tiles) for (const layer of json(`test/bench/baselines/pretriangulated-buffer-sizes-20260908/${tile.name}.json`).buffers) {
    bufferBytes.before += layer.before.bytes; bufferBytes.after += layer.after.bytes;
}
assert.deepEqual(bufferBytes, {before: 461526, after: 461534});

const workspace = `${directory}/workspace.tar.gz`;
execFileSync('tar', ['-czf', workspace, '-C', '/data/Projet/maplibre',
    'maplibre-gl-js/src', 'maplibre-gl-js/dist', 'maplibre-gl-js/test/build/bundle_size.json',
    'maplibre-gl-js/package.json', 'maplibre-gl-js/package-lock.json', 'maplibre-tile-spec/ts/src', 'maplibre-tile-spec/ts/dist']);
const validation = `${directory}/validation-artifacts.tar.gz`;
const reports = Object.keys(evidence).filter(path => path.startsWith('/tmp/')).map(path => path.slice(5));
execFileSync('tar', ['-czf', validation, '-C', '/tmp', ...reports]);
writeFileSync(`${directory}/checkpoint.json`, JSON.stringify({status: 'validated-native-pretriangulated-fill-experiment',
    createdAt: new Date().toISOString(), commitsBefore: {gl: '4ac9eb198', mlt: 'ddf28400'}, suites, geography,
    stylePairs: 25, geometryBytes: bufferBytes, medianWorkerAllocationBytes: memory,
    performance: comparison.summary,
    limitation: 'Native-zoom Mercator fast path only. One balanced campaign: native -6%, warm overzoom +7.1%; no global speedup claim. GPU full suite not rerun; seven selected failures unchanged. Allocation estimates are not exact or retained bytes.',
    sources: sourceHashes, archives: {[workspace]: hash(read(workspace)), [validation]: hash(read(validation))}, evidence}, null, 2));
console.log(JSON.stringify({suites, geography, bufferBytes, memory}, null, 2));
