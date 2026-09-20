import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {basename} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import {PNG} from 'pngjs';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function json(path) { return JSON.parse(readFileSync(path)); }
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function signature(features) { return sha256(JSON.stringify(features.map(feature => JSON.stringify(canonical(feature))).sort())); }
function pixels(directory, encoding, name) {
    const image = PNG.sync.read(readFileSync(`${directory}/${encoding}-${name}.png`));
    assert.equal(image.width, 800); assert.equal(image.height, 600);
    return image.data;
}
function sameImage(directory, encoding, first, second) { assert.deepEqual(pixels(directory, encoding, first), pixels(directory, encoding, second)); }

/** Recomputes signatures from complete GeoJSON archives and demands byte-exact PNG parity, without pixel tolerances. */
function validate(directory, strict, mode, diff) {
    const report = json(`${directory}/results.json`);
    assert.equal(report.status, 'passed');
    assert.equal(report.strict, strict);
    assert.equal(report.gpuMode, mode);
    assert.equal(report.productDiff, diff);
    assert.equal(report.steps.length, 23);
    for (const [path, value] of Object.entries(report.manifest)) assert.equal(sha256(readFileSync(path)), value.sha256, path);
    for (const [path, hash] of Object.entries(report.harnessHashes)) assert.equal(sha256(readFileSync(path)), hash, path);
    const forbidden = ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers', 'propertyObjects', 'pointObjects',
        'geometryPartsMaterialized', 'overzoomPointObjects', 'mvtReencodes', 'rawTileMainThreadDecodes', 'coordinateTuples', 'propertyDescriptors'].sort();
    assert.deepEqual(report.sessions.mvt.checkpoints, report.sessions.mlt.checkpoints);
    for (const encoding of ['mvt', 'mlt']) {
        const session = report.sessions[encoding];
        assert.equal(Object.keys(session.checkpoints).length, 23);
        assert.equal(session.repeats.length, 9 * report.cycles);
        assert.equal(session.stats.length, 24);
        for (const step of report.steps) {
            const checkpoint = session.checkpoints[step.name];
            const queries = JSON.parse(gunzipSync(readFileSync(`${directory}/${encoding}-${step.name}.json.gz`)));
            for (const [key, features] of Object.entries({...queries.source, rendered: queries.rendered})) {
                assert.equal(features.length, checkpoint.counts[key]);
                assert.equal(signature(features), checkpoint.hashes[key]);
            }
            assert.equal(checkpoint.globeness, step.globe);
            assert.deepEqual(checkpoint.vectorSourcesPreserved, [true, true]);
            assert.equal(checkpoint.terrain?.source, step.dem);
            if (step.dem) {
                assert.ok(checkpoint.elevations.every(value => Number.isFinite(value) && value > 0));
                assert.ok(Math.max(...checkpoint.elevations) - Math.min(...checkpoint.elevations) > 10);
            } else assert.deepEqual(checkpoint.elevations, [null, null, null]);
            const selected = !['initial', 'cleared'].includes(step.name);
            assert.deepEqual(checkpoint.selectedState, selected ? {selected: true} : {});
            assert.deepEqual(checkpoint.symbolSelectedState, selected ? {selected: true} : {});
            assert.deepEqual(pixels(directory, encoding, step.name), pixels(directory, 'mvt', step.name));
            if (!step.sameAs) continue;
            assert.deepEqual(checkpoint, session.checkpoints[step.sameAs]);
            sameImage(directory, encoding, step.name, step.sameAs);
        }
        for (const repeat of session.repeats) assert.deepEqual(repeat.summary, session.checkpoints[repeat.name]);
        for (const snapshot of session.stats) {
            assert.equal(snapshot.workers.length, strict ? 1 : 0);
            for (const worker of snapshot.workers) {
                assert.deepEqual([...worker.forbidden].sort(), forbidden);
                for (const key of [...forbidden, 'propertyProxyMisses']) assert.equal(worker.counters[key], 0, key);
            }
        }
        if (strict) {
            const end = session.stats.at(-1).workers[0].counters;
            if (encoding === 'mlt') {
                assert.ok(end.overzoomFeaturesClipped > 0);
                const local = session.stats.find(snapshot => snapshot.step === 'terrain-final').workers[0].counters;
                const world = session.stats.find(snapshot => snapshot.step === 'world-mercator').workers[0].counters;
                assert.ok(world.decodedLayers > local.decodedLayers, 'World MLT decoding must be exercised');
            } else assert.equal(end.decodedLayers, 0);
        }
        for (const [single, double] of [['terrain-pitched', 'terrain-double'], ['world-terrain', 'world-terrain-double']]) {
            assert.deepEqual(session.checkpoints[double].elevations, session.checkpoints[single].elevations.map(value => value * 2));
        }
        assert.notDeepEqual(pixels(directory, encoding, 'selected'), pixels(directory, encoding, 'terrain-home'));
        assert.notDeepEqual(pixels(directory, encoding, 'world-mercator'), pixels(directory, encoding, 'world-globe'));
        for (const [first, second] of [['terrain-pitched', 'terrain-double'], ['world-globe', 'world-terrain'], ['world-terrain', 'world-terrain-double']]) {
            assert.notDeepEqual(pixels(directory, encoding, first), pixels(directory, encoding, second));
        }
    }
    for (const prefix of ['/dem-local/', '/dem-world/', '/glyphs/', '/sprites/']) assert.ok(Object.keys(report.requests).some(path => path.startsWith(prefix)));
    return report;
}

