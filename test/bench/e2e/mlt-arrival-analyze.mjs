import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {basename} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import {PNG} from 'pngjs';

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function signature(values) { return hash(JSON.stringify(values.map(value => JSON.stringify(canonical(value))).sort())); }
function events(values) { return values.map(value => JSON.stringify(value)).sort(); }
function pixels(directory, first, second) {
    const a = PNG.sync.read(readFileSync(`${directory}/${first}.png`)); const b = PNG.sync.read(readFileSync(`${directory}/${second}.png`));
    assert.equal(a.width, 800); assert.equal(a.height, 600); assert.equal(b.width, a.width); assert.equal(b.height, a.height);
    let different = 0;
    for (let index = 0; index < a.data.length; index += 4) if ([0, 1, 2, 3].some(channel => a.data[index + channel] !== b.data[index + channel])) different++;
    return different;
}
function featureDifference(first, second) {
    const counts = new Map();
    for (const [features, delta] of [[first, 1], [second, -1]]) for (const feature of features) {
        const key = JSON.stringify(canonical(feature)); counts.set(key, (counts.get(key) ?? 0) + delta);
    }
    return [...counts].filter(([, count]) => count !== 0).map(([value, count]) => ({count, feature: JSON.parse(value)}));
}

/** The excluded fields are separately audited as failures, not excused or removed from parity acceptance. */
function nonRenderedState(frame) {
    return {...frame, snapshot: {...frame.snapshot, hashes: {...frame.snapshot.hashes, rendered: null}, counts: {...frame.snapshot.counts, rendered: null}}};
}

