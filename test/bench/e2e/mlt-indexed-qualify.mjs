import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {PNG} from 'pngjs';

const [output] = process.argv.slice(2);
assert.ok(output, 'Pass a new qualification directory');
mkdirSync(output);
const base = 'test/bench/baselines';
const evidence = {};
const forbidden = ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers', 'propertyObjects', 'pointObjects',
    'geometryPartsMaterialized', 'overzoomPointObjects', 'mvtReencodes', 'rawTileMainThreadDecodes', 'coordinateTuples',
    'propertyDescriptors', 'propertyProxyMisses'];
const report = {status: 'running', checkedAt: new Date().toISOString(), evidence};

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function read(path) { const bytes = readFileSync(path); evidence[path] = hash(bytes); return bytes; }
function json(path) { return JSON.parse(read(path)); }
function archive(name, path) { writeFileSync(`${output}/${name}.gz`, gzipSync(read(path))); }
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function signature(features) { return hash(JSON.stringify(features.map(feature => JSON.stringify(canonical(feature))).sort())); }
function pixels(path) { const png = PNG.sync.read(read(path)); return {width: png.width, height: png.height, data: png.data}; }
function counters(snapshot) { for (const key of forbidden) assert.equal(snapshot[key], 0, key); }
function failures(data) { return data.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed').map(test => test.fullName).sort(); }
function manifest(data) { for (const [path, expected] of Object.entries(data)) assert.equal(hash(read(path)), expected.sha256 ?? expected, path); }

/** Requires a paired main/worker capture and identical query/image outputs for each profiled phase. */
function profilePhase(phase, references) {
    const reference = references.get(phase.phase);
    if (reference) { assert.deepEqual(phase.hashes, reference.hashes); assert.deepEqual(pixels(phase.image), pixels(reference.image)); }
    else references.set(phase.phase, phase);
    assert.deepEqual(phase.profiles.map(sample => sample.name), ['main', 'worker']);
    for (const sample of phase.profiles) {
        const raw = JSON.parse(gunzipSync(read(sample.file)));
        assert.equal(raw.samples.length, sample.sampleCount);
        assert.equal(raw.timeDeltas.reduce((sum, value) => sum + value, 0), sample.sampledMicroseconds);
    }
}

/** Recomputes public-query hashes and exact PNG pairs for this source snapshot, including all repeated geography checkpoints. */
function campaign(kind, mode) {
    const directory = `${base}/browser-indexed-${kind}-${mode}-20260908`;
    const data = json(`${directory}/results.json`);
    const strict = mode !== 'production'; const geography = kind === 'geography';
    assert.equal(data.status, 'passed'); assert.equal(data.strict, strict);
    assert.equal(data.gpuMode, mode === 'strict-software' ? 'software' : 'hardware');
    assert.equal(data.productDiff, execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}));
    manifest(data.manifest); manifest(data.harnessHashes);
    const sessions = geography ? data.sessions : data.correctness;
    assert.deepEqual(sessions.mvt.checkpoints, sessions.mlt.checkpoints);
    assert.equal(Object.keys(sessions.mvt.checkpoints).length, geography ? 23 : 25);
    for (const [name, checkpoint] of Object.entries(sessions.mvt.checkpoints)) {
        assert.deepEqual(pixels(`${directory}/mvt-${name}.png`), pixels(`${directory}/mlt-${name}.png`));
        for (const encoding of ['mvt', 'mlt']) {
            const queries = JSON.parse(gunzipSync(read(`${directory}/${encoding}-${name}.json.gz`)));
            const collections = geography ? {...queries.source, rendered: queries.rendered} : queries;
            for (const [key, features] of Object.entries(collections)) {
                assert.equal(features.length, geography ? checkpoint.counts[key] : checkpoint[`${key}Count`]);
                assert.equal(signature(features), geography ? checkpoint.hashes[key] : checkpoint[`${key}Hash`]);
            }
        }
    }
    for (const [encoding, session] of Object.entries(sessions)) {
        const snapshots = geography ? session.stats.map(item => item.workers) :
            [session.workerStats, ...session.styleMutations.map(item => item.workerStats)];
        for (const workers of snapshots) {
            assert.equal(workers.length, strict ? 1 : 0);
            for (const worker of workers) counters(worker.counters);
        }
        if (strict && encoding === 'mlt') {
            const end = geography ? session.stats.at(-1).workers[0].counters : session.workerStats[0].counters;
            assert.ok(end.decodedLayers > 0); assert.ok(end.overzoomFeaturesClipped > 0);
        }
        if (!geography) continue;
        assert.equal(data.cycles, 3); assert.equal(session.stats.length, 24); assert.equal(session.repeats.length, 27);
        for (const repeat of session.repeats) assert.deepEqual(repeat.summary, session.checkpoints[repeat.name]);
    }
    archive(`${kind}-${mode}.json`, `${directory}/results.json`);
    return {directory, pairs: geography ? 23 : 25};
}

