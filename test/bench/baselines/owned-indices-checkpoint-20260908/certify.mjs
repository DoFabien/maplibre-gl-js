import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gunzipSync, gzipSync} from 'node:zlib';
import {PNG} from 'pngjs';

const directory = 'test/bench/baselines/owned-indices-checkpoint-20260908';
assert.ok(!existsSync(`${directory}/checkpoint.json`), 'Use the preserved certificate rather than overwriting it');
const forbidden = ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers', 'propertyObjects', 'pointObjects',
    'geometryPartsMaterialized', 'overzoomPointObjects', 'mvtReencodes', 'rawTileMainThreadDecodes', 'coordinateTuples', 'propertyDescriptors'];
const evidence = {};

/** Hashes the complete bytes of an input or archive. */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
/** Records each input read by this audit. */
function read(path) { const bytes = readFileSync(path); evidence[path] = hash(bytes); return bytes; }
/** Reads a JSON input with its content hash. */
function json(path) { return JSON.parse(read(path)); }
/** Canonicalizes object keys while preserving feature array contents. */
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
/** Uses the same order-independent complete-feature signature as the capture harness. */
function signature(features) { return hash(JSON.stringify(features.map(feature => JSON.stringify(canonical(feature))).sort())); }
/** Checks recorded bundles, fixtures and harnesses against their bytes. */
function manifest(files) { for (const [path, expected] of Object.entries(files)) assert.equal(hash(read(path)), expected.sha256 ?? expected, path); }
/** Requires exact decoded PNG equality without tolerances. */
function sameImage(first, second) {
    const images = [first, second].map(path => PNG.sync.read(read(path)));
    for (const image of images) { assert.equal(image.width, 800); assert.equal(image.height, 600); }
    assert.deepEqual(images[0].data, images[1].data);
}
/** Checks every instrumented materialization boundary and proxy misses. */
function counters(values) { for (const key of [...forbidden, 'propertyProxyMisses']) assert.equal(values[key], 0, key); }
/** Records the complete current source tree without depending on Git tracking status. */
function sources(root, relative = '') {
    const result = {};
    for (const entry of readdirSync(`${root}/${relative}`, {withFileTypes: true})) {
        const path = `${relative}${entry.name}`;
        if (entry.isDirectory()) Object.assign(result, sources(root, `${path}/`));
        else if (entry.isFile()) result[path] = hash(readFileSync(`${root}/${path}`));
    }
    return result;
}

const current = {gl: sources('src'), mlt: sources('../maplibre-tile-spec/ts/src')};
const before = json('test/bench/baselines/clipping-stream-checkpoint-20260908/checkpoint.json');
const delta = {};
for (const name of ['gl', 'mlt']) {
    assert.deepEqual(Object.keys(current[name]).sort(), Object.keys(before.sources[name]).sort());
    delta[name] = Object.keys(current[name]).filter(path => current[name][path] !== before.sources[name][path]).sort();
}
assert.deepEqual(delta, {gl: ['render/subdivision.test.ts', 'render/subdivision.ts'], mlt: []});
const changedSource = readFileSync('src/render/subdivision.ts', 'utf8');
for (const path of ['dist/maplibre-gl-shared.mjs.map', 'dist/mlt-validation/maplibre-gl-shared.mjs.map']) {
    const map = json(path); const index = map.sources.findIndex(source => source.endsWith('/src/render/subdivision.ts'));
    assert.ok(index >= 0); assert.equal(map.sourcesContent[index], changedSource);
}

