import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {basename, resolve} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import {PNG} from 'pngjs';

function json(path) { return JSON.parse(readFileSync(path)); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function features(values) { return values.map(value => JSON.stringify(canonical(value))).sort(); }
function queries(directory, key) { return JSON.parse(gunzipSync(readFileSync(`${directory}/${key}.json.gz`))); }

/** Subtracts sorted multisets without discarding duplicate public query results. */
function addedFeatures(before, after) {
    let index = 0; const added = [];
    for (const value of after) {
        if (before[index] === value) index++;
        else added.push(JSON.parse(value));
    }
    assert.equal(index, before.length, 'An old query entry was removed or changed');
    return added;
}

/** Checks that the fix only restores the missing query entries, leaving the old MVT oracle and every pixel unchanged. */
function main() {
    const [before, after, red, targeted, unit, build, integration, server, initialBuild, render, renderStats, renderMetadata, ...logs] = process.argv.slice(2);
    assert.ok(renderMetadata, 'Expected before/after directories, eight Vitest reports, render counters/metadata and optional build logs');
    const previous = json(`${before}/results.json`); const current = json(`${after}/results.json`);
    const certificate = json(`${after}/validation.json`);
    assert.equal(previous.status, 'failed'); assert.equal(current.status, 'passed');
    assert.equal(certificate.status, 'verified-controlled-partial-arrivals');
    assert.equal(certificate.sourceDiffSha256, hash(current.productDiff));
    assert.deepEqual(current.harnessHashes, previous.harnessHashes);
    assert.equal(Object.keys(current.manifest).length, Object.keys(previous.manifest).length);
    for (const [path, entry] of Object.entries(previous.manifest)) {
        const currentPath = path.startsWith(`${resolve(before)}/`) ? `${resolve(after)}/${path.slice(resolve(before).length + 1)}` : path;
        if (!path.startsWith('dist/')) assert.deepEqual(current.manifest[currentPath], entry);
    }
    assert.deepEqual(Object.keys(current.captures), Object.keys(previous.captures));
    let restoredFrames = 0; let restoredEntries = 0; let unchangedMvtFrames = 0;
    for (const key of Object.keys(current.captures)) {
        const oldPixels = PNG.sync.read(readFileSync(`${before}/${key}.png`));
        const newPixels = PNG.sync.read(readFileSync(`${after}/${key}.png`));
        assert.equal(newPixels.width, oldPixels.width); assert.equal(newPixels.height, oldPixels.height);
        assert.ok(newPixels.data.equals(oldPixels.data), `Pixels changed: ${key}`);
        const oldQueries = queries(before, key); const newQueries = queries(after, key);
        assert.deepEqual(Object.keys(newQueries.source).sort(), Object.keys(oldQueries.source).sort());
        for (const source of Object.keys(newQueries.source)) assert.deepEqual(features(newQueries.source[source]), features(oldQueries.source[source]));
        const referenceKey = key.replace('-mlt-', '-mvt-');
        assert.deepEqual(current.captures[key], previous.captures[referenceKey]);
        assert.deepEqual(features(newQueries.rendered), features(queries(before, referenceKey).rendered));
        const oldFeatures = features(oldQueries.rendered); const newFeatures = features(newQueries.rendered);
        const added = addedFeatures(oldFeatures, newFeatures);
        if (key.includes('-mvt-')) { assert.deepEqual(added, []); unchangedMvtFrames++; }
        if (!added.length) continue;
        assert.ok(key.includes('-mlt-')); assert.equal(added.length, 2);
        assert.deepEqual(added.map(value => Number(value.id)).sort(), [-29217319, -29276745].sort());
        for (const value of added) {
            assert.equal(value.geometry.type, 'Point'); assert.equal(value.layer.id, 'arrival-roads');
            assert.equal(value.sourceLayer, 'road');
        }
        restoredFrames++; restoredEntries += added.length;
    }
    assert.equal(unchangedMvtFrames, 44); assert.equal(restoredFrames, 20); assert.equal(restoredEntries, 40);
    const tests = {};
    for (const [name, path, count, failures] of [
        ['before', red, 6, 5], ['targeted', targeted, 69, 0], ['unit', unit, 3751, 0],
        ['build', build, 759, 0], ['integration', integration, 178, 0], ['server', server, 1, 0],
        ['initial-build', initialBuild, 759, 2]
    ]) {
        const report = json(path);
        assert.equal(report.success, failures === 0);
        assert.equal(report.numTotalTests, count); assert.equal(report.numFailedTests, failures);
        assert.equal(report.numPassedTests, count - failures); assert.equal(report.numPendingTests, 0);
        tests[name] = {total: count, passed: count - failures, failed: failures, sha256: hash(readFileSync(path))};
        writeFileSync(`${after}/line-index-${name}-tests.json.gz`, gzipSync(readFileSync(path)));
    }
    const renderReport = json(render); const counters = json(renderStats); const metadata = json(renderMetadata);
    assert.equal(renderReport.success, true);
    assert.equal(renderReport.numPassedTests, 243); assert.equal(renderReport.numFailedTests, 0);
    assert.equal(Object.keys(counters).length, 243); assert.equal(metadata.strict, true); assert.equal(metadata.mode, 'software');
    for (const renderer of Object.values(metadata.renderers)) assert.match(renderer.renderer, /swiftshader/i);
    const forbidden = ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers', 'propertyObjects', 'pointObjects', 'geometryPartsMaterialized',
        'overzoomPointObjects', 'mvtReencodes', 'rawTileMainThreadDecodes', 'coordinateTuples', 'propertyDescriptors', 'propertyProxyMisses'];
    let decodedLayers = 0;
    for (const workers of Object.values(counters)) {
        assert.ok(workers.length);
        for (const worker of workers) {
            for (const key of forbidden) assert.equal(worker[key], 0);
            decodedLayers += worker.decodedLayers;
        }
    }
    assert.ok(decodedLayers > 0);
    const renderBundles = Object.fromEntries(['maplibre-gl-dev.mjs', 'maplibre-gl-worker-dev.mjs', 'maplibre-gl-shared-dev.mjs', 'maplibre-gl.css']
        .map(name => [`dist/mlt-validation/${name}`, hash(readFileSync(`dist/mlt-validation/${name}`))]));
    const artifacts = {};
    for (const [name, path] of [['line-index-render-tests.json', render], ['line-index-render-stats.json', renderStats],
        ['line-index-render-metadata.json', renderMetadata], ...logs.map(path => [basename(path), path])]) {
        artifacts[name] = hash(readFileSync(path)); writeFileSync(`${after}/${name}.gz`, gzipSync(readFileSync(path)));
    }
    const sourcePaths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src'], {encoding: 'utf8'}).split('\0').filter(Boolean))].sort();
    const sources = Object.fromEntries(sourcePaths.map(path => [path, hash(readFileSync(path))]));
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', 'src'], {encoding: 'utf8'}).split('\0').filter(Boolean);
    writeFileSync(`${after}/untracked-sources.json.gz`, gzipSync(JSON.stringify(Object.fromEntries(untracked.map(path => [path, readFileSync(path, 'utf8')])))));
    const script = 'test/bench/e2e/mlt-line-index-validate.mjs';
    writeFileSync(`${after}/mlt-line-index-validate.mjs.gz`, gzipSync(readFileSync(script)));
    const audit = {status: 'verified-line-index-fix', previousReportSha256: hash(readFileSync(`${before}/results.json`)),
        currentReportSha256: hash(readFileSync(`${after}/results.json`)), certificateSha256: hash(readFileSync(`${after}/validation.json`)),
        unchangedPixelFrames: Object.keys(current.captures).length, unchangedMvtFrames, restoredFrames, restoredEntries, tests,
        render: {passed: 243, decodedLayers, forbiddenCounters: forbidden, bundles: renderBundles}, artifacts,
        sourceDiffSha256: hash(current.productDiff), sources, validatorSha256: hash(readFileSync(script))};
    writeFileSync(`${after}/line-index-audit.json`, `${JSON.stringify(audit, null, 2)}\n`);
    console.log(JSON.stringify({...audit, sources: `${sourcePaths.length} source hashes`}, null, 2));
}

main();
