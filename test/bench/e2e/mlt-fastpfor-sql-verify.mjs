import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';

const root = 'test/bench/baselines';
const timing = read(`${root}/browser-fastpfor-timing-20260908/results.json`);
const allocations = read(`${root}/browser-fastpfor-allocations-final-20260908/results.json`);
const tiles = read(`${root}/fastpfor-encoding-audit-20260908/manifest.json`);
const verified = read(`${root}/fastpfor-comparison-20260908.json`);
assert.equal(timing.status, 'passed'); assert.equal(allocations.status, 'passed');
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE raw_timing_samples (variant TEXT, phase TEXT, run INTEGER, sample INTEGER, metric TEXT, value REAL)');
db.exec('CREATE TABLE raw_profile_frames (variant TEXT, run INTEGER, context TEXT, frame INTEGER, self_bytes INTEGER)');
db.exec('CREATE TABLE raw_tile_sizes (variant TEXT, tile TEXT, bytes INTEGER, gzip INTEGER)');
const insertTime = db.prepare('INSERT INTO raw_timing_samples VALUES (?, ?, ?, ?, ?, ?)');
const insertFrame = db.prepare('INSERT INTO raw_profile_frames VALUES (?, ?, ?, ?, ?)');
const insertTile = db.prepare('INSERT INTO raw_tile_sizes VALUES (?, ?, ?, ?)');
for (const session of timing.sessions) {
    for (const phase of session.phases) {
        phase.rows.forEach((row, index) => {
            for (const metric of ['firstRenderMs', 'queryMs']) insertTime.run(session.variant, phase.phase, session.run, index, metric, row.times[metric]);
        });
    }
}
for (const session of allocations.sessions) {
    for (const item of session.profiles) {
        const profile = JSON.parse(gunzipSync(readFileSync(item.file)).toString());
        let frame = 0;
        function visit(node) {
            insertFrame.run(session.variant, session.run, item.context, frame++, node.selfSize);
            node.children.forEach(visit);
        }
        visit(profile.head);
    }
}
for (const tile of tiles.tiles) {
    for (const variant of ['mvt', 'varint', 'fastpfor']) insertTile.run(variant, tile.name, tile[variant].bytes, tile[variant].gzip);
}
const drawing = db.prepare(readFileSync('test/bench/e2e/mlt-fastpfor-timing.sql', 'utf8')).all();
const costs = db.prepare(readFileSync('test/bench/e2e/mlt-fastpfor-costs.sql', 'utf8')).all();
assert.equal(drawing.length, 6); assert.equal(costs.length, 3);
for (const row of drawing) {
    const reference = verified.metrics.find(item => item.variant === row.variant && item.phase === row.phase);
    assert.equal(row.dessin_ms, reference.aggregate.firstRenderMs);
    assert.equal(row.requetes_ms, reference.aggregate.queryMs);
    assert.equal(row.min_mediane_ms, Math.min(...reference.medians.map(item => item.firstRenderMs)));
    assert.equal(row.max_mediane_ms, Math.max(...reference.medians.map(item => item.firstRenderMs)));
}
for (const row of costs) {
    const reference = verified.allocated.find(item => item.variant === row.variant).aggregate;
    assert.equal(row.allocations_worker_mio, reference.worker / 1048576);
    assert.equal(row.allocations_main_mio, reference.main / 1048576);
    assert.equal(row.brut_ko, verified.sizes[row.variant].bytes / 1000);
    assert.equal(row.gzip_ko, verified.sizes[row.variant].gzip / 1000);
}
db.close();
const result = {status: 'passed', checkedAt: new Date().toISOString(), engine: 'SQLite via node:sqlite', drawing, costs};
writeFileSync(`${root}/fastpfor-sql-verification-20260908.json`, JSON.stringify(result, null, 2), {flag: 'wx'});
console.log(JSON.stringify(result));

function read(path) { return JSON.parse(readFileSync(path, 'utf8')); }
