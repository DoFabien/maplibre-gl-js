import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {basename} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {PNG} from 'pngjs';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';

const [output, ...directories] = process.argv.slice(2);
assert.ok(output && directories.length && !existsSync(output), 'Pass a new output JSON and completed diagnostic directories');
const evidence = {};
/** Independently recomputed parity, timing aggregates and sampled mesh-check costs for each supplied campaign. */
const campaigns = [];
let referenceImage;
let referenceQueries;
let images = 0;
let observations = 0;

for (const directory of directories) {
    const report = json(`${directory}/results.json`);
    assert.equal(report.status, 'passed');
    assert.equal(report.sessions.length, report.options.runs * 2);
    for (const manifest of Object.values(report.manifests)) for (const [path, expected] of Object.entries(manifest)) {
        assert.equal(hash(read(path)), expected.sha256, path);
    }
    for (const [name, expected] of Object.entries(report.harnessHashes)) assert.equal(hash(read(`test/bench/e2e/${name}`)), expected, name);
    const sessions = [];
    for (let i = 0; i < report.sessions.length; i++) {
        const session = report.sessions[i]; const run = Math.floor(i / 2);
        assert.equal(session.run, run);
        assert.equal(session.version, (run % 2 ? ['after', 'before'] : ['before', 'after'])[i % 2]);
        assert.doesNotMatch(session.info.renderer, /swiftshader|llvmpipe|software/i);
        assert.equal(session.observations.length, report.options.samples);
        for (const row of session.observations) {
            assert.equal(row.visibility, 'visible'); assert.ok(row.contents.length && row.tiles.length);
            assert.equal(row.lastTileDataMs, row.tiles.at(-1).t);
            assert.equal(row.readyToRenderMs, row.firstRenderMs - row.lastTileDataMs);
            assert.ok(row.readyToRenderMs >= 0 && row.settledMs >= row.firstRenderMs);
            assert.ok(row.renders.includes(row.firstRenderMs));
            if (!report.options.queries) assert.equal(row.queryMs, 0);
            for (const key of Object.keys(session.median)) assert.ok(Number.isFinite(row[key]), key);
            observations++;
        }
        const medians = Object.fromEntries(Object.keys(session.median).map(key => [key, median(session.observations.map(row => row[key]))]));
        assert.deepEqual(medians, session.median);
        const queries = JSON.parse(gunzipSync(read(session.queries)));
        const signatures = {};
        for (const name of ['source', 'rendered']) {
            assert.equal(queries[name].length, session.counts[name]);
            signatures[name] = hash(JSON.stringify(queries[name].map(feature => JSON.stringify(canonical(feature))).sort()));
        }
        assert.deepEqual(signatures, session.hashes);
        if (referenceQueries) assert.deepEqual(signatures, referenceQueries); else referenceQueries = signatures;
        const image = PNG.sync.read(read(session.image)); assert.equal(image.width, 800); assert.equal(image.height, 600);
        if (referenceImage) assert.deepEqual(image.data, referenceImage); else referenceImage = image.data;
        images++;
        const profiles = session.profiles.map(saved => {
            assert.equal(hash(read(saved.file)), saved.sha256);
            const profile = JSON.parse(gunzipSync(read(saved.file)));
            const maps = new Map();
            for (const [path, expected] of Object.entries(saved.maps)) {
                assert.equal(hash(read(path)), expected); maps.set(basename(path).replace(/\.map$/, ''), new TraceMap(json(path)));
            }
            const labels = new Map(profile.nodes.map(node => {
                const frame = node.callFrame; const map = maps.get(frame.url.split('/').at(-1));
                const location = map && frame.lineNumber >= 0 ? originalPositionFor(map, {line: frame.lineNumber + 1, column: frame.columnNumber}) : undefined;
                return [node.id, location?.source ? `${location.source}:${location.line} ${location.name ?? frame.functionName}` : frame.functionName || frame.url];
            }));
            assert.equal(profile.samples.length, profile.timeDeltas.length);
            const self = Object.create(null);
            for (let i = 0; i < profile.samples.length; i++) {
                const label = labels.get(profile.samples[i]); self[label] = (self[label] ?? 0) + profile.timeDeltas[i];
            }
            assert.deepEqual({...self}, saved.self);
            const components = ['pretriangulated_fill.ts', 'columnar_fill_bucket.ts', 'subdivision.ts', 'earcut', 'mlt_tile_data.ts', '(garbage collector)'];
            return {name: saved.name, sampledMsPerReload: Object.fromEntries(components.map(component => [component,
                Object.entries(self).filter(([label]) => label.includes(component)).reduce((sum, [, time]) => sum + time, 0) / report.options.samples / 1000]))};
        });
        sessions.push({run, version: session.version, medians, profiles});
    }
    const summary = {};
    for (const key of Object.keys(sessions[0].medians)) {
        const before = sessions.filter(s => s.version === 'before').map(s => s.medians[key]);
        const after = sessions.filter(s => s.version === 'after').map(s => s.medians[key]);
        summary[key] = {before: median(before), after: median(after),
            deltaPercent: median(before) ? 100 * (median(after) / median(before) - 1) : null,
            pairedDeltaMs: after.map((value, i) => value - before[i])};
    }
    campaigns.push({directory, mode: report.options.mode, runs: report.options.runs, samples: report.options.samples, bundles: report.bundles,
        identicalBuilds: ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'].every(name =>
            hash(read(`${report.bundles.before}/${name}`)) === hash(read(`${report.bundles.after}/${name}`))), summary, sessions});
}
writeFileSync(output, JSON.stringify({status: 'verified-overzoom-diagnostics', checkedAt: new Date().toISOString(), images,
    queryArchives: images, observations, campaigns, evidence,
    limitation: 'Diagnostic campaigns differ from the historical exhaustive-query harness. CPU profile samples are not benchmark times. Exact captured parity is not universal GPU qualification; same-build variation must not be subtracted as a causal correction.'}, null, 2), {flag: 'wx'});
console.log(JSON.stringify({campaigns: campaigns.length, images, observations}));

function read(path) { const bytes = readFileSync(path); evidence[path] = hash(bytes); return bytes; }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function json(path) { return JSON.parse(read(path)); }
function median(values) { const sorted = values.toSorted((a, b) => a - b); return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2; }
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
