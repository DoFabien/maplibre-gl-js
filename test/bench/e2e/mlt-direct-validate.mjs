import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {PNG} from 'pngjs';

const [output, ...directories] = process.argv.slice(2);
assert.ok(output && directories.length === 6, 'Use a new output directory, three geography then three styles campaigns (production, strict GPU, strict software)');
mkdirSync(output);
const diff = execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'});
const forbidden = ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers', 'propertyObjects', 'pointObjects',
    'geometryPartsMaterialized', 'overzoomPointObjects', 'mvtReencodes', 'rawTileMainThreadDecodes', 'coordinateTuples', 'propertyDescriptors'];
const evidence = {};
const report = {status: 'running', checkedAt: new Date().toISOString(), productDiffSha256: hash(diff), campaigns: [], suites: {}, evidence};

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function read(path) { const bytes = readFileSync(path); evidence[path] = hash(bytes); return bytes; }
function json(path) { return JSON.parse(read(path)); }
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function signature(features) { return hash(JSON.stringify(features.map(feature => JSON.stringify(canonical(feature))).sort())); }
function pixels(path) {
    const png = PNG.sync.read(read(path)); assert.equal(png.width, 800); assert.equal(png.height, 600); return png.data;
}
function stats(workers, strict) {
    assert.equal(workers.length, strict ? 1 : 0);
    for (const worker of workers) {
        assert.deepEqual([...worker.forbidden].sort(), [...forbidden].sort());
        for (const key of [...forbidden, 'propertyProxyMisses']) assert.equal(worker.counters[key], 0, key);
    }
}

/** Recomputes every query hash and byte-exact image pair, and checks actual bundles rather than inheriting historical certificates. */
function campaign(directory, index) {
    const data = json(`${directory}/results.json`); const geography = index < 3; const strict = index % 3 !== 0;
    assert.equal(data.status, 'passed'); assert.equal(data.strict, strict);
    assert.equal(data.gpuMode, index % 3 === 2 ? 'software' : 'hardware'); assert.equal(data.productDiff, diff);
    for (const [path, expected] of Object.entries(data.manifest)) assert.equal(hash(read(path)), expected.sha256);
    for (const [path, expected] of Object.entries(data.harnessHashes)) assert.equal(hash(read(path)), expected);
    const sessions = geography ? data.sessions : data.correctness;
    assert.deepEqual(sessions.mvt.checkpoints, sessions.mlt.checkpoints);
    assert.equal(Object.keys(sessions.mvt.checkpoints).length, geography ? 23 : 25);
    for (const [name, checkpoint] of Object.entries(sessions.mvt.checkpoints)) {
        assert.deepEqual(pixels(`${directory}/mvt-${name}.png`), pixels(`${directory}/mlt-${name}.png`));
        for (const encoding of ['mvt', 'mlt']) {
            const queries = JSON.parse(gunzipSync(read(`${directory}/${encoding}-${name}.json.gz`)));
            const collections = geography ? {...queries.source, rendered: queries.rendered} : queries;
            for (const [kind, features] of Object.entries(collections)) {
                assert.equal(features.length, geography ? checkpoint.counts[kind] : checkpoint[`${kind}Count`]);
                assert.equal(signature(features), geography ? checkpoint.hashes[kind] : checkpoint[`${kind}Hash`]);
            }
        }
    }
    for (const encoding of ['mvt', 'mlt']) {
        const session = sessions[encoding];
        if (geography) {
            assert.equal(session.stats.length, 24); assert.equal(session.repeats.length, data.cycles * 9);
            for (const snapshot of session.stats) stats(snapshot.workers, strict);
            for (const repeat of session.repeats) assert.deepEqual(repeat.summary, session.checkpoints[repeat.name]);
        } else {
            stats(session.workerStats, strict);
            for (const mutation of session.styleMutations) stats(mutation.workerStats, strict);
        }
        if (strict) {
            const end = geography ? session.stats.at(-1).workers[0].counters : session.workerStats[0].counters;
            if (encoding === 'mlt') {
                assert.ok(end.decodedLayers > 0); assert.ok(end.overzoomFeaturesClipped > 0);
            } else if (geography) assert.equal(end.decodedLayers, 0);
            else {
                assert.ok(end.decodedLayers > 0, 'Style encoding switches must decode MLT');
                assert.equal(end.overzoomFeaturesClipped, 0, 'MVT-session encoding switches occur at the native tile zoom');
            }
        }
    }
    return {directory, checkpoints: geography ? 23 : 25, strict, mode: data.gpuMode};
}

try {
    report.campaigns = directories.map(campaign);
    for (const [name, path, expected] of [
        ['tileSpec', '/tmp/mlt-direct-tilespec-full-20260908.json', 2617],
        ['unit', '/tmp/mlt-direct-unit-full-20260908.json', 3758],
        ['build', '/tmp/mlt-direct-build-tests-final-20260908.json', 759],
        ['integration', '/tmp/mlt-direct-integration-final-20260908.json', 178],
        ['renderSoftware', '/tmp/mlt-direct-render-software-final-20260908.json', 243],
    ]) {
        const suite = json(path); assert.equal(suite.numFailedTests, 0); assert.equal(suite.numPassedTests, expected);
        writeFileSync(`${output}/${name}.json.gz`, gzipSync(read(path)));
        report.suites[name] = {passed: expected, sha256: evidence[path]};
    }
    const renderStatsPath = '/tmp/mlt-direct-render-software-workers-20260908.json';
    const renderStats = json(renderStatsPath); assert.equal(Object.keys(renderStats).length, 243);
    for (const workers of Object.values(renderStats)) for (const snapshot of workers) {
        for (const key of [...forbidden, 'propertyProxyMisses']) assert.equal(snapshot[key], 0, key);
    }
    writeFileSync(`${output}/render-software-workers.json.gz`, gzipSync(read(renderStatsPath)));
    writeFileSync(`${output}/render-software-metadata.json.gz`, gzipSync(read('/tmp/mlt-direct-render-software-metadata-20260908.json')));
    const paths = execFileSync('rg', ['--files', 'src', '../maplibre-tile-spec/ts/src'], {encoding: 'utf8'}).trim().split('\n');
    report.sourceManifest = Object.fromEntries(paths.map(path => [path, hash(readFileSync(path))]));
    for (const name of readdirSync('test/bench/e2e').filter(name => name.startsWith('mlt-direct-'))) {
        writeFileSync(`${output}/${name}.gz`, gzipSync(read(`test/bench/e2e/${name}`)));
    }
    for (const path of ['test/bench/build-mlt-direct.mjs', 'test/bench/e2e/mlt-geography.ts', 'test/bench/e2e/mlt-lifecycle.ts',
        'test/bench/e2e/mlt-lifecycle-page.ts', 'test/integration/lib/mlt_strict_worker.ts']) {
        writeFileSync(`${output}/${path.split('/').at(-1)}.gz`, gzipSync(read(path)));
    }
    report.status = 'verified-direct-overzoom-parity';
} catch (error) { report.status = 'failed'; report.error = String(error); process.exitCode = 1; }
writeFileSync(`${output}/validation.json`, JSON.stringify(report, null, 2));
console.log(report.status);
