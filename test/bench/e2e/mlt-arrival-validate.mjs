import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {PNG} from 'pngjs';

function json(path) { return JSON.parse(readFileSync(path)); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function signature(features) { return hash(JSON.stringify(features.map(feature => JSON.stringify(canonical(feature))).sort())); }
function events(values) { return values.map(value => JSON.stringify(value)).sort(); }
function pixels(directory, key) {
    const png = PNG.sync.read(readFileSync(`${directory}/${key}.png`));
    assert.equal(png.width, 800); assert.equal(png.height, 600); return png.data;
}
function difference(a, b) {
    let pixels = 0; let maxDelta = 0;
    for (let index = 0; index < a.length; index += 4) {
        let changed = false;
        for (let channel = 0; channel < 4; channel++) {
            const delta = Math.abs(a[index + channel] - b[index + channel]);
            changed ||= delta > 0; maxDelta = Math.max(maxDelta, delta);
        }
        if (changed) pixels++;
    }
    return {pixels, maxDelta};
}
const tiles = ['14-8802-5374', '14-8802-5375', '14-8803-5374', '14-8803-5375'];
const forbidden = ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers', 'propertyObjects', 'pointObjects', 'geometryPartsMaterialized',
    'overzoomPointObjects', 'mvtReencodes', 'rawTileMainThreadDecodes', 'coordinateTuples', 'propertyDescriptors'].sort();
function stats(values, strict, encoding) {
    assert.equal(values.length, strict ? 1 : 0);
    for (const worker of values) {
        assert.deepEqual([...worker.forbidden].sort(), forbidden);
        for (const key of [...forbidden, 'propertyProxyMisses']) assert.equal(worker.counters[key], 0);
        if (encoding === 'mlt') assert.ok(worker.counters.decodedLayers > 0);
        else assert.equal(worker.counters.decodedLayers, 0);
    }
}

