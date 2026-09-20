import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {summarizeNumbers} from '../lib/mlt_benchmark_statistics.ts';

/** Compares matching uninstrumented query batches; sampled CPU durations are diagnostic, not benchmark timings. */
function compare(beforePath, afterPath) {
    const before = JSON.parse(readFileSync(`${beforePath}/results.json`, 'utf8'));
    const after = JSON.parse(readFileSync(`${afterPath}/results.json`, 'utf8'));
    for (const report of [before, after]) {
        assert.equal(report.status, 'passed');
        assert.equal(report.phase, 'profile');
        assert.equal(report.profiles.length, report.runs * 2);
        for (const image of Object.values(report.images)) assert.equal(image.differentPixels, 0);
        assert.deepEqual(report.correctness.mlt.checkpoints, report.correctness.mvt.checkpoints);
    }
    assert.deepEqual(before.harnessHashes, after.harnessHashes);
    assert.equal(before.browser, after.browser);
    assert.deepEqual(before.viewport, after.viewport);
    assert.deepEqual(before.correctness.mvt.checkpoints, after.correctness.mvt.checkpoints);
    for (const [path, file] of Object.entries(before.manifest)) {
        if (path.startsWith('test/integration/assets/tiles/')) assert.deepEqual(file, after.manifest[path]);
    }
    const comparisons = [];
    for (const encoding of ['mvt', 'mlt']) for (const pose of [2, 0, 1]) {
        const versions = {};
        for (const [version, report] of [['before', before], ['after', after]]) {
            versions[version] = report.profiles.filter(profile => profile.encoding === encoding).map(profile => {
                const sample = profile.result.poses.find(result => result.pose === pose);
                return {run: profile.run, count: sample.samples[0].count,
                    ...Object.fromEntries(['queryMs', 'materializeMs', 'stringifyMs', 'totalMs'].map(key =>
                        [key, summarizeNumbers(sample.samples.map(value => key === 'totalMs'
                            ? value.queryMs + value.materializeMs + value.stringifyMs : value[key])).median]))};
            });
        }
        assert.equal(versions.before.length, versions.after.length);
        comparisons.push({encoding, pose, ...versions,
            ratios: versions.after.map((value, index) => {
                const reference = versions.before[index];
                assert.equal(value.count, reference.count);
                return Object.fromEntries(['queryMs', 'materializeMs', 'stringifyMs', 'totalMs'].map(key => [key, value[key] / reference[key]]));
            })});
    }
    return {before: beforePath, after: afterPath, comparisons};
}

const [beforePath, afterPath] = process.argv.slice(2).map(path => resolve(path));
assert.ok(beforePath && afterPath, 'Usage: node mlt-query-compare.mjs <before-directory> <after-directory>');
const comparison = compare(beforePath, afterPath);
writeFileSync(`${afterPath}/query-comparison.json`, `${JSON.stringify(comparison, null, 2)}\n`);
console.log(JSON.stringify(comparison, null, 2));