const suites = {};
for (const [name, count] of [['unit-full', 3773], ['integration', 178], ['build-tests-final', 759], ['render-software', 243]]) {
    const path = `/tmp/mlt-owned-indices-${name}-20260908.json`; const report = json(path);
    assert.equal(report.numPassedTests, count); assert.equal(report.numFailedTests, 0); assert.equal(report.success, true);
    suites[name] = {path, sha256: evidence[path], passed: count, pending: report.numPendingTests};
}
const gpu = json('/tmp/mlt-owned-indices-render-gpu-20260908.json');
const previousGpu = json('/tmp/mlt-clipping-render-gpu-20260908.json');
/** Extracts executed failures without treating unselected fixtures as successes. */
function failures(report) { return report.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed').map(test => test.fullName)).sort(); }
assert.equal(gpu.numPassedTests, 236); assert.equal(gpu.numFailedTests, 7); assert.equal(gpu.numPendingTests, 1680);
assert.deepEqual(failures(gpu), failures(previousGpu).filter(name => name.includes('tests/mlt/')));
const gpuImages = json(`${directory}/gpu-comparison.json`);
assert.equal(gpuImages.images.length, 7); assert.deepEqual(gpuImages.images.map(image => image.name), failures(gpu));
for (const image of gpuImages.images) assert.equal(image.pixels, 0);
assert.equal(hash(read(gpuImages.archive)), gpuImages.sha256);
for (const name of failures(gpu)) {
    const path = `${name.replace('Render tests ', 'test/integration/render/')}/actual.png`;
    const captured = PNG.sync.read(execFileSync('tar', ['-xOf', gpuImages.archive, path]));
    const previous = PNG.sync.read(execFileSync('tar', ['-xOf', 'test/bench/baselines/clipping-stream-checkpoint-20260908/gpu-failure-images.tar.gz', path]));
    assert.equal(captured.width, previous.width); assert.equal(captured.height, previous.height); assert.deepEqual(captured.data, previous.data);
}
suites['render-gpu'] = {path: '/tmp/mlt-owned-indices-render-gpu-20260908.json', passed: 236, failed: 7, pending: 1680, unchangedFailureNamesAndImages: true};
for (const mode of ['gpu', 'software']) {
    const report = json(`/tmp/mlt-owned-indices-render-${mode}-workers-20260908.json`);
    assert.equal(Object.keys(report).length, 243);
    const workers = Object.values(report).flat(); assert.ok(workers.length > 0);
    for (const worker of workers) counters(worker);
    assert.ok(workers.reduce((sum, worker) => sum + worker.decodedLayers, 0) > 0);
    const metadata = json(`/tmp/mlt-owned-indices-render-${mode}-metadata-20260908.json`);
    assert.equal(metadata.strict, true); assert.equal(metadata.mode, mode === 'gpu' ? 'hardware' : 'software');
}
const initial = json('/tmp/mlt-owned-indices-build-tests-initial-20260908.json');
assert.equal(initial.numFailedTests, 1);
assert.deepEqual(initial.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed').map(test => test.fullName)),
    ['production bundle dist/maplibre-gl-shared.mjs bundle size stays the same']);
const bundleSizes = json('test/build/bundle_size.json');
for (const [path, size] of Object.entries(bundleSizes)) { const bytes = read(path); assert.deepEqual(size, {raw: bytes.length, gzip: gzipSync(bytes).length}); }

const geography = {};
for (const mode of ['gpu', 'software']) {
    const root = `test/bench/baselines/browser-owned-indices-geography-strict-${mode}-20260908`;
    const report = json(`${root}/results.json`); assert.equal(report.status, 'passed'); assert.equal(report.strict, true);
    assert.equal(report.steps.length, 23); manifest(report.manifest); manifest(report.harnessHashes);
    assert.deepEqual(report.sessions.mvt.checkpoints, report.sessions.mlt.checkpoints);
    for (const step of report.steps) {
        sameImage(`${root}/mvt-${step.name}.png`, `${root}/mlt-${step.name}.png`);
        for (const encoding of ['mvt', 'mlt']) {
            const queries = JSON.parse(gunzipSync(read(`${root}/${encoding}-${step.name}.json.gz`)));
            const checkpoint = report.sessions[encoding].checkpoints[step.name];
            for (const [key, features] of Object.entries({...queries.source, rendered: queries.rendered})) {
                assert.equal(features.length, checkpoint.counts[key]); assert.equal(signature(features), checkpoint.hashes[key]);
            }
        }
    }
    for (const encoding of ['mvt', 'mlt']) {
        const session = report.sessions[encoding]; assert.equal(session.repeats.length, report.cycles * 9);
        for (const repeat of session.repeats) assert.deepEqual(repeat.summary, session.checkpoints[repeat.name]);
        for (const snapshot of session.stats) for (const worker of snapshot.workers) {
            assert.deepEqual([...worker.forbidden].sort(), [...forbidden].sort()); counters(worker.counters);
        }
        if (encoding === 'mlt') assert.ok(session.stats.at(-1).workers[0].counters.decodedLayers > 0);
    }
    geography[mode] = {pairs: 23, repeatedStepsPerEncoding: report.cycles * 9, completeQueryArchives: 46};
}
const styleRoot = 'test/bench/baselines/browser-owned-indices-styles-strict-gpu-20260908';
const styles = json(`${styleRoot}/results.json`);
assert.equal(styles.status, 'passed'); assert.equal(styles.strict, true); assert.equal(styles.scenario, 'styles');
manifest(styles.manifest); manifest(styles.harnessHashes);
assert.equal(Object.keys(styles.images).length, 25);
assert.deepEqual(styles.correctness.mvt.checkpoints, styles.correctness.mlt.checkpoints);
for (const encoding of ['mvt', 'mlt']) {
    const workers = styles.correctness[encoding].workerStats; assert.ok(workers.length > 0);
    for (const worker of workers) {
        assert.deepEqual([...worker.forbidden].sort(), [...forbidden].sort()); counters(worker.counters);
    }
    if (encoding === 'mlt') assert.ok(workers.at(-1).counters.decodedLayers > 0);
}
for (const [name, value] of Object.entries(styles.images)) {
    assert.equal(value.differentPixels, 0); sameImage(`${styleRoot}/mvt-${name}.png`, `${styleRoot}/mlt-${name}.png`);
}
const comparison = json('test/bench/baselines/owned-indices-comparison-20260908.json');
assert.equal(comparison.status, 'verified-geometry-browser-comparison'); assert.equal(comparison.verifiedImages, 32);
manifest(comparison.evidence);
execFileSync(process.execPath, ['test/bench/e2e/mlt-allocation-profile.ts', '--verify', 'test/bench/baselines/browser-owned-indices-allocations-20260908'], {stdio: 'inherit'});
json('test/bench/baselines/browser-owned-indices-allocations-20260908/results.json');

const benchmarkRoots = [
    'browser-post-clipping-render-profile-20260908', 'browser-owned-mesh-production-20260908', 'browser-owned-mesh-allocations-20260908',
    'browser-owned-indices-production-20260908', 'browser-owned-indices-allocations-20260908',
    'browser-owned-indices-geography-strict-gpu-20260908', 'browser-owned-indices-geography-strict-software-20260908',
    'browser-owned-indices-styles-strict-gpu-20260908', 'owned-mesh-before-module-20260908',
    'owned-mesh-after-module-20260908', 'owned-mesh-after-v2-module-20260908', 'owned-indices-after-module-20260908'
].map(name => `test/bench/baselines/${name}`);
const benchmarkFiles = ['test/bench/baselines/MLT_OWNED_INDICES_20260908.md', `${directory}/certify.mjs`,
    'test/bench/baselines/owned-mesh-comparison-20260908.json', 'test/bench/baselines/owned-indices-comparison-20260908.json'];
for (const name of ['mlt-allocation-profile.ts', 'mlt-render-profile.ts', 'mlt-geometry-browser.ts', 'mlt-geometry-validate.mjs',
    'mlt-lifecycle-page.ts', 'mlt-lifecycle.ts', 'mlt-geography.ts', 'mlt-direct-module.ts', 'mlt-direct-pipeline.test.ts']) {
    benchmarkFiles.push(`test/bench/e2e/${name}`);
}
benchmarkFiles.push('test/bench/build-mlt-direct.mjs', 'test/bench/vitest.mlt-direct.config.ts');
benchmarkFiles.push(...Object.keys(evidence).filter(path => path.startsWith('test/integration/assets/')));
for (const prefix of ['owned-mesh', 'owned-mesh-v2', 'owned-indices']) for (let run = 1; run <= 3; run++) {
    benchmarkFiles.push(`test/bench/baselines/${prefix}-native-worker-${run}-20260908.json`);
}
for (const root of benchmarkRoots) for (const [relative, value] of Object.entries(sources(root))) evidence[`${root}/${relative}`] = value;
for (const path of benchmarkFiles) read(path);
execFileSync('tar', ['-czf', `${directory}/benchmark-evidence.tar.gz`, ...benchmarkRoots, ...benchmarkFiles]);

const validationFiles = readdirSync('/tmp').filter(name => /^mlt-(owned-(mesh|indices)|allocation-profile)-.*20260908.*\.(json|log)$/.test(name)).sort();
for (const name of validationFiles) read(`/tmp/${name}`);
execFileSync('tar', ['-czf', `${directory}/validation-artifacts.tar.gz`, '-C', '/tmp', ...validationFiles]);
execFileSync('tar', ['-czf', `${directory}/workspace.tar.gz`, '-C', '/data/Projet/maplibre',
    'maplibre-gl-js/src', 'maplibre-gl-js/dist', 'maplibre-gl-js/package.json', 'maplibre-gl-js/package-lock.json',
    'maplibre-gl-js/test/build/bundle_size.json', 'maplibre-gl-js/test/bench/e2e/mlt-allocation-profile.ts',
    'maplibre-tile-spec/ts/src', 'maplibre-tile-spec/ts/dist', 'maplibre-tile-spec/ts/package.json']);
const archives = Object.fromEntries(['workspace.tar.gz', 'validation-artifacts.tar.gz', 'benchmark-evidence.tar.gz', 'gpu-failure-images.tar.gz'].map(name => [name, hash(readFileSync(`${directory}/${name}`))]));
writeFileSync(`${directory}/checkpoint.json`, JSON.stringify({status: 'qualified-owned-triangle-indices-mlt-checkpoint', createdAt: new Date().toISOString(),
    scope: 'Current source hashes, selected strict MLT renders and captured browser parity. The seven selected GPU failures have unchanged names and images. The full GPU suite was not rerun: the other 29 previously known failures are not recertified. No universal style/platform or GPU completion claim.',
    delta, sources: current, suites, geography, styles: {pairs: 25, completeQueryArchives: false},
    bundleSizes, archives, validationFiles, evidence}, null, 2));
console.log(JSON.stringify({status: 'qualified-owned-triangle-indices-mlt-checkpoint', delta, suites, geography, archives}, null, 2));
