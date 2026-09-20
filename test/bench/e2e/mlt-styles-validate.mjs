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

function signature(features, geometry = true) {
    return sha256(JSON.stringify(features.map(feature => JSON.stringify(canonical({
        ...feature, geometry: geometry ? feature.geometry : {type: feature.geometry.type}
    }))).sort()));
}

function pixels(directory, encoding, name) {
    const image = PNG.sync.read(readFileSync(`${directory}/${encoding}-${name}.png`));
    assert.equal(image.width, 800);
    assert.equal(image.height, 600);
    return image.data;
}

/** Records exact mismatches for a failing qualification; no tolerance or passing status is introduced. */
function comparePixels(first, second) {
    let differentPixels = 0;
    let maxChannelDelta = 0;
    for (let index = 0; index < first.length; index += 4) {
        let changed = false;
        for (let channel = 0; channel < 4; channel++) {
            const delta = Math.abs(first[index + channel] - second[index + channel]);
            maxChannelDelta = Math.max(maxChannelDelta, delta);
            changed ||= delta > 0;
        }
        if (changed) differentPixels++;
    }
    return {differentPixels, maxChannelDelta};
}

function strictStats(snapshots, strict) {
    assert.equal(snapshots.length, strict ? 1 : 0);
    for (const stats of snapshots) {
        assert.deepEqual([...stats.forbidden].sort(), ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers',
            'propertyObjects', 'pointObjects', 'geometryPartsMaterialized', 'overzoomPointObjects', 'mvtReencodes',
            'rawTileMainThreadDecodes', 'coordinateTuples', 'propertyDescriptors'].sort());
        for (const counter of [...stats.forbidden, 'propertyProxyMisses']) assert.equal(stats.counters[counter], 0, counter);
    }
}

/** Recomputes every archived query signature and PNG comparison; repeat checks are anchored to these full checkpoints. */
function validate(directory, strict, mode, diff, recordRenderFailures = false) {
    const data = JSON.parse(readFileSync(`${directory}/results.json`));
    const renderFailures = [];
    function samePixels(first, second, label) {
        const difference = comparePixels(first, second);
        if (!difference.differentPixels) return;
        if (!recordRenderFailures) assert.equal(difference.differentPixels, 0, label);
        renderFailures.push({label, ...difference});
    }
    if (!recordRenderFailures) assert.equal(data.status, 'passed');
    assert.equal(data.scenario, 'styles');
    assert.equal(data.phase, 'correctness');
    assert.equal(data.strict, strict);
    assert.equal(data.gpuMode, mode);
    assert.equal(data.measureWithDifferences, false);
    assert.equal(data.productDiff, diff);
    assert.ok(data.styleCycles > 0);
    assert.equal(data.timings.length, 0);
    for (const [path, value] of Object.entries(data.manifest)) assert.equal(sha256(readFileSync(path)), value.sha256, path);
    for (const [path, value] of Object.entries(data.harnessHashes)) assert.equal(sha256(readFileSync(path)), value, path);
    assert.deepEqual(data.correctness.mvt.checkpoints, data.correctness.mlt.checkpoints);
    for (const encoding of ['mvt', 'mlt']) {
        const result = data.correctness[encoding];
        assert.equal(Object.keys(result.checkpoints).length, 25);
        assert.equal(result.styleMutations.length, 12 + 5 * data.styleCycles);
        assert.deepEqual(result.info.canvas, {width: 800, height: 600});
        for (const [name, checkpoint] of Object.entries(result.checkpoints)) {
            const queries = JSON.parse(gunzipSync(readFileSync(`${directory}/${encoding}-${name}.json.gz`)));
            for (const kind of ['source', 'rendered']) {
                assert.equal(queries[kind].length, checkpoint[`${kind}Count`]);
                assert.equal(signature(queries[kind]), checkpoint[`${kind}Hash`]);
                assert.equal(signature(queries[kind], false), checkpoint[`${kind}AttributesHash`]);
            }
            if (encoding === 'mlt') samePixels(pixels(directory, encoding, name), pixels(directory, 'mvt', name), `mvt/mlt:${name}`);
        }
        assert.notDeepEqual(pixels(directory, encoding, 'style-selected'), pixels(directory, encoding, 'style-direct'));
        for (const [first, second] of [['style-direct', 'style-diff'], ['style-selected', 'style-assets'],
            ['style-selected', 'style-direct-restored'], ['style-selected', 'style-diff-restored'],
            ['initial', 'style-rebuilt'], ['initial', 'style-readded'], ['initial', 'style-final'],
            ['overzoom-1', 'style-overzoom-restored']]) {
            assert.deepEqual(result.checkpoints[first], result.checkpoints[second]);
            samePixels(pixels(directory, encoding, first), pixels(directory, encoding, second), `${encoding}:${first}/${second}`);
        }
        assert.equal(result.checkpoints['style-selected'].selectedState.selected, true);
        assert.equal(result.checkpoints['style-selected'].symbolSelectedState.selected, true);
        assert.equal(result.checkpoints['style-empty'].sourceCount, 0);
        assert.equal(result.checkpoints['style-empty'].renderedCount, 0);
        const repeats = result.styleMutations.filter(row => row.name.startsWith('repeat-'));
        const expectedOrder = [];
        for (let index = 1; index <= data.styleCycles; index++) {
            for (const [operation, expected] of [['diff', 'style-direct'], ['restore', 'style-selected'], ['rebuild', 'initial'],
                ['encoding', 'initial'], ['restore', 'initial']]) {
                expectedOrder.push(`repeat-${index}-${operation}-${expected}`);
            }
        }
        assert.deepEqual(repeats.map(row => row.name), expectedOrder);
        for (const row of result.styleMutations) {
            const {operation, sourcePreserved, sourcePresent} = row.mutation;
            assert.equal(sourcePresent, operation !== 'empty');
            if (sourcePresent) assert.equal(row.mutation.encoding, operation === 'encoding' ? (encoding === 'mvt' ? 'mlt' : 'mvt') : encoding);
            if (['direct', 'direct-restore', 'diff', 'assets'].includes(operation)) assert.equal(sourcePreserved, true);
            if (['rebuild', 'encoding', 'empty'].includes(operation)) assert.equal(sourcePreserved, false);
            if (!sourcePreserved) {
                assert.deepEqual(row.checkpoint.selectedState, {});
                assert.deepEqual(row.checkpoint.symbolSelectedState, {});
            }
            if (row.name.startsWith('repeat-')) {
                const expected = row.name.endsWith('style-direct') ? 'style-direct' : row.name.endsWith('style-selected') ? 'style-selected' : 'initial';
                assert.deepEqual(row.checkpoint, result.checkpoints[expected]);
            } else assert.deepEqual(row.checkpoint, result.checkpoints[row.name]);
            strictStats(row.workerStats, strict);
        }
        const assets = result.styleMutations.find(row => row.name === 'style-assets').assets;
        for (const prefix of ['', '-alt']) {
            for (const range of ['0-255', '256-511', '8192-8447']) assert.ok(assets[`/glyphs${prefix}/Open Sans Semibold,Arial Unicode MS Bold/${range}.pbf`] > 0);
            for (const extension of ['json', 'png']) assert.ok(assets[`/sprites${prefix}/sprite.${extension}`] > 0);
        }
        strictStats(result.workerStats, strict);
        if (strict) assert.ok(result.workerStats[0].counters.decodedLayers > 0, 'Both session orders must exercise MLT after swapping encoding');
    }
    assert.equal(data.status, renderFailures.length ? 'failed' : 'passed');
    return {...data, renderFailures};
}

