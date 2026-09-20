import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {resolve} from 'node:path';

/** R7 quantiles, without pooling sessions or interpreting a ratio of p95 values as a paired p95. */
function distribution(values) {
    const sorted = [...values].sort((a, b) => a - b);
    function quantile(fraction) {
        const position = (sorted.length - 1) * fraction;
        return sorted[Math.floor(position)] + (sorted[Math.ceil(position)] - sorted[Math.floor(position)]) * (position % 1);
    }
    return {count: values.length, median: quantile(0.5), p95: quantile(0.95), min: sorted[0], max: sorted.at(-1)};
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function geometryShape(value) {
    return Array.isArray(value) ? value.map(geometryShape) : 0;
}

function groupFeatures(features) {
    const groups = new Map();
    for (const feature of features) {
        const key = JSON.stringify(canonical({...feature, geometry: {type: feature.geometry.type}}));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(feature);
    }
    return groups;
}

function latitudeUnits(latitude, z) {
    const phi = latitude * Math.PI / 180;
    return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) * 0.5 * 2 ** z * 4096;
}

/** Cancels exact geometries first; ambiguous clipped duplicates are counted without inventing point correspondences. */
function geometryComparison(first, second) {
    const a = groupFeatures(first);
    const b = groupFeatures(second);
    assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
    const result = {features: first.length, duplicateAttributeGroups: 0, differentGeometries: 0,
        ambiguousGeometries: 0, shapeMismatches: 0, maxLongitudeDelta: 0, maxLatitudeDelta: 0, maxSourceTileUnitDelta: 0};
    for (const [key, rows] of a) {
        const other = [...b.get(key)];
        assert.equal(rows.length, other.length);
        if (rows.length > 1) result.duplicateAttributeGroups++;
        const unmatched = rows.filter(row => {
            const match = other.findIndex(candidate => JSON.stringify(candidate.geometry) === JSON.stringify(row.geometry));
            if (match < 0) return true;
            other.splice(match, 1);
            return false;
        });
        result.differentGeometries += unmatched.length;
        if (unmatched.length > 1) {
            result.ambiguousGeometries += unmatched.length;
            continue;
        }
        for (let i = 0; i < unmatched.length; i++) {
            const x = unmatched[i].geometry.coordinates;
            const y = other[i].geometry.coordinates;
            if (JSON.stringify(geometryShape(x)) !== JSON.stringify(geometryShape(y))) {
                result.shapeMismatches++;
                continue;
            }
            const left = x.flat(Infinity);
            const right = y.flat(Infinity);
            for (let coordinate = 0; coordinate < left.length; coordinate += 2) {
                const longitudeDelta = Math.abs(left[coordinate] - right[coordinate]);
                const latitudeDelta = Math.abs(left[coordinate + 1] - right[coordinate + 1]);
                result.maxLongitudeDelta = Math.max(result.maxLongitudeDelta, longitudeDelta);
                result.maxLatitudeDelta = Math.max(result.maxLatitudeDelta, latitudeDelta);
                if (!unmatched[i].tile) continue;
                const z = unmatched[i].tile.z;
                result.maxSourceTileUnitDelta = Math.max(result.maxSourceTileUnitDelta,
                    longitudeDelta / 360 * 2 ** z * 4096,
                    Math.abs(latitudeUnits(left[coordinate + 1], z) - latitudeUnits(right[coordinate + 1], z)));
            }
        }
    }
    return result;
}

const directory = resolve(process.argv[2]);
const data = JSON.parse(readFileSync(`${directory}/results.json`));
const analysis = {status: data.status, geometry: {}, timings: [], memory: [], corpus: {}};
for (const name of Object.keys(data.correctness.mvt.checkpoints)) {
    const [mvt, mlt] = ['mvt', 'mlt'].map(encoding => JSON.parse(gunzipSync(readFileSync(`${directory}/${encoding}-${name}.json.gz`))));
    analysis.geometry[name] = {source: geometryComparison(mvt.source, mlt.source), rendered: geometryComparison(mvt.rendered, mlt.rendered)};
}
for (let run = 1; run <= data.runs; run++) {
    const mvt = data.timings.find(entry => entry.run === run && entry.encoding === 'mvt')?.result;
    const mlt = data.timings.find(entry => entry.run === run && entry.encoding === 'mlt')?.result;
    if (!mvt || !mlt) continue;
    const ratios = {};
    for (const metric of Object.keys(mvt.summary.timings)) {
        ratios[metric] = mlt.summary.timings[metric].median / mvt.summary.timings[metric].median;
    }
    analysis.timings.push({run, sessionMedianRatios: ratios, mvt: mvt.summary, mlt: mlt.summary});
}
for (const {run, encoding, result} of data.memory) {
    const samples = result.samples.map(sample => ({
        phase: sample.phase, cycle: sample.cycle, workers: sample.workers.length,
        mainHeap: sample.main.usedSize, workerHeap: sample.workers.reduce((sum, heap) => sum + heap.usedSize, 0),
        mainBacking: sample.main.backingStorageSize,
        workerBacking: sample.workers.reduce((sum, heap) => sum + heap.backingStorageSize, 0)
    }));
    const tail = samples.filter(sample => sample.phase === 'loaded').slice(-5);
    analysis.memory.push({run, encoding, samples,
        lastFiveCheckpoints: Object.fromEntries(['mainHeap', 'workerHeap', 'mainBacking', 'workerBacking']
            .map(key => [key, distribution(tail.map(sample => sample[key]))]))});
}
for (const encoding of ['mvt', 'mlt']) {
    const files = Object.entries(data.manifest).filter(([path]) => path.endsWith(`.${encoding}`));
    analysis.corpus[encoding] = {files: files.length, payloadBytes: files.reduce((sum, [, file]) => sum + file.bytes, 0)};
}
writeFileSync(`${directory}/analysis.json`, `${JSON.stringify(analysis, null, 2)}\n`);
console.log(JSON.stringify(analysis, null, 2));
