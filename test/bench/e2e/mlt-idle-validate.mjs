import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {gzipSync, gunzipSync} from 'node:zlib';
import {basename} from 'node:path';
import {PNG} from 'pngjs';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function json(path) { return JSON.parse(readFileSync(path)); }
function pixels(path) {
    const image = PNG.sync.read(readFileSync(path));
    assert.equal(image.width, 800);
    assert.equal(image.height, 600);
    return image.data;
}

function difference(a, b) {
    assert.equal(a.length, b.length);
    let pixels = 0;
    let maxDelta = 0;
    for (let index = 0; index < a.length; index += 4) {
        let changed = false;
        for (let channel = 0; channel < 4; channel++) {
            const delta = Math.abs(a[index + channel] - b[index + channel]);
            maxDelta = Math.max(delta, maxDelta);
            changed ||= delta > 0;
        }
        if (changed) pixels++;
    }
    return {pixels, maxDelta};
}

/** Recomputes diagnostic comparisons from the archived PNGs, including the frame captured before any requested repaint. */
function validateIsolation(directory, expectedPixels, fixed) {
    const report = json(`${directory}/results.json`);
    assert.equal(report.status, fixed ? 'stable' : 'diagnostic-complete');
    assert.equal(report.sessions.length, fixed ? 8 : 4);
    for (const session of report.sessions) {
        const prefix = `${directory}/${session.encoding}-${session.journey}-${session.run}`;
        const initial = pixels(`${prefix}-initial-raw.png`);
        for (const observation of session.observations) {
            const raw = pixels(`${prefix}-${observation.name}-raw.png`);
            const screen = pixels(`${prefix}-${observation.name}-screen.png`);
            const before = pixels(`${prefix}-${observation.name}-before-screen.png`);
            assert.equal(sha256(raw), observation.rawHash);
            assert.equal(sha256(screen), observation.screenshotHash);
            assert.deepEqual(difference(initial, raw), observation.rawVsInitial);
            assert.deepEqual(difference(initial, before), observation.beforeVsInitial);
            assert.deepEqual(difference(raw, screen), observation.rawVsScreenshot);
            assert.deepEqual(difference(before, screen), observation.repaintDifference);
            assert.equal(difference(initial, raw).pixels, 0);
            assert.equal(difference(raw, screen).pixels, 0);
            const expected = observation.name === 'returned' ? expectedPixels : 0;
            assert.deepEqual(difference(initial, before), {pixels: expected, maxDelta: expected ? 1 : 0});
            if (!observation.idleCamera) continue;
            const idle = pixels(`${prefix}-${observation.name}-idle-raw.png`);
            assert.deepEqual(observation.idleCamera, observation.camera);
            assert.deepEqual(difference(idle, before), observation.idleVsBefore);
            assert.equal(difference(idle, before).pixels, 0);
            assert.deepEqual(difference(initial, idle), observation.idleVsInitial);
        }
    }
    return {sessions: report.sessions.length, returnedPixels: expectedPixels,
        files: Object.fromEntries(readdirSync(directory).filter(name => /\.(png|json)$/.test(name)).map(name => [name, sha256(readFileSync(`${directory}/${name}`))]))};
}

function failedTests(report) {
    return report.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed').map(test => test.fullName)).sort();
}