/** Extends the partial checkpoint only when every source, bundle and new campaign still matches; historical GPU failures remain failures. */
try {
    const checkpointDirectory = `${base}/indexed-columns-checkpoint-20260908`;
    const checkpoint = json(`${checkpointDirectory}/checkpoint.json`);
    assert.equal(checkpoint.status, 'partial-pipeline-qualification');
    const sources = execFileSync('rg', ['--files', 'src', '../maplibre-tile-spec/ts/src'], {encoding: 'utf8'}).trim().split('\n').sort();
    assert.deepEqual(sources, Object.keys(checkpoint.sourceManifest).sort());
    manifest(checkpoint.sourceManifest);
    report.sourceManifest = checkpoint.sourceManifest; report.suites = checkpoint.suites;
    for (const [name, expected] of Object.entries(checkpoint.suites)) {
        const data = JSON.parse(gunzipSync(read(`${checkpointDirectory}/${name}.json.gz`)));
        assert.equal(data.numPassedTests, expected.passed); assert.equal(data.numPendingTests, expected.pending);
        assert.equal(data.numFailedTests, 0);
    }
    manifest(Object.fromEntries(Object.entries(checkpoint.evidence).filter(([path]) => path.startsWith('dist/'))));
    const gpuPath = '/tmp/mlt-indexed-render-gpu-20260908.json'; const gpu = json(gpuPath);
    const previousPath = `${base}/direct-overzoom-final-20260908/gpu.gz`;
    const previous = JSON.parse(gunzipSync(read(previousPath)));
    assert.equal(gpu.numTotalTests, 1923); assert.equal(gpu.numPendingTests, 0);
    assert.equal(gpu.numPassedTests, 1887); assert.equal(gpu.numFailedTests, 36);
    assert.deepEqual(failures(gpu), failures(previous));
    const workersPath = '/tmp/mlt-indexed-render-gpu-workers-20260908.json'; const workers = json(workersPath);
    assert.equal(Object.keys(workers).length, 1923);
    assert.ok(Object.values(workers).flat().reduce((sum, snapshot) => sum + snapshot.decodedLayers, 0) > 0);
    for (const snapshot of Object.values(workers).flat()) counters(snapshot);
    const metadataPath = '/tmp/mlt-indexed-render-gpu-metadata-20260908.json'; const metadata = json(metadataPath);
    assert.equal(metadata.mode, 'hardware'); assert.equal(metadata.strict, true);
    assert.equal(Object.keys(metadata.renderers).length, 1923);
    for (const renderer of Object.values(metadata.renderers)) assert.doesNotMatch(renderer.renderer, /swiftshader|llvmpipe|software/i);
    report.gpu = {passed: 1887, failed: failures(gpu), previousPath, newlyFailing: [],
        limitation: 'Same failing names, not proof of unchanged pixel deviations inside already-failing fixtures.'};
    report.gpu.failureImages = failures(gpu).map((name, index) => {
        const path = `test/integration/render/${name.replace('Render tests ', '')}/actual.png`;
        archive(`gpu-failure-${index}-actual.png`, path);
        return {name, archivedImage: `gpu-failure-${index}-actual.png.gz`, sha256: evidence[path]};
    });
    archive('gpu.json', gpuPath); archive('gpu-workers.json', workersPath); archive('gpu-metadata.json', metadataPath);
    report.campaigns = ['geography', 'styles'].flatMap(kind => ['production', 'strict-gpu', 'strict-software'].map(mode => campaign(kind, mode)));
    const browserPath = `${base}/indexed-parent-browser-comparison-20260908.json`; const browser = json(browserPath);
    assert.equal(browser.status, 'verified-browser-comparison'); assert.equal(browser.runs, 3); assert.equal(browser.imageComparisons, 12);
    manifest(browser.evidence); archive('browser-comparison.json', browserPath);
    const profileDirectory = `${base}/browser-indexed-render-profile-20260908`; const profile = json(`${profileDirectory}/results.json`);
    assert.equal(profile.status, 'passed'); assert.equal(profile.sessions.length, 4);
    manifest(profile.manifest); manifest(profile.mapHashes);
    manifest(Object.fromEntries(Object.entries(profile.harnessHashes).map(([name, value]) => [`test/bench/e2e/${name}`, value])));
    const references = new Map();
    for (const session of profile.sessions) {
        assert.deepEqual(session.phases.map(phase => phase.phase), ['native-reload', 'first-overzoom', 'warm-overzoom']);
        for (const phase of session.phases) profilePhase(phase, references);
    }
    archive('profile.json', `${profileDirectory}/results.json`);
    archive('qualifier.mjs', 'test/bench/e2e/mlt-indexed-qualify.mjs');
    report.status = 'qualified-indexed-views-with-known-gpu-failures';
    report.open = ['36 current GPU fixture failures', 'Six inherited filter .spec failures outside the unit configuration',
        'Production pipeline: redundant geometry indexing, first-overzoom clipping, native-zoom ownership, initial concurrent parent copies',
        'Full style parity including distance; CPU render events are not GPU execution/presentation measurements'];
} catch (error) { report.status = 'failed'; report.error = String(error); process.exitCode = 1; }
writeFileSync(`${output}/qualification.json`, JSON.stringify(report, null, 2));
console.log(report.status);
