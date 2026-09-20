import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {PNG} from 'pngjs';

const [output] = process.argv.slice(2);
assert.ok(output, 'Pass a new checkpoint directory');
mkdirSync(output);
const evidence = {};
const suites = {};
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function read(path) { const bytes = readFileSync(path); evidence[path] = hash(bytes); return bytes; }
function json(path) { return JSON.parse(read(path)); }
function archive(name, path) { writeFileSync(`${output}/${name}.gz`, gzipSync(read(path))); }

/** Archives only checks actually completed; broad GPU/geography and repeated browser performance remain open. */
for (const [name, path, passed] of [
    ['unit', '/tmp/mlt-indexed-unit-full-final-20260908.json', 3764],
    ['tileSpec', '/tmp/mlt-indexed-tilespec-full-v2-20260908.json', 2619],
    ['build', '/tmp/mlt-indexed-build-tests-final-20260908.json', 759],
    ['integration', '/tmp/mlt-indexed-integration-20260908.json', 178],
    ['renderSoftware', '/tmp/mlt-indexed-render-software-v2-20260908.json', 243],
]) {
    const suite = json(path);
    assert.equal(suite.numFailedTests, 0); assert.equal(suite.numPassedTests, passed);
    assert.equal(suite.numPendingTests, name === 'renderSoftware' ? 1680 : 0);
    suites[name] = {passed, pending: suite.numPendingTests}; archive(`${name}.json`, path);
}
const forbidden = ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers', 'propertyObjects', 'pointObjects',
    'geometryPartsMaterialized', 'overzoomPointObjects', 'mvtReencodes', 'rawTileMainThreadDecodes', 'coordinateTuples',
    'propertyDescriptors', 'propertyProxyMisses'];
const workers = json('/tmp/mlt-indexed-render-software-workers-v2-20260908.json');
assert.equal(Object.keys(workers).length, 243);
for (const snapshot of Object.values(workers).flat()) for (const key of forbidden) assert.equal(snapshot[key], 0);
archive('render-workers.json', '/tmp/mlt-indexed-render-software-workers-v2-20260908.json');
archive('render-metadata.json', '/tmp/mlt-indexed-render-software-metadata-v2-20260908.json');
const directory = 'test/bench/baselines/browser-indexed-styles-strict-gpu-20260908';
const styles = json(`${directory}/results.json`);
assert.equal(styles.status, 'passed'); assert.equal(styles.strict, true); assert.equal(styles.gpuMode, 'hardware');
assert.deepEqual(styles.correctness.mlt.checkpoints, styles.correctness.mvt.checkpoints);
assert.equal(Object.keys(styles.correctness.mlt.checkpoints).length, 25);
for (const [path, expected] of Object.entries(styles.manifest)) assert.equal(hash(read(path)), expected.sha256);
for (const name of Object.keys(styles.correctness.mlt.checkpoints)) {
    const a = PNG.sync.read(read(`${directory}/mvt-${name}.png`));
    const b = PNG.sync.read(read(`${directory}/mlt-${name}.png`));
    assert.equal(a.width, b.width); assert.equal(a.height, b.height); assert.deepEqual(a.data, b.data);
}
for (const session of Object.values(styles.correctness)) for (const snapshot of session.workerStats) {
    for (const key of forbidden) assert.equal(snapshot.counters[key], 0);
}
archive('styles.json', `${directory}/results.json`);
for (const path of ['test/bench/baselines/indexed-columns-worker-isolated-20260908.json',
    'test/bench/baselines/shared-parent-worker-isolated-v2-20260908.json']) {
    const pipeline = json(path); assert.equal(pipeline.status, 'passed'); assert.equal(pipeline.rows.length, 240);
    for (const key of ['renderHash', 'queryHash']) assert.equal(new Set(pipeline.rows.map(row => row[key])).size, 1);
    for (const directory of [pipeline.before, pipeline.after]) {
        const manifest = json(`${directory}/manifest.json`); assert.equal(hash(read(`${directory}/pipeline.mjs`)), manifest.bundle);
    }
    archive(path.split('/').at(-1), path);
}
archive('filter-spec-before.json', '/tmp/mlt-indexed-filter-spec-before-20260908.json');
archive('filter-spec-after.json', '/tmp/mlt-indexed-filter-spec-20260908.json');
const paths = execFileSync('rg', ['--files', 'src', '../maplibre-tile-spec/ts/src'], {encoding: 'utf8'}).trim().split('\n');
const sourceManifest = Object.fromEntries(paths.map(path => [path, hash(readFileSync(path))]));
for (const path of ['test/bench/baselines/shared-parent-browser-comparison-20260908.json',
    'test/bench/baselines/indexed-parent-browser-pilot-comparison-20260908.json']) archive(path.split('/').at(-1), path);
archive('checkpoint.mjs', 'test/bench/e2e/mlt-indexed-checkpoint.mjs');
writeFileSync(`${output}/checkpoint.json`, JSON.stringify({status: 'partial-pipeline-qualification', checkedAt: new Date().toISOString(),
    suites, stylesExactPairs: 25, sourceManifest, evidence,
    open: ['Repeated production browser comparison for indexed views', 'Current full GPU render suite',
        'Current globe/terrain parity campaigns', 'Six inherited filter .spec failures outside the unit configuration',
        'Remaining production pipeline work: first-cold cost, native zoom, geometry intermediates and initial concurrent parent copies']}, null, 2));
console.log(`Saved partial qualification to ${output}`);