/** Reconstructs both delivery schedules, every partial frame and all required comparisons from the raw evidence. */
export function validate(directory, strict, mode, sourceDiff) {
    const report = json(`${directory}/results.json`);
    assert.equal(report.status, 'passed'); assert.equal(report.runs, 2); assert.equal(report.strict, strict); assert.equal(report.gpuMode, mode);
    assert.equal(report.productDiff, sourceDiff);
    assert.equal(report.git, execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim());
    assert.equal(report.tileSpecGit, execFileSync('git', ['-C', '../maplibre-tile-spec', 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim());
    for (const [path, entry] of Object.entries(report.manifest)) {
        const bytes = readFileSync(path); assert.equal(hash(bytes), entry.sha256); assert.equal(bytes.length, entry.bytes);
    }
    for (const [path, value] of Object.entries(report.harnessHashes)) assert.equal(hash(readFileSync(path)), value);
    const names = [];
    for (let run = 1; run <= 2; run++) for (const order of ['forward', 'reverse']) for (const encoding of run % 2 ? ['mvt', 'mlt'] : ['mlt', 'mvt']) names.push(`${run}-${order}-${encoding}`);
    assert.deepEqual(Object.keys(report.sessions), names);
    const captures = []; let partialFrames = 0;
    for (const [name, session] of Object.entries(report.sessions)) {
        assert.equal(name, `${session.run}-${session.order}-${session.encoding}`);
        const order = session.order === 'forward' ? [...tiles] : [...tiles].reverse();
        assert.deepEqual(session.info.canvas, {width: 800, height: 600}); assert.equal(session.info.pixelRatio, 1);
        if (mode === 'hardware') assert.doesNotMatch(session.info.renderer, /swiftshader|llvmpipe|software/i);
        else assert.match(session.info.renderer, /swiftshader/i);
        assert.deepEqual(session.errors, []);
        assert.deepEqual(session.disposal, {pendingAfterRemove: 0, canvases: 0, clockRestored: true, schedulerRestored: true});
        stats(session.initialStats, strict, session.encoding); stats(session.finalStats, strict, session.encoding);
        if (strict && session.encoding === 'mlt') assert.ok(session.finalStats[0].counters.decodedLayers > session.initialStats[0].counters.decodedLayers);
        const expected = [`${name}-bootstrap`, ...Array.from({length: 9}, (_, index) => `${name}-frame-${index}`)];
        assert.deepEqual(session.captures.slice(0, 10), expected); assert.ok(session.captures.length <= 20);
        assert.deepEqual(session.captures.slice(10), Array.from({length: session.captures.length - 10}, (_, index) => `${name}-settle-${index + 1}`));
        captures.push(...session.captures);
        for (const [index, key] of session.captures.entries()) {
            const time = Math.max(0, Math.min(index - 1, 8)) * 250;
            const delivered = Math.floor(time / 500);
            const frame = report.captures[key];
            assert.equal(frame.time, time); assert.equal(frame.clockTime, 1000000 + time); assert.equal(frame.frozen, true);
            assert.equal(frame.phase, 'animation'); assert.equal(frame.moving, time < 2000); assert.equal(frame.clamped, true);
            assert.deepEqual(frame.arrivals, order.slice(0, delivered).sort()); assert.equal(frame.sourcesLoaded.arrival, delivered === 4);
            assert.equal(frame.tilesLoaded, index === 0 || delivered === 4);
            if (delivered > 0 && delivered < 4) partialFrames++;
            const snapshot = frame.snapshot;
            assert.equal(snapshot.globeness, 0); assert.equal(snapshot.terrain, null); assert.deepEqual(snapshot.elevations, [null, null, null]);
            assert.deepEqual(snapshot.vectorSourcesPreserved, [true, true]);
            assert.deepEqual(snapshot.selectedState, {selected: true}); assert.deepEqual(snapshot.symbolSelectedState, {selected: true});
            assert.equal(snapshot.camera.zoom, 14.5);
            for (const value of [...snapshot.camera.center, snapshot.camera.pitch, snapshot.camera.bearing, snapshot.camera.elevation]) assert.ok(Number.isFinite(value));
            const queries = JSON.parse(gunzipSync(readFileSync(`${directory}/${key}.json.gz`)));
            assert.deepEqual(Object.keys(queries.source), ['corpus', 'world', 'arrival']);
            for (const [name, values] of Object.entries({...queries.source, rendered: queries.rendered})) {
                assert.equal(signature(values), snapshot.hashes[name]); assert.equal(values.length, snapshot.counts[name]);
            }
            if (delivered) assert.ok(queries.source.arrival.length > 0);
            else assert.equal(queries.source.arrival.length, 0);
            pixels(directory, key);
        }
        const last = report.captures[session.captures.at(-1)];
        assert.equal(last.loaded, true); assert.equal(last.snapshot.camera.pitch, 25); assert.equal(last.snapshot.camera.bearing, 20);
        assert.equal(session.terminal.pending, 0); assert.equal(session.terminal.idle, true); assert.equal(session.terminal.moving, false);
        assert.equal(session.terminal.tilesLoaded, true); assert.equal(session.terminal.renders, session.captures.length);
        assert.equal(session.terminal.barriers.length, session.captures.length * 2);
        assert.ok(!session.terminal.events.some(event => event.type === 'error' || event.type === 'sourcedataabort' || event.error));
        const tileEvents = session.terminal.events.filter(event => event.source === 'arrival' && event.tile && event.type === 'sourcedata');
        assert.deepEqual(tileEvents.map(event => ({time: event.time, tile: event.tile.split('/').slice(2).join('-')})),
            order.map((tile, index) => ({time: (index + 1) * 500, tile})));
        const deliveries = tiles.map(tile => ({time: 0, type: 'requested', tile}));
        order.forEach((tile, index) => deliveries.push({time: (index + 1) * 500, type: 'released', tile}, {time: (index + 1) * 500, type: 'completed', tile}));
        assert.deepEqual(events(session.deliveries), events(deliveries));
    }
    assert.deepEqual(Object.keys(report.captures), captures); assert.equal(partialFrames, 48);
    const comparisons = [];
    function compare(actual, reference, kind) {
        const a = report.captures[actual]; const b = report.captures[reference]; assert.ok(a && b);
        const delta = difference(pixels(directory, actual), pixels(directory, reference));
        if (kind === 'delivery-control') {
            assert.ok(delta.pixels > 0); assert.notDeepEqual(a, b); assert.notDeepEqual(a.arrivals, b.arrivals);
            assert.deepEqual(a.snapshot.camera, b.snapshot.camera); assert.equal(a.time, b.time);
        } else { assert.deepEqual(a, b); assert.deepEqual(delta, {pixels: 0, maxDelta: 0}); }
        comparisons.push({actual, reference, kind, ...delta, stateEqual: kind !== 'delivery-control'});
    }
    function trace(a, b) {
        assert.equal(a.captures.length, b.captures.length);
        assert.deepEqual(events(a.terminal.events), events(b.terminal.events)); assert.deepEqual(a.terminal.barriers, b.terminal.barriers);
        assert.deepEqual(events(a.deliveries), events(b.deliveries));
    }
    for (const [name, session] of Object.entries(report.sessions)) {
        if (session.encoding === 'mvt') {
            trace(session, report.sessions[name.replace(/-mvt$/, '-mlt')]);
            for (const key of session.captures) compare(key, key.replace('-mvt-', '-mlt-'), 'encoding');
        }
        if (session.run > 1) {
            trace(session, report.sessions[name.replace(/^\d+-/, '1-')]);
            for (const key of session.captures) compare(key, key.replace(/^\d+-/, '1-'), 'repeat');
        }
        if (session.order !== 'reverse') continue;
        const forward = report.sessions[name.replace('-reverse-', '-forward-')];
        compare(session.captures.at(-1), forward.captures.at(-1), 'final');
        compare(`${name}-frame-2`, `${name.replace('-reverse-', '-forward-')}-frame-2`, 'delivery-control');
    }
    assert.deepEqual(comparisons, report.comparisons);
    return {report, summary: {sessions: names.length, captures: captures.length, partialFrames,
        comparisons: Object.fromEntries(['encoding', 'repeat', 'final', 'delivery-control'].map(kind => [kind, comparisons.filter(item => item.kind === kind).length]))}};
}

function main() {
    const [production, gpu, software] = process.argv.slice(2); assert.ok(software, 'Expected three complete campaign directories');
    const sourceDiff = execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'});
    const campaigns = [validate(production, false, 'hardware', sourceDiff), validate(gpu, true, 'hardware', sourceDiff), validate(software, true, 'software', sourceDiff)];
    for (const campaign of campaigns.slice(1)) {
        assert.deepEqual(campaign.report.captures, campaigns[0].report.captures);
        for (const [name, session] of Object.entries(campaign.report.sessions)) {
            const reference = campaigns[0].report.sessions[name];
            assert.deepEqual(events(session.terminal.events), events(reference.terminal.events)); assert.deepEqual(session.terminal.barriers, reference.terminal.barriers);
            assert.deepEqual(events(session.deliveries), events(reference.deliveries));
        }
    }
    const result = {status: 'verified-controlled-partial-arrivals', crossBackendStatesExact: true, sourceDiffSha256: hash(sourceDiff), sources: {}, campaigns: {},
        limitation: 'Two controlled HTTP delivery orders for a new four-tile vector source over a warm Berlin corpus during rotation/pitch. Not partial terrain/DEM delivery, globe flight, native timing, cancellations or network failures.'};
    for (const path of [...Object.keys(campaigns[0].report.harnessHashes), 'test/bench/e2e/mlt-arrival-validate.mjs']) {
        result.sources[path] = hash(readFileSync(path)); writeFileSync(`${production}/${basename(path)}.gz`, gzipSync(readFileSync(path)));
    }
    for (const [index, directory] of [production, gpu, software].entries()) {
        result.campaigns[basename(directory)] = {...campaigns[index].summary, files: Object.fromEntries(readdirSync(directory)
            .filter(name => /\.(png|json|gz)$/.test(name) && name !== 'validation.json').map(name => [name, hash(readFileSync(`${directory}/${name}`))]))};
    }
    writeFileSync(`${production}/validation.json`, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({status: result.status, campaigns: campaigns.map(campaign => campaign.summary)}, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
