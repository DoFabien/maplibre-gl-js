import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {PNG} from 'pngjs';
import minimist from 'minimist';
import {summarizePass} from './mlt-navigation-protocol.ts';

const args = minimist(process.argv.slice(2));
assert.ok(args.output && args.timing && args.parity);
const timingPaths = [args.timing].flat().map(resolvePath);
const parityPaths = [args.parity].flat().map(resolvePath);
const timings = timingPaths.map(readResult); const parities = parityPaths.map(readResult);
const reference = timings[0];
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE raw_raf(network TEXT, encoding TEXT, run INTEGER, phase TEXT, idx INTEGER, t REAL);
CREATE TABLE motion_windows(network TEXT, encoding TEXT, run INTEGER, phase TEXT, started REAL, ended REAL);
CREATE TABLE raw_render(network TEXT, encoding TEXT, run INTEGER, phase TEXT, idx INTEGER, t REAL);
CREATE TABLE raw_tile_events(network TEXT, encoding TEXT, run INTEGER, phase TEXT, tile_key TEXT, kind TEXT, idx INTEGER, t REAL);
CREATE TABLE initial_sessions(network TEXT, encoding TEXT, run INTEGER, initial_ms REAL, payload_bytes INTEGER);`);
const rafInsert = db.prepare('INSERT INTO raw_raf VALUES(?,?,?,?,?,?)');
const windowInsert = db.prepare('INSERT INTO motion_windows VALUES(?,?,?,?,?,?)');
const renderInsert = db.prepare('INSERT INTO raw_render VALUES(?,?,?,?,?,?)');
const eventInsert = db.prepare('INSERT INTO raw_tile_events VALUES(?,?,?,?,?,?,?,?)');
const initialInsert = db.prepare('INSERT INTO initial_sessions VALUES(?,?,?,?,?)');
const rows = []; const initial = []; const checks = {images: 0, queryArchives: 0, rawRafSamples: 0, sourceHashes: 0, frames: 0};
for (const [index, result] of timings.entries()) {
    assert.equal(result.status, 'passed'); assert.equal(result.input.status, 'passed');
    assert.equal(result.args.mode, 'timing'); assert.equal(result.args.strict, false);
    assert.ok(result.args.runs >= 4 && result.args.runs % 2 === 0);
    assert.deepEqual(result.route, reference.route); assert.deepEqual(result.sources, reference.sources); assert.deepEqual(result.manifests, reference.manifests);
    assert.deepEqual(result.harness, reference.harness); assert.equal(result.input.hash, reference.input.hash);
    checkHashes(result, timingPaths[index]);
    assert.equal(result.sessions.length, result.args.runs * 2);
    for (const [position, session] of result.sessions.entries()) {
        const expected = Math.floor(position / 2) % 2 ? ['mlt', 'mvt'] : ['mvt', 'mlt'];
        assert.equal(session.encoding, expected[position % 2]); assert.equal(session.run, Math.floor(position / 2));
        assert.equal(session.info.workerCount, 1); assert.deepEqual(session.info.errors, []);
        assert.deepEqual(session.passes.map(pass => pass.phase), ['cold', 'warm']);
        assert.deepEqual(requestKeys(session.initialTraffic), requestKeys(reference.sessions[0].initialTraffic));
        initial.push({network: result.network.name, encoding: session.encoding, run: session.run, initialMs: session.info.firstLoadedDrawMs,
            payloadBytes: session.initialTraffic.reduce((sum, request) => sum + request.sentBytes, 0)});
        const startup = initial.at(-1);
        initialInsert.run(startup.network, startup.encoding, startup.run, startup.initialMs, startup.payloadBytes);
        for (const pass of session.passes) {
            const base = [result.network.name, session.encoding, session.run, pass.phase];
            assert.deepEqual(summarizePass(pass.raw), pass.summary);
            assert.ok(pass.raw.visibility.every(value => value === 'visible'));
            assert.equal(pass.raw.windows.length, result.route.length - 1);
            assert.ok(pass.raw.raf.length > 500);
            const expectedTraffic = reference.sessions[0].passes.find(candidate => candidate.phase === pass.phase).traffic;
            assert.deepEqual(requestKeys(pass.traffic), requestKeys(expectedTraffic), 'Compare the same requested resources, including multiplicity');
            if (pass.phase === 'warm') {
                assert.equal(pass.traffic.length, 0, 'The repeated route must be served from browser/renderer caches');
                assert.equal(pass.summary.tileLoadsCompleted, 0);
            }
            for (const [i, frame] of pass.raw.raf.entries()) rafInsert.run(...base, i, frame.t);
            for (const window of pass.raw.windows) windowInsert.run(...base, window.start, window.end);
            for (const [i, frame] of pass.raw.frames.entries()) renderInsert.run(...base, i, frame.t);
            for (const [i, event] of pass.raw.data.entries()) if (event.tile) eventInsert.run(...base, `${event.overscaledZ}:${event.tile}`, event.kind, i, event.t);
            checks.rawRafSamples += pass.raw.raf.length; checks.frames += pass.raw.frames.length;
            rows.push({network: result.network.name, encoding: session.encoding, run: session.run, phase: pass.phase, ...pass.summary,
                requests: pass.traffic.length, payloadBytes: pass.traffic.reduce((sum, request) => sum + request.sentBytes, 0),
                tileKeys: [...new Set(pass.traffic.filter(request => request.path.startsWith('/tiles/')).map(request => request.path.split('/').at(-1).split('.')[0]))].sort()});
        }
    }
}
const sql = readFileSync('test/bench/e2e/mlt-navigation-statistics.sql', 'utf8');
const sqlRows = db.prepare(sql).all();
assert.equal(sqlRows.length, rows.length * 3 + rows.filter(row => row.tileLoadsCompleted > 0).length * 3);
assert.equal(new Set(sqlRows.map(row => JSON.stringify([row.network, row.encoding, row.run, row.phase, row.metric]))).size, sqlRows.length);
for (const sqlRow of sqlRows) {
    const row = rows.find(row => row.network === sqlRow.network && row.encoding === sqlRow.encoding && row.run === sqlRow.run && row.phase === sqlRow.phase);
    if (sqlRow.metric === 'tileLoadP99Ms') continue;
    assert.ok(Math.abs(row[sqlRow.metric] - sqlRow.value) < 1e-8, `${JSON.stringify(sqlRow)} differs from JavaScript`);
}
const startupSql = readFileSync('test/bench/e2e/mlt-navigation-startup.sql', 'utf8');
const startupRows = db.prepare(startupSql).all();
assert.equal(startupRows.length, timings.length * 2);
db.close();
for (const [index, result] of parities.entries()) {
    assert.equal(result.status, 'passed'); assert.equal(result.input.status, 'passed'); assert.equal(result.args.mode, 'parity');
    assert.equal(result.args.strict, true); assert.deepEqual(result.harness, reference.harness);
    assert.deepEqual(result.route, reference.route); assert.deepEqual(result.sources, reference.sources);
    assert.equal(result.input.hash, reference.input.hash); checkHashes(result, parityPaths[index]);
    const first = result.sessions[0];
    for (const session of result.sessions) {
        assert.equal(session.checkpoints.length, result.route.length);
        for (const checkpoint of session.checkpoints) {
            const i = checkpoint.index;
            const current = `${parityPaths[index]}/${session.encoding}-${session.run}-${i}`;
            const baseline = `${parityPaths[index]}/${first.encoding}-${first.run}-${i}`;
            const actual = PNG.sync.read(readFileSync(`${current}.png`)); const expected = PNG.sync.read(readFileSync(`${baseline}.png`));
            assert.deepEqual([actual.width, actual.height], [800, 600]); assert.deepEqual(actual.data, expected.data); checks.images++;
            const queries = JSON.parse(gunzipSync(readFileSync(`${current}.json.gz`)));
            const old = JSON.parse(gunzipSync(readFileSync(`${baseline}.json.gz`)));
            assert.deepEqual(Object.keys(queries).sort(), Object.keys(old).sort());
            for (const key of Object.keys(queries)) {
                assert.equal(signature(queries[key]), signature(old[key]));
                assert.equal(signature(queries[key]), checkpoint.hashes[key]);
                assert.equal(queries[key].length, checkpoint.counts[key]);
            }
            checks.queryArchives++;
        }
        if (result.args.strict) {
            assert.equal(session.stats.length, 1);
            const stats = session.stats[0];
            assert.equal(stats.forbidden.length, 10);
            for (const key of [...stats.forbidden, 'propertyProxyMisses']) assert.equal(stats.counters[key], 0);
            if (session.encoding === 'mlt') assert.ok(stats.counters.pretriangulatedFillFeatures > 0);
        }
    }
}
const aggregates = [];
for (const network of [...new Set(rows.map(row => row.network))]) for (const phase of ['cold', 'warm']) for (const encoding of ['mvt', 'mlt']) {
    const values = rows.filter(row => row.network === network && row.phase === phase && row.encoding === encoding);
    const metrics = Object.keys(values[0]).filter(key => typeof values[0][key] === 'number' && key !== 'run');
    aggregates.push({network, phase, encoding, sessions: values.length, ...Object.fromEntries(metrics.map(key => [key, median(values.map(row => row[key]))])),
        tileLoadP50Ms: values[0].tileLoadP50Ms === null ? null : median(values.map(row => row.tileLoadP50Ms)),
        tileLoadP95Ms: values[0].tileLoadP95Ms === null ? null : median(values.map(row => row.tileLoadP95Ms)),
        initialMs: median(initial.filter(row => row.network === network && row.encoding === encoding).map(row => row.initialMs)),
        initialPayloadBytes: median(initial.filter(row => row.network === network && row.encoding === encoding).map(row => row.payloadBytes))});
}
for (const startup of startupRows) {
    const row = aggregates.find(row => row.network === startup.network && row.encoding === startup.encoding && row.phase === 'cold');
    assert.ok(Math.abs(startup.initialMs - row.initialMs) < 1e-8); assert.equal(startup.sessions, row.sessions);
    assert.equal(startup.minPayloadBytes, row.initialPayloadBytes); assert.equal(startup.maxPayloadBytes, row.initialPayloadBytes);
}
const result = {status: 'passed', checkedAt: new Date().toISOString(), checks, timingPaths, parityPaths, source: reference.input,
    verificationHashes: Object.fromEntries(['test/bench/e2e/mlt-navigation-verify.mjs', 'test/bench/e2e/mlt-navigation-statistics.sql', 'test/bench/e2e/mlt-navigation-startup.sql'].map(path => [path, hash(readFileSync(path))])),
    sql, sqlRows, startupSql, startupRows, rows, initial, aggregates, uncertainty: 'Medians across independently repeated sessions; inspect paired values and ranges, not a pooled frame-level confidence interval.'};
writeFileSync(resolve(args.output), JSON.stringify(result, null, 2), {flag: 'wx'});
console.log(JSON.stringify({status: result.status, checks, aggregates}, null, 2));

/** Treats paths as local result directories, never an alternate data source. */
function resolvePath(path) { return resolve(path); }
function readResult(path) { return JSON.parse(readFileSync(`${path}/results.json`, 'utf8')); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function median(values) { const sorted = [...values].sort((a,b) => a-b); const i = (sorted.length - 1) / 2; return (sorted[Math.floor(i)] + sorted[Math.ceil(i)]) / 2; }
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
function signature(features) { return hash(JSON.stringify(features.map(feature => JSON.stringify(canonical(feature))).sort())); }

/** Compares requested resource multisets while abstracting only the tile encoding. */
function requestKeys(traffic) {
    return traffic.map(request => request.path.replace(/^\/tiles\/(?:mvt|mlt)\/(.*)\.(?:mvt|mlt)$/, '/tiles/$1')).sort();
}

/** Verifies current product/build files plus the exact archived measurement harness and audited inputs. */
function checkHashes(result, path) {
    for (const [file, expected] of Object.entries({...result.sources, ...result.manifests})) { assert.equal(hash(readFileSync(file)), expected); checks.sourceHashes++; }
    for (const [name, expected] of Object.entries(result.harness)) assert.equal(hash(readFileSync(`${path}/harness/${name}`)), expected);
    assert.equal(hash(readFileSync(result.input.path)), result.input.hash);
}