const recordRenderFailures = process.argv.includes('--record-render-failures');
const [production, hardware, software, unitPath, symbolsPath, basePath, repeat] = process.argv.slice(2)
    .filter(argument => argument !== '--record-render-failures').map(path => resolve(path));
assert.ok(basePath, 'Use <production-dir> <strict-gpu-dir> <strict-software-dir> <unit.json> <symbols-results.json> <base-results.json>');
const diff = execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'});
const directories = [production, hardware, software];
const campaigns = [validate(production, false, 'hardware', diff), validate(hardware, true, 'hardware', diff), validate(software, true, 'software', diff, recordRenderFailures)];
if (repeat) {
    directories.push(repeat);
    campaigns.push(validate(repeat, true, 'software', diff, recordRenderFailures));
}
assert.deepEqual(campaigns[0].correctness.mlt.checkpoints, campaigns[1].correctness.mlt.checkpoints);
const unitBytes = readFileSync(unitPath);
const unit = JSON.parse(unitBytes);
assert.equal(unit.success, true);
assert.equal(unit.numFailedTests, 0);
assert.equal(unit.numTotalTests, unit.numPassedTests);
writeFileSync(`${production}/unit.json.gz`, gzipSync(unitBytes));
const regressions = {};
for (const [scenario, path, count] of [['symbols', symbolsPath, 10], ['base', basePath, 7]]) {
    const bytes = readFileSync(path);
    const report = JSON.parse(bytes);
    assert.equal(report.status, 'passed');
    assert.equal(report.scenario, scenario);
    assert.equal(report.productDiff, diff);
    assert.deepEqual(report.harnessHashes, campaigns[0].harnessHashes);
    assert.deepEqual(report.correctness.mlt.checkpoints, report.correctness.mvt.checkpoints);
    assert.equal(Object.keys(report.images).length, count);
    for (const image of Object.values(report.images)) assert.equal(image.differentPixels, 0);
    writeFileSync(`${production}/${scenario}-results.json.gz`, gzipSync(bytes));
    regressions[scenario] = {checkpoints: count, sha256: sha256(bytes)};
}
for (const path of [...Object.keys(campaigns[0].harnessHashes), 'test/bench/e2e/mlt-styles-validate.mjs', 'test/integration/lib/mlt_strict_worker.ts']) {
    writeFileSync(`${production}/${basename(path)}.gz`, gzipSync(readFileSync(path)));
}
const renderFailures = Object.fromEntries(directories.map((directory, index) => [basename(directory), campaigns[index].renderFailures]));
const hasRenderFailures = campaigns.some(campaign => campaign.renderFailures.length > 0);
const result = {status: hasRenderFailures ? 'render-differences' : 'passed', validatedAt: new Date().toISOString(), productDiffSha256: sha256(diff), renderFailures,
    unit: {passed: unit.numPassedTests, sha256: sha256(unitBytes)}, regressions,
    styleCycles: campaigns[0].styleCycles, checkpointsPerSession: 25, mutationsPerSession: 12 + 5 * campaigns[0].styleCycles,
    campaigns: Object.fromEntries(directories.map(directory => [basename(directory), Object.fromEntries(readdirSync(directory)
        .filter(name => /\.(png|json|gz)$/.test(name) && name !== 'validation.json').map(name => [name, sha256(readFileSync(`${directory}/${name}`))]))]))};
writeFileSync(`${production}/validation.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({status: result.status, tests: result.unit.passed, checkpoints: result.checkpointsPerSession,
    styleCycles: result.styleCycles, mutationsPerSession: result.mutationsPerSession, regressions, renderFailures}, null, 2));
if (hasRenderFailures) process.exitCode = 1;
