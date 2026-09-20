import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import minimist from 'minimist';
import {sha256, signature, difference} from './mlt-geography.ts';

const args = minimist(process.argv.slice(2));
assert.ok(args.timing && args.allocations && args.parity && args.output);
const variants = ['mvt', 'varint', 'fastpfor'];
const orders = [['mvt', 'varint', 'fastpfor'], ['varint', 'fastpfor', 'mvt'], ['fastpfor', 'mvt', 'varint'],
    ['fastpfor', 'varint', 'mvt'], ['varint', 'mvt', 'fastpfor'], ['mvt', 'fastpfor', 'varint']];
const timing = read(`${args.timing}/results.json`);
const allocations = read(`${args.allocations}/results.json`);
const parity = (Array.isArray(args.parity) ? args.parity : [args.parity]).map(path => read(`${path}/results.json`));
const audit = read(timing.inputAudit.path);
assert.equal(audit.status, 'failed');
assert.deepEqual(audit.tiles.flatMap(tile => tile.layers.filter(layer => layer.status !== 'passed').map(layer =>
    ({tile: tile.name, layer: layer.name, error: layer.error}))), [{tile: '14-8803-5374', layer: 'contour',
    error: 'RangeError: start offset of Int32Array should be a multiple of 4'}]);
const metrics = []; const allocated = []; let imagesChecked = 0; let queriesChecked = 0; let samplesChecked = 0;
const globalQueries = new Map<string, unknown>();
for (const report of [timing, allocations, ...parity]) {
    assert.equal(report.status, 'passed');
    assert.equal(report.sessions.length, report.options.runs * 3);
    assert.equal(sha256(readFileSync(report.inputAudit.path)), report.inputAudit.sha256);
    for (const [name, hash] of Object.entries(report.harnessHashes)) {
        const current = sha256(readFileSync(`test/bench/e2e/${name}`));
        if (current === hash) continue;
        assert.equal(name, 'mlt-fastpfor-browser.ts');
        const snapshots = ['fastpfor-measured-harness-20260908.ts', 'fastpfor-allocations-harness-20260908.ts'];
        assert.ok(snapshots.some(snapshot => sha256(readFileSync(`test/bench/baselines/${snapshot}`)) === hash), name);
    }
    for (const manifest of Object.values(report.manifests)) verifyManifest(manifest);
    for (let run = 0; run < report.options.runs; run++) {
        assert.deepEqual(report.sessions.filter(session => session.run === run).map(session => session.variant), orders[run % 6]);
    }
    const firstImages = new Map<string, string>();
    for (const session of report.sessions) {
        const phases = report.options.mode === 'allocations' ? ['native'] : ['native', 'overzoom'];
        assert.deepEqual(session.phases.map(phase => phase.phase), phases);
        for (const result of session.phases) {
            const queries = JSON.parse(gunzipSync(readFileSync(result.queries)).toString());
            const hashes = Object.fromEntries(['source', 'rendered'].map(key => {
                assert.equal(queries[key].length, result.counts[key]);
                assert.equal(signature(queries[key]), result.hashes[key]);
                return [key, result.hashes[key]];
            }));
            if (globalQueries.has(result.phase)) assert.deepEqual(hashes, globalQueries.get(result.phase)); else globalQueries.set(result.phase, hashes);
            if (firstImages.has(result.phase)) assert.equal(difference(result.image, firstImages.get(result.phase)).pixels, 0);
            else firstImages.set(result.phase, result.image);
            imagesChecked++; queriesChecked++;
            if (report.options.strict) validateStats(result, session.variant);
            if (report.options.mode !== 'timing') continue;
            assert.equal(result.rows.length, report.options.samples);
            for (const sample of [result.first, ...result.rows]) {
                assert.deepEqual(sample.hashes, hashes); assert.deepEqual(sample.counts, result.counts);
                for (const value of Object.values(sample.times)) assert.ok(Number.isFinite(value) && Number(value) > 0);
                samplesChecked++;
            }
        }
        for (const item of session.profiles) {
            const bytes = readFileSync(item.file); assert.equal(sha256(bytes), item.sha256);
            const profile = JSON.parse(gunzipSync(bytes).toString());
            assert.equal(sumProfile(profile.head), item.summary.totalBytes);
            assert.equal(profile.samples.length, item.summary.samples);
            assert.equal(Object.values(item.summary.selfBytes).reduce((sum: number, value: number) => sum + value, 0), item.summary.totalBytes);
        }
    }
}
for (const variant of variants) {
    for (const phase of ['native', 'overzoom']) {
        const sessions = timing.sessions.filter(session => session.variant === variant);
        const medians = sessions.map(session => Object.fromEntries(['firstRenderMs', 'settledMs', 'queryMs'].map(key =>
            [key, median(session.phases.find(result => result.phase === phase).rows.map(row => row.times[key]))])));
        const aggregate = Object.fromEntries(Object.keys(medians[0]).map(key => [key, median(medians.map(row => row[key]))]));
        assert.deepEqual(timing.summary.find(row => row.variant === variant && row.phase === phase).sessionMedians, medians);
        assert.deepEqual(timing.summary.find(row => row.variant === variant && row.phase === phase).medianOfSessionMedians, aggregate);
        metrics.push({variant, phase, medians, aggregate});
    }
    const sessions = allocations.sessions.filter(session => session.variant === variant);
    const rows = sessions.map(session => Object.fromEntries(session.profiles.map(profile => [profile.context, profile.summary.totalBytes])));
    const aggregate = Object.fromEntries(['main', 'worker'].map(key => [key, median(rows.map(row => row[key]))]));
    assert.deepEqual(allocations.summary.find(row => row.variant === variant), {variant, ...aggregate});
    allocated.push({variant, rows, aggregate});
}
const sizes = Object.fromEntries(variants.map(variant => [variant, {
    bytes: audit.tiles.reduce((sum, tile) => sum + tile[variant].bytes, 0),
    gzip: audit.tiles.reduce((sum, tile) => sum + tile[variant].gzip, 0)
}]));
const deltas = [];
for (const [candidate, baseline] of [['fastpfor', 'varint'], ['fastpfor', 'mvt'], ['varint', 'mvt']]) {
    for (const phase of ['native', 'overzoom']) {
        const a = metrics.find(row => row.variant === candidate && row.phase === phase);
        const b = metrics.find(row => row.variant === baseline && row.phase === phase);
        deltas.push({candidate, baseline, phase, percent: Object.fromEntries(Object.keys(a.aggregate).map(key => [key, percent(a.aggregate[key], b.aggregate[key])])),
            pairedDrawPercent: a.medians.map((row, index) => percent(row.firstRenderMs, b.medians[index].firstRenderMs))});
    }
    deltas.push({candidate, baseline, allocationPercent: percent(allocated.find(row => row.variant === candidate).aggregate.worker,
        allocated.find(row => row.variant === baseline).aggregate.worker), gzipPercent: percent(sizes[candidate].gzip, sizes[baseline].gzip)});
}
const checkpoint = read('test/bench/baselines/pretriangulated-checkpoint-20260908/checkpoint.json');
for (const [repo, base] of [['gl', 'src'], ['mlt', '../maplibre-tile-spec/ts/src']]) {
    for (const [path, expected] of Object.entries(checkpoint.sources[repo])) assert.equal(sha256(readFileSync(`${base}/${path}`)), expected, path);
}
const previous = read('test/bench/baselines/browser-pretriangulated-production-20260908/results.json');
for (const [path, expected] of Object.entries(previous.manifests.after).filter(([path]) => path.startsWith('dist/'))) verifyManifest({[path]: expected});
const result = {status: 'passed-with-global-input-parity-failure', checkedAt: new Date().toISOString(), imagesChecked, queriesChecked, samplesChecked,
    sourceFilesUnchanged: {gl: Object.keys(checkpoint.sources.gl).length, mlt: Object.keys(checkpoint.sources.mlt).length},
    metrics, allocated, sizes, deltas,
    inputLayers: {total: audit.tiles.reduce((sum, tile) => sum + tile.layers.length, 0), failures: timing.inputAudit.failures},
    streams: audit.tiles.flatMap(tile => tile.afterStreams).reduce((counts, stream) => {
        counts[stream.technique] = (counts[stream.technique] ?? 0) + 1; return counts;
    }, {}),
    evidence: [args.timing, args.allocations, ...(Array.isArray(args.parity) ? args.parity : [args.parity])]};