/** Diagnoses a complete failed delivery run and keeps a nonzero exit status whenever parity is not exact. */
function main() {
    const [directory, serverUnit] = process.argv.slice(2); assert.ok(directory && serverUnit);
    const report = JSON.parse(readFileSync(`${directory}/results.json`));
    assert.equal(report.status, 'failed'); assert.equal(report.runs, 2); assert.equal(report.gpuMode, 'hardware'); assert.equal(report.strict, false);
    assert.equal(report.productDiff, execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}));
    for (const [path, value] of Object.entries(report.harnessHashes)) assert.equal(hash(readFileSync(path)), value);
    for (const [path, entry] of Object.entries(report.manifest)) assert.equal(hash(readFileSync(path)), entry.sha256);
    const expected = [];
    for (let run = 1; run <= 2; run++) for (const order of ['forward', 'reverse']) for (const encoding of run % 2 ? ['mvt', 'mlt'] : ['mlt', 'mvt']) expected.push(`${run}-${order}-${encoding}`);
    assert.deepEqual(Object.keys(report.sessions), expected);
    const raw = new Map();
    for (const [key, frame] of Object.entries(report.captures)) {
        const queries = JSON.parse(gunzipSync(readFileSync(`${directory}/${key}.json.gz`))); raw.set(key, queries);
        for (const [name, values] of Object.entries({...queries.source, rendered: queries.rendered})) {
            assert.equal(signature(values), frame.snapshot.hashes[name]); assert.equal(values.length, frame.snapshot.counts[name]);
        }
    }
    const comparisons = []; const repeated = []; const orders = [];
    for (const [name, session] of Object.entries(report.sessions)) {
        assert.deepEqual(session.errors, []); assert.equal(session.terminal.pending, 0); assert.equal(session.terminal.idle, true);
        assert.equal(session.terminal.moving, false); assert.equal(session.terminal.tilesLoaded, true);
        assert.equal(session.terminal.renders, session.captures.length);
        assert.deepEqual(session.disposal, {pendingAfterRemove: 0, canvases: 0, clockRestored: true, schedulerRestored: true});
        assert.equal(session.deliveries.length, 12); assert.ok(!session.deliveries.some(event => event.type === 'aborted'));
        const tiles = ['14-8802-5374', '14-8802-5375', '14-8803-5374', '14-8803-5375'];
        const order = session.order === 'forward' ? tiles : [...tiles].reverse();
        const arrivals = session.terminal.events.filter(event => event.source === 'arrival' && event.type === 'sourcedata' && event.tile);
        assert.deepEqual(arrivals.map(event => ({time: event.time, tile: event.tile.split('/').slice(2).join('-')})),
            order.map((tile, index) => ({time: (index + 1) * 500, tile})));
        assert.deepEqual(session.captures.slice(0, 10), [`${name}-bootstrap`, ...Array.from({length: 9}, (_, index) => `${name}-frame-${index}`)]);
        for (let step = 0; step <= 8; step++) {
            const frame = report.captures[`${name}-frame-${step}`]; const delivered = Math.floor(step / 2);
            assert.equal(frame.time, step * 250); assert.equal(frame.clockTime, 1000000 + step * 250);
            assert.deepEqual(frame.arrivals, order.slice(0, delivered).sort()); assert.equal(frame.sourcesLoaded.arrival, delivered === 4);
        }
        if (session.encoding === 'mvt') {
            const other = report.sessions[name.replace(/-mvt$/, '-mlt')];
            assert.equal(session.captures.length, other.captures.length);
            assert.deepEqual(events(session.terminal.events), events(other.terminal.events)); assert.deepEqual(session.terminal.barriers, other.terminal.barriers);
            assert.deepEqual(events(session.deliveries), events(other.deliveries));
            for (const key of session.captures) {
                const paired = key.replace('-mvt-', '-mlt-');
                const a = raw.get(key); const b = raw.get(paired);
                comparisons.push({actual: key, reference: paired, pixels: pixels(directory, key, paired),
                    stateEqual: isDeepStrictEqual(report.captures[key], report.captures[paired]),
                    nonRenderedStateEqual: isDeepStrictEqual(nonRenderedState(report.captures[key]), nonRenderedState(report.captures[paired])),
                    sourcesEqual: isDeepStrictEqual(a.source, b.source), differences: featureDifference(a.rendered, b.rendered)});
            }
        }
        if (session.run > 1) for (const key of session.captures) {
            const first = key.replace(/^\d+-/, '1-');
            repeated.push({actual: key, reference: first, pixels: pixels(directory, key, first), stateEqual: isDeepStrictEqual(report.captures[key], report.captures[first])});
        }
        if (session.order !== 'reverse') continue;
        const first = report.sessions[name.replace('-reverse-', '-forward-')];
        const key = session.captures.at(-1); const paired = first.captures.at(-1);
        orders.push({actual: key, reference: paired, pixels: pixels(directory, key, paired), stateEqual: isDeepStrictEqual(report.captures[key], report.captures[paired])});
    }
    const failures = comparisons.filter(item => item.pixels || !item.stateEqual || item.differences.length);
    assert.ok(failures.length > 0);
    const unit = JSON.parse(readFileSync(serverUnit)); assert.equal(unit.success, true); assert.equal(unit.numPassedTests, 1); assert.equal(unit.numFailedTests, 0);
    const result = {status: 'partial-arrival-parity-failed', sessions: expected.length, captures: raw.size, sourceDiffSha256: hash(report.productDiff),
        comparisons, repeated, orders, failures: failures.length, sources: {}, files: {},
        diagnosis: 'Points in an unfiltered line layer are returned by MVT rendered queries but absent from MLT. Pixel equality does not certify query parity; no geometry filter or tolerance added.'};
    for (const path of [...Object.keys(report.harnessHashes), 'test/bench/e2e/mlt-arrival-analyze.mjs', 'test/bench/e2e/mlt-arrival-validate.mjs', 'test/bench/e2e/mlt-arrival-server.test.ts']) {
        result.sources[path] = hash(readFileSync(path)); writeFileSync(`${directory}/${basename(path)}.gz`, gzipSync(readFileSync(path)));
    }
    writeFileSync(`${directory}/server-unit.json.gz`, gzipSync(readFileSync(serverUnit)));
    result.files = Object.fromEntries(readdirSync(directory).filter(name => /\.(png|json|gz)$/.test(name) && name !== 'audit.json')
        .map(name => [name, hash(readFileSync(`${directory}/${name}`))]));
    writeFileSync(`${directory}/audit.json`, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({status: result.status, sessions: result.sessions, captures: result.captures, pairs: comparisons.length,
        failures: failures.length, pixelFailures: comparisons.filter(item => item.pixels).length,
        otherStateFailures: comparisons.filter(item => !item.nonRenderedStateEqual).length,
        repeatFailures: repeated.filter(item => item.pixels || !item.stateEqual).length, orderFailures: orders.filter(item => item.pixels || !item.stateEqual).length,
        first: failures[0]}, null, 2));
    process.exitCode = 1;
}

main();