const [before, after, styles, unit, build, integration, software, gpu, softwareStats, gpuStats] = process.argv.slice(2);
assert.ok(gpuStats, 'Expected before/after/style archives, five test reports and two strict worker reports');
assert.equal(existsSync(`${after}/validation.json`), false, 'Use an unvalidated archive');
const result = {status: 'running', validatedAt: new Date().toISOString(), isolation: {}, tests: {}, workerStats: {}, snapshots: {}};
for (const [name, count] of [['camera', 46], ['point-symbols', 55], ['no-symbols', 0], ['density', 0], ['no-density', 42]]) {
    result.isolation[name] = validateIsolation(`${before}/${name}`, count, false);
}
result.isolation.fixed = validateIsolation(after, 0, true);
const fixed = json(`${after}/results.json`);
assert.equal(fixed.productDiff, execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}));
for (const [path, hash] of Object.entries(fixed.harnessHashes)) assert.equal(sha256(readFileSync(path)), hash);
for (const [path, entry] of Object.entries(fixed.manifest)) assert.equal(sha256(readFileSync(path)), entry.sha256);
const withoutFollowup = json(`${before}/unit-without-followup.json`);
assert.equal(withoutFollowup.numFailedTests, 2);
assert.equal(withoutFollowup.numPassedTests, 0);
assert.ok(failedTests(withoutFollowup).every(name => name.includes('idle follows a render of the final symbol tile set')));
const styleValidation = json(`${styles}/validation.json`);
assert.equal(styleValidation.status, 'passed');
assert.equal(Object.keys(styleValidation.campaigns).length, 4);
for (const [name, path] of Object.entries({unit, build, integration, software, gpu})) {
    const report = json(path);
    if (name !== 'gpu') { assert.equal(report.success, true); assert.equal(report.numFailedTests, 0); }
    if (name === 'gpu') {
        const previous = JSON.parse(gunzipSync(readFileSync('test/bench/baselines/browser-intersections-20260906/gpu.json.gz')));
        assert.deepEqual(failedTests(report), failedTests(previous));
        assert.equal(report.numTotalTests, previous.numTotalTests);
    }
    writeFileSync(`${after}/${name}.json.gz`, gzipSync(readFileSync(path)));
    result.tests[name] = {passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests,
        sha256: sha256(readFileSync(path)), failures: failedTests(report)};
}
const forbidden = ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers', 'propertyObjects', 'propertyProxyMisses',
    'pointObjects', 'geometryPartsMaterialized', 'overzoomPointObjects', 'mvtReencodes', 'rawTileMainThreadDecodes', 'coordinateTuples', 'propertyDescriptors'];
for (const [name, path] of Object.entries({softwareStats, gpuStats})) {
    const stats = json(path);
    assert.equal(Object.keys(stats).length, name === 'softwareStats' ? 243 : 1923);
    for (const workers of Object.values(stats)) {
        assert.ok(workers.length > 0);
        for (const counters of workers) for (const key of forbidden) assert.equal(counters[key], 0, key);
    }
    writeFileSync(`${after}/${name}.json.gz`, gzipSync(readFileSync(path)));
    result.workerStats[name] = {fixtures: Object.keys(stats).length, forbidden, sha256: sha256(readFileSync(path))};
    const metadataPath = path.replace('-workers-', '-metadata-');
    assert.notEqual(metadataPath, path);
    const metadata = json(metadataPath);
    assert.equal(metadata.strict, true);
    assert.equal(metadata.mode, name === 'softwareStats' ? 'software' : 'hardware');
    assert.equal(Object.keys(metadata.renderers).length, Object.keys(stats).length);
    writeFileSync(`${after}/${name}-metadata.json.gz`, gzipSync(readFileSync(metadataPath)));
    result.workerStats[name].rendererMetadataSha256 = sha256(readFileSync(metadataPath));
}
const alternatePort = JSON.parse(gunzipSync(readFileSync(`${after}/alternative-port-gpu.json.gz`)));
result.alternatePortRun = {passed: alternatePort.numPassedTests, failed: alternatePort.numFailedTests,
    additionalFailures: failedTests(alternatePort).filter(name => !result.tests.gpu.failures.includes(name))};
assert.equal(result.alternatePortRun.additionalFailures.length, 16);
for (const path of [...Object.keys(fixed.harnessHashes), 'test/bench/e2e/mlt-idle-validate.mjs', 'src/ui/map.ts',
    'src/ui/map_tests/map_render.test.ts', 'src/style/style.ts', 'src/tile/tile_manager.ts']) {
    const bytes = readFileSync(path);
    writeFileSync(`${after}/${basename(path)}.gz`, gzipSync(bytes));
    result.snapshots[path] = sha256(bytes);
}
result.status = 'verified-with-known-gpu-failures';
writeFileSync(`${after}/validation.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({status: result.status, tests: result.tests, workerStats: result.workerStats}, null, 2));
