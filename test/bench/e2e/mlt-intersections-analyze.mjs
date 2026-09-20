import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {summarizeNumbers} from '../lib/mlt_benchmark_statistics.ts';

/** Compares session medians within each balanced four-version block, retaining the unchanged MVT control. */
const directory = process.argv[2];
assert.ok(directory, 'Pass a completed --phase compare directory');
const report = JSON.parse(readFileSync(`${directory}/results.json`, 'utf8'));
assert.equal(report.status, 'passed');
assert.equal(report.phase, 'compare');
assert.equal(report.comparisons.length, report.runs * 4);
assert.ok(report.runs >= 4 && report.runs % 4 === 0, 'Use complete four-block order rotations');
for (const encoding of ['mvt', 'mlt']) {
    assert.deepEqual(report.referenceCorrectness[encoding].checkpoints, report.correctness[encoding].checkpoints);
}
assert.deepEqual(report.correctness.mvt.checkpoints, report.correctness.mlt.checkpoints);

function session(run, version, encoding, pose) {
    const entries = report.comparisons.filter(entry => entry.run === run && entry.version === version && entry.encoding === encoding);
    assert.equal(entries.length, 1);
    const result = entries[0].result.poses.find(entry => entry.pose === pose);
    assert.equal(result.samples.length, 50);
    return result;
}

const comparisons = [];
for (const pose of [2, 0, 1]) {
    const rows = [];
    for (let run = 1; run <= report.runs; run++) {
        const metrics = {};
        for (const metric of ['queryMs', 'materializeMs', 'stringifyMs', 'totalMs']) {
            const beforeMvt = session(run, 'before', 'mvt', pose);
            const beforeMlt = session(run, 'before', 'mlt', pose);
            const afterMvt = session(run, 'after', 'mvt', pose);
            const afterMlt = session(run, 'after', 'mlt', pose);
            for (const result of [beforeMvt, beforeMlt, afterMvt, afterMlt]) {
                assert.equal(result.samples[0].count, beforeMvt.samples[0].count);
            }
            const values = [beforeMvt, beforeMlt, afterMvt, afterMlt].map(result => result.summary[metric].median);
            metrics[metric] = {beforeMvt: values[0], beforeMlt: values[1], afterMvt: values[2], afterMlt: values[3],
                mltAfterBefore: values[3] / values[1], mvtAfterBefore: values[2] / values[0],
                afterMltMvt: values[3] / values[2], beforeMltMvt: values[1] / values[0]};
        }
        rows.push({run, metrics});
    }
    comparisons.push({pose, count: session(1, 'after', 'mlt', pose).samples[0].count, rows,
        summary: Object.fromEntries(['queryMs', 'materializeMs', 'stringifyMs', 'totalMs'].map(metric => [metric,
            Object.fromEntries(Object.keys(rows[0].metrics[metric]).map(key =>
                [key, summarizeNumbers(rows.map(row => row.metrics[metric][key]))]))]))});
}
const result = {comparisons, note: 'R7 summaries of four paired session medians; descriptive same-desktop measurements, not a confidence interval or a frame-rate result.'};
writeFileSync(`${directory}/analysis.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
