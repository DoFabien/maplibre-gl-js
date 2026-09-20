import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve, basename} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import {PNG} from 'pngjs';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

/** Recomputes full public query signatures from archived GeoJSON, without trusting the runner's parity flag. */
function signature(features, geometry = true) {
    const rows = features.map(feature => JSON.stringify(canonical({
        ...feature, geometry: geometry ? feature.geometry : {type: feature.geometry.type}
    }))).sort();
    return sha256(JSON.stringify(rows));
}

function pixels(directory, name, encoding) {
    return PNG.sync.read(readFileSync(`${directory}/${encoding}-${name}.png`)).data;
}

/** Independently validates the three symbol campaigns, their immutable inputs and the unit report. */
function validate(directory, strict, mode, productDiff) {
    const data = JSON.parse(readFileSync(`${directory}/results.json`));
    assert.equal(data.status, 'passed');
    assert.equal(data.scenario, 'symbols');
    assert.equal(data.strict, strict);
    assert.equal(data.gpuMode, mode);
    assert.equal(data.measureWithDifferences, false);
    assert.equal(data.productDiff, productDiff);
    for (const [path, file] of Object.entries(data.manifest)) {
        const bytes = readFileSync(path);
        assert.equal(bytes.length, file.bytes);
        assert.equal(sha256(bytes), file.sha256, path);
    }
    for (const [path, hash] of Object.entries(data.harnessHashes)) assert.equal(sha256(readFileSync(path)), hash, path);
    assert.deepEqual(data.correctness.mvt.checkpoints, data.correctness.mlt.checkpoints);
    assert.equal(Object.keys(data.correctness.mlt.checkpoints).length, 10);
    for (const encoding of ['mvt', 'mlt']) {
        const result = data.correctness[encoding];
        assert.deepEqual(result.info.canvas, {width: 800, height: 600});
        assert.equal(result.info.pixelRatio, 1);
        for (const range of ['0-255', '256-511', '8192-8447']) {
            assert.ok(result.assets[`/glyphs/Open Sans Semibold,Arial Unicode MS Bold/${range}.pbf`] > 0);
        }
        for (const extension of ['json', 'png']) assert.ok(result.assets[`/sprites/sprite.${extension}`] > 0);
        assert.notDeepEqual(pixels(directory, 'initial', encoding), pixels(directory, 'symbol-selected', encoding));
        assert.deepEqual(pixels(directory, 'symbol-selected', encoding), pixels(directory, 'symbol-selected-reloaded', encoding));
        assert.deepEqual(pixels(directory, 'initial', encoding), pixels(directory, 'symbol-cleared', encoding));
        for (const [name, checkpoint] of Object.entries(result.checkpoints)) {
            const queries = JSON.parse(gunzipSync(readFileSync(`${directory}/${encoding}-${name}.json.gz`)));
            for (const kind of ['source', 'rendered']) {
                assert.equal(queries[kind].length, checkpoint[`${kind}Count`]);
                assert.equal(signature(queries[kind]), checkpoint[`${kind}Hash`]);
                assert.equal(signature(queries[kind], false), checkpoint[`${kind}AttributesHash`]);
            }
            for (const layer of ['poi-labels', 'street-labels']) assert.ok(checkpoint.renderedLayerCounts[layer] > 0);
            const png = PNG.sync.read(readFileSync(`${directory}/${encoding}-${name}.png`));
            assert.equal(png.width, 800);
            assert.equal(png.height, 600);
            assert.deepEqual(png.data, pixels(directory, name, 'mvt'));
        }
        assert.equal(result.workerStats.length, strict ? 1 : 0);
        for (const stats of result.workerStats) {
            assert.equal(stats.forbidden.length, 10);
            for (const counter of stats.forbidden) assert.equal(stats.counters[counter], 0);
            assert.equal(stats.counters.propertyProxyMisses, 0);
            if (encoding === 'mlt') {
                assert.ok(stats.counters.decodedLayers > 0);
                assert.ok(stats.counters.overzoomFeaturesClipped > 0);
            }
        }
    }
    const manifest = Object.fromEntries(readdirSync(directory).filter(name => /\.(json|gz|png)$/.test(name) && name !== 'validation.json')
        .map(name => {
            const bytes = readFileSync(`${directory}/${name}`);
            return [name, {bytes: bytes.length, sha256: sha256(bytes)}];
        }));
    return {data, manifest};
}