writeFileSync(args.output, JSON.stringify(result, null, 2), {flag: 'wx'});
console.log(JSON.stringify({status: result.status, imagesChecked, queriesChecked, samplesChecked, sizes, deltas}, null, 2));

function read(path: string) { return JSON.parse(readFileSync(path, 'utf8')); }
function verifyManifest(manifest): void {
    for (const [path, expected] of Object.entries(manifest) as any[]) assert.equal(sha256(readFileSync(path)), expected.sha256, path);
}
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
    assert.ok(sorted.length && sorted.every(Number.isFinite));
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function percent(candidate: number, baseline: number): number { return 100 * (candidate / baseline - 1); }
function sumProfile(node): number { return node.selfSize + node.children.reduce((sum, child) => sum + sumProfile(child), 0); }

/** Verifies both absence of object-materialization fallbacks and positive use of the supplied fill mesh. */
function validateStats(result, variant: string): void {
    assert.equal(result.stats.length, 1); const stats = result.stats[0]; assert.equal(stats.forbidden.length, 10);
    for (const key of [...stats.forbidden, 'propertyProxyMisses']) assert.equal(stats.counters[key], 0);
    if (variant === 'mvt') { assert.equal(stats.counters.decodedLayers, 0); return; }
    assert.ok(stats.counters.decodedLayers > 0);
    if (result.phase !== 'native') return;
    assert.ok(stats.counters.pretriangulatedFillFeatures > 0);
    assert.ok(stats.counters.pretriangulatedFillTriangles > 0);
}
