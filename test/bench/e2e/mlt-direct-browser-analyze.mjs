import assert from 'node:assert/strict';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';

const [directory, output] = process.argv.slice(2);
assert.ok(directory && output && !existsSync(output), 'Pass a browser campaign directory and a new JSON output');
const evidence = {};

/** Records the exact inputs consumed by this browser-only comparison, not a whole-product qualification. */
function read(path) {
    const bytes = readFileSync(path);
    evidence[path] = createHash('sha256').update(bytes).digest('hex');
    return bytes;
}

function median(values) {
    const sorted = values.toSorted((a, b) => a - b);
    assert.ok(sorted.length && sorted.every(Number.isFinite));
    return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
}

const report = JSON.parse(read(`${directory}/results.json`));
assert.equal(report.status, 'passed');
assert.equal(report.sessions.length, Number(report.options.runs) * 4);
for (const manifest of Object.values(report.manifests)) {
    for (const [path, expected] of Object.entries(manifest)) {
        read(path); assert.equal(evidence[path], expected.sha256, path);
    }
}
for (const [name, expected] of Object.entries(report.harnessHashes)) {
    const path = `test/bench/e2e/${name}`; read(path); assert.equal(evidence[path], expected, path);
}
const hashes = new Set();
let referencePixels;
const metrics = ['firstRenderMs', 'idleMs', 'firstQueryMs'];
for (const session of report.sessions) {
    assert.equal(session.rows.length, Number(report.options.samples) * 2);
    assert.ok(session.firstOverzoom, 'First-overzoom measurement is required');
    for (const row of [session.firstOverzoom, ...session.rows]) {
        for (const key of metrics) assert.ok(Number.isFinite(row[key]) && row[key] > 0);
        assert.ok(row.counts.source > 0 && row.counts.rendered > 0);
        hashes.add(JSON.stringify(row.hashes));
    }
    for (const cache of ['cold', 'warm']) {
        assert.equal(session.rows.filter(row => row.cache === cache).length, Number(report.options.samples));
    }
    const png = PNG.sync.read(read(session.image));
    assert.equal(png.width, 800); assert.equal(png.height, 600);
    referencePixels ??= png.data; assert.deepEqual(png.data, referencePixels, session.image);
}
assert.equal(hashes.size, 1);

const variants = [];
for (const version of ['before', 'after']) for (const encoding of ['mvt', 'mlt']) {
    const sessions = report.sessions.filter(session => session.version === version && session.encoding === encoding);
    assert.equal(sessions.length, Number(report.options.runs));
    assert.equal(new Set(sessions.map(session => session.run)).size, sessions.length);
    const urlReloads = {};
    for (const cache of ['cold', 'warm']) {
        const sessionMedians = sessions.map(session => Object.fromEntries(metrics.map(key =>
            [key, median(session.rows.filter(row => row.cache === cache).map(row => row[key]))])));
        urlReloads[cache === 'cold' ? 'uniqueURL' : 'reusedURL'] = {sessionMedians,
            medianOfSessionMedians: Object.fromEntries(metrics.map(key => [key, median(sessionMedians.map(row => row[key]))]))};
    }
    const firstOverzoom = Object.fromEntries(metrics.map(key => {
        const samples = sessions.map(session => session.firstOverzoom[key]);
        return [key, {samples, median: median(samples)}];
    }));
    const memory = {};
    for (const phase of ['loaded', 'source-removed', 'map-removed']) {
        const snapshots = sessions.map(session => session.memory.filter(row => row.phase === phase).at(-1).heaps);
        memory[phase] = {};
        for (const target of ['main', 'workers']) {
            memory[phase][target] = Object.fromEntries(['usedSize', 'backingStorageSize'].map(key => {
                const samples = snapshots.map(snapshot => target === 'main' ? snapshot.main[key] : snapshot.workers.reduce((sum, worker) => sum + worker[key], 0));
                return [key, {samples, median: median(samples)}];
            }));
        }
    }
    variants.push({version, encoding, urlReloads, firstOverzoom, memory});
}
writeFileSync(output, JSON.stringify({status: 'verified-browser-comparison', checkedAt: new Date().toISOString(),
    limitation: report.limitation, evidence, imageComparisons: report.sessions.length, queryHashes: [...hashes],
    runs: Number(report.options.runs), samplesPerURLStatePerRun: Number(report.options.samples), variants}, null, 2));
console.log(`Verified ${report.sessions.length} sessions; saved ${output}`);
