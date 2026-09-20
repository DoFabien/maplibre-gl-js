import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';

function median(values) {
    const sorted = values.toSorted((a, b) => a - b);
    const position = (sorted.length - 1) / 2;
    return (sorted[Math.floor(position)] + sorted[Math.ceil(position)]) / 2;
}

function range(values) {
    return {median: median(values), min: Math.min(...values), max: Math.max(...values), campaigns: values};
}

const [beforePath, afterPath, outputPath] = process.argv.slice(2);
const before = JSON.parse(readFileSync(beforePath));
const after = JSON.parse(readFileSync(afterPath));
assert.equal(before.node, after.node);
assert.equal(before.cpu, after.cpu);
assert.equal(before.iterations, after.iterations);
assert.equal(before.warmup, after.warmup);
const comparisons = after.pairs.map(pair => {
    const original = before.pairs.find(item => item.candidate === pair.candidate);
    assert(original, `Missing before pair ${pair.candidate}`);
    assert.deepEqual(pair.parameters, original.parameters);
    assert.equal(pair.operation, original.operation);
    assert.equal(pair.campaigns.length, 3);
    assert.equal(original.campaigns.length, 3);
    const timings = {};
    for (const key of ['ratioMedian', 'ratioP95', 'mvtMsPerOperation', 'mltMsPerOperation', 'mltP95MsPerOperation']) {
        timings[key] = {
            before: range(original.campaigns.map(c => c[key])),
            after: range(pair.campaigns.map(c => c[key])),
        };
    }
    const originalMemory = before.individual.find(b => b.name === pair.candidate);
    const newMemory = after.individual.find(b => b.name === pair.candidate);
    const memory = {};
    for (const key of Object.keys(originalMemory.campaigns[0].memoryBytes)) {
        memory[key] = {
            before: range(originalMemory.campaigns.map(c => c.memoryBytes[key])),
            after: range(newMemory.campaigns.map(c => c.memoryBytes[key])),
        };
    }
    const counters = {before: originalMemory.campaigns.map(c => c.materializations), after: newMemory.campaigns.map(c => c.materializations)};
    for (const [index, current] of counters.after.entries()) {
        for (const key of ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers', 'propertyProxyMisses', 'coordinateTuples', 'rawTileBytesCopied', 'rawTileMainThreadDecodes', 'mvtReencodes', 'propertyDescriptors']) {
            assert(Object.hasOwn(current, key), `Missing ${key} in ${pair.candidate}`);
            assert.equal(current[key], 0, `${key} in ${pair.candidate}`);
        }
        for (const key of ['queryCandidates', 'queryResults', 'propertyObjects', 'pointObjects', 'geometryPartsMaterialized']) {
            assert.equal(current[key], counters.before[index][key], `${key} changed in ${pair.candidate}`);
        }
        if (pair.parameters.resultAccess === 'none') {
            assert.equal(current.propertyObjects, 0);
            assert.equal(current.pointObjects, 0);
            assert.equal(current.geometryPartsMaterialized, 0);
        }
    }
    const medianTimeRatio = timings.mltMsPerOperation.after.median / timings.mltMsPerOperation.before.median;
    return {name: pair.candidate, timings, medianTimeRatio, memory, counters};
});
const result = {beforeCommit: before.commit, afterCommit: after.commit, node: after.node, cases: after.benchmarksPerCampaign, pairs: comparisons};
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.table(comparisons.map(c => ({name: c.name, beforeMs: c.timings.mltMsPerOperation.before.median.toFixed(3), afterMs: c.timings.mltMsPerOperation.after.median.toFixed(3), gainPct: (100 * (1 - c.medianTimeRatio)).toFixed(1), beforeRatio: c.timings.ratioMedian.before.median.toFixed(3), afterRatio: c.timings.ratioMedian.after.median.toFixed(3)})));