function failed(report) { return report.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed').map(test => test.fullName)).sort(); }

const [production, hardware, software, unit, build, integration, gpu, gpuStats, beforeUnit, base, styles, beforeBuckets, beforeFlattened, renderSoftware, beforeSize] = process.argv.slice(2);
assert.ok(beforeSize, 'Expected three campaigns, suite reports, GPU counters, three before-fix reports, base/style regressions and the original size failure');
const diff = execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'});
const campaigns = [validate(production, false, 'hardware', diff), validate(hardware, true, 'hardware', diff), validate(software, true, 'software', diff)];
assert.deepEqual(campaigns[0].sessions.mlt.checkpoints, campaigns[1].sessions.mlt.checkpoints);
const result = {status: 'verified-with-known-gpu-failures', validatedAt: new Date().toISOString(), checkpoints: 23, cycles: campaigns[0].cycles,
    productDiffSha256: sha256(diff), suites: {}, regressions: {}, campaigns: {}, sources: {}};
for (const [name, path] of Object.entries({unit, build, integration, gpu, beforeUnit, beforeBuckets, beforeFlattened, renderSoftware, beforeSize})) {
    const report = json(path);
    if (name === 'gpu') {
        const previous = JSON.parse(gunzipSync(readFileSync('test/bench/baselines/browser-idle-isolation-20260907/gpu.json.gz')));
        const currentFailures = failed(report);
        const previousFailures = failed(previous);
        assert.deepEqual(currentFailures.filter(name => !previousFailures.includes(name)), []);
        result.gpuFailures = {remaining: currentFailures, resolved: previousFailures.filter(name => !currentFailures.includes(name))};
        assert.equal(report.numTotalTests, previous.numTotalTests);
    } else if (name === 'beforeUnit') assert.equal(report.numFailedTests, 4);
    else if (name === 'beforeBuckets') assert.equal(report.numFailedTests, 5);
    else if (name === 'beforeFlattened') assert.equal(report.numFailedTests, 3);
    else if (name === 'beforeSize') assert.deepEqual(failed(report), ['production bundle dist/maplibre-gl-shared.mjs bundle size stays the same']);
    else { assert.equal(report.success, true); assert.equal(report.numFailedTests, 0); }
    if (name === 'renderSoftware') assert.equal(report.numPassedTests, 243);
    writeFileSync(`${production}/${name}.json.gz`, gzipSync(readFileSync(path)));
    result.suites[name] = {passed: report.numPassedTests, failed: report.numFailedTests, sha256: sha256(readFileSync(path))};
}
const counters = json(gpuStats);
assert.equal(Object.keys(counters).length, 1923);
for (const workers of Object.values(counters)) for (const stats of workers) {
    for (const key of [...campaigns[1].sessions.mlt.stats[0].workers[0].forbidden, 'propertyProxyMisses']) assert.equal(stats[key], 0, key);
}
writeFileSync(`${production}/gpu-workers.json.gz`, gzipSync(readFileSync(gpuStats)));
writeFileSync(`${production}/gpu-metadata.json.gz`, gzipSync(readFileSync(gpuStats.replace('-workers-', '-metadata-'))));
const softwareStats = renderSoftware.replace('render-software-', 'render-software-workers-');
const softwareCounters = json(softwareStats);
assert.equal(Object.keys(softwareCounters).length, 243);
for (const workers of Object.values(softwareCounters)) for (const stats of workers) {
    for (const key of [...campaigns[1].sessions.mlt.stats[0].workers[0].forbidden, 'propertyProxyMisses']) assert.equal(stats[key], 0, key);
}
writeFileSync(`${production}/software-workers.json.gz`, gzipSync(readFileSync(softwareStats)));
writeFileSync(`${production}/software-metadata.json.gz`, gzipSync(readFileSync(renderSoftware.replace('render-software-', 'render-software-metadata-'))));
result.bundleSizes = json('test/build/bundle_size.json');
for (const [path, size] of Object.entries(result.bundleSizes)) {
    const bytes = readFileSync(path);
    assert.deepEqual(size, {raw: bytes.length, gzip: gzipSync(bytes).length});
}
assert.equal(execFileSync('git', ['diff', '--', 'test/build/min.test.ts'], {encoding: 'utf8'}), '');
for (const [scenario, path, count] of [['base', base, 7], ['styles', styles, 25]]) {
    const report = json(path);
    assert.equal(report.status, 'passed'); assert.equal(report.scenario, scenario); assert.equal(report.productDiff, diff);
    assert.deepEqual(report.correctness.mvt.checkpoints, report.correctness.mlt.checkpoints);
    assert.equal(Object.keys(report.images).length, count);
    for (const image of Object.values(report.images)) assert.equal(image.differentPixels, 0);
    writeFileSync(`${production}/${scenario}-regression.json.gz`, gzipSync(readFileSync(path)));
    result.regressions[scenario] = {checkpoints: count, sha256: sha256(readFileSync(path))};
}
for (const path of [...Object.keys(campaigns[0].harnessHashes), 'test/bench/e2e/mlt-geography-validate.mjs',
    'src/geo/projection/globe_projection.ts', 'src/geo/projection/globe_projection.test.ts', 'src/style/style.ts', 'src/ui/map_tests/map_render.test.ts',
    'src/data/bucket/columnar/columnar_fill_bucket.ts', 'src/data/bucket/columnar/columnar_line_bucket.ts',
    'src/data/bucket/columnar/columnar_bucket_parity.test.ts', 'src/render/subdivision.ts', 'src/render/subdivision.test.ts',
    'test/build/bundle_size.json', 'test/build/min.test.ts']) {
    writeFileSync(`${production}/${basename(path)}.gz`, gzipSync(readFileSync(path)));
    result.sources[path] = sha256(readFileSync(path));
}
for (const directory of [production, hardware, software]) result.campaigns[basename(directory)] = Object.fromEntries(readdirSync(directory)
    .filter(name => /\.(png|json|gz)$/.test(name) && name !== 'validation.json').map(name => [name, sha256(readFileSync(`${directory}/${name}`))]));
writeFileSync(`${production}/validation.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({status: result.status, suites: result.suites, regressions: result.regressions, checkpoints: result.checkpoints}, null, 2));