const [production, hardware, software, unitPath, basePath] = process.argv.slice(2).map(path => resolve(path));
assert.ok(production && hardware && software && unitPath && basePath,
    'Use <production-dir> <strict-gpu-dir> <strict-software-dir> <unit.json> <base-results.json>');
const diff = execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'});
const campaigns = [validate(production, false, 'hardware', diff), validate(hardware, true, 'hardware', diff), validate(software, true, 'software', diff)];
assert.deepEqual(campaigns[0].data.correctness.mlt.checkpoints, campaigns[1].data.correctness.mlt.checkpoints);
assert.deepEqual(campaigns[1].data.correctness.mlt.workerStats, campaigns[2].data.correctness.mlt.workerStats);
const timings = campaigns[0].data;
assert.equal(timings.phase, 'timing');
assert.equal(timings.runs % 2, 0, 'Use an even number of alternating pairs');
assert.equal(timings.timings.length, timings.runs * 2);
const expectedCounts = Object.fromEntries(['source', 'rendered'].map(kind => [kind,
    ['initial', 'overzoom-1', 'overzoom-2'].reduce((sum, name) => sum + timings.correctness.mlt.checkpoints[name][`${kind}Count`], 0)]));
const order = [];
for (let run = 1; run <= timings.runs; run++) {
    for (const encoding of run % 2 ? ['mvt', 'mlt'] : ['mlt', 'mvt']) order.push({run, encoding});
}
assert.deepEqual(timings.timings.map(({run, encoding}) => ({run, encoding})), order);
for (const session of timings.timings) {
    assert.equal(session.result.samples.length, timings.cycles);
    for (const sample of session.result.samples) {
        assert.equal(sample.sourceResults, expectedCounts.source);
        assert.equal(sample.renderedResults, expectedCounts.rendered);
    }
}
const unitBytes = readFileSync(unitPath);
const unit = JSON.parse(unitBytes);
assert.equal(unit.success, true);
assert.equal(unit.numFailedTests, 0);
assert.equal(unit.numPassedTests, unit.numTotalTests);
writeFileSync(`${production}/unit.json.gz`, gzipSync(unitBytes));
const baseBytes = readFileSync(basePath);
const base = JSON.parse(baseBytes);
assert.equal(base.status, 'passed');
assert.equal(base.scenario, 'base');
assert.equal(base.productDiff, diff);
assert.deepEqual(base.harnessHashes, campaigns[0].data.harnessHashes);
assert.deepEqual(base.correctness.mvt.checkpoints, base.correctness.mlt.checkpoints);
assert.equal(Object.keys(base.images).length, 7);
for (const comparison of Object.values(base.images)) assert.equal(comparison.differentPixels, 0);
writeFileSync(`${production}/base-results.json.gz`, gzipSync(baseBytes));
for (const path of [...Object.keys(campaigns[0].data.harnessHashes), 'test/bench/e2e/mlt-symbols-validate.mjs',
    'test/integration/lib/mlt_strict_worker.ts', 'rolldown.config.mlt-validation.ts']) {
    writeFileSync(`${production}/${basename(path)}.gz`, gzipSync(readFileSync(path)));
}
const result = {validatedAt: new Date().toISOString(), status: 'passed', productDiffSha256: sha256(diff),
    campaigns: Object.fromEntries([production, hardware, software].map((directory, index) => [basename(directory), campaigns[index].manifest])),
    unit: {total: unit.numTotalTests, passed: unit.numPassedTests, sha256: sha256(unitBytes)},
    base: {checkpoints: 7, sha256: sha256(baseBytes)},
    timing: {pairs: timings.runs, cyclesPerSession: timings.cycles, expectedCounts},
    strictMltWorker: campaigns[1].data.correctness.mlt.workerStats[0]};
writeFileSync(`${production}/validation.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({status: result.status, unit: result.unit.passed, timing: result.timing, checkpointsPerCampaign: 10}, null, 2));
