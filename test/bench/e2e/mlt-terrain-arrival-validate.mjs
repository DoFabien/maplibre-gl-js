import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {PNG} from 'pngjs';

function json(path) { return JSON.parse(readFileSync(path)); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function signature(values) { return hash(JSON.stringify(values.map(value => JSON.stringify(canonical(value))).sort())); }
function events(values) { return values.map(value => JSON.stringify(canonical(value))).sort(); }
function httpEvents(values, deliveredOnly = false) {
    return events(values.filter(event => !deliveredOnly || ['released', 'completed'].includes(event.type)).map(({request: _, ...value}) => value));
}
function transportOutcome(actual, reference, a, b) {
    assert.deepEqual(httpEvents(a, true), httpEvents(b, true));
    return {actual, reference, exact: JSON.stringify(httpEvents(a)) === JSON.stringify(httpEvents(b)),
        requested: [a, b].map(trace => trace.filter(event => event.type === 'requested').length),
        aborted: [a, b].map(trace => trace.filter(event => event.type === 'aborted').length)};
}
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
const localTiles = ['vector:14-8802-5374', 'dem:12-2200-1343', 'vector:14-8802-5375', 'dem:12-2200-1344',
    'vector:14-8803-5374', 'dem:12-2201-1343', 'vector:14-8803-5375', 'dem:12-2201-1344'];
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

/**
 * Rebuilds every lifecycle, gate schedule and comparison from raw evidence, retaining native cancellations and duplicate requests.
 * The fixed local vector-first path has empty current source queries at 750/1000 ms after its only received tile leaves the view.
 */
export function validate(directory, strict, mode, sourceDiff) {
    const report = json(`${directory}/results.json`);
    assert.equal(report.status, 'passed'); assert.equal(report.runs, 2); assert.equal(report.strict, strict); assert.equal(report.gpuMode, mode);
    assert.deepEqual(report.scenes, ['local-orbit', 'globe-flight']); assert.equal(report.productDiff, sourceDiff);
    assert.equal(report.git, execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim());
    assert.equal(report.tileSpecGit, execFileSync('git', ['-C', '../maplibre-tile-spec', 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim());
    const previous = json(`test/bench/baselines/browser-arrival-${strict ? 'strict-gpu-v5' : 'production-v4'}-20260907/results.json`);
    assert.equal(previous.productDiff, sourceDiff);
    for (const [path, entry] of Object.entries(report.manifest)) {
        const bytes = readFileSync(path); assert.equal(hash(bytes), entry.sha256); assert.equal(bytes.length, entry.bytes);
        if (path.startsWith('dist/')) assert.deepEqual(entry, previous.manifest[path]);
    }
    for (const [path, value] of Object.entries(report.harnessHashes)) assert.equal(hash(readFileSync(path)), value);
    const names = [];
    for (let run = 1; run <= 2; run++) for (const scene of ['local-orbit', 'globe-flight']) for (const order of scene === 'globe-flight' ? ['vector-first', 'dem-first', 'dem-late'] : ['vector-first', 'dem-first']) {
        for (const encoding of run % 2 ? ['mvt', 'mlt'] : ['mlt', 'mvt']) names.push(`${run}-${scene}-${order}-${encoding}`);
    }
    assert.deepEqual(Object.keys(report.sessions), names);
    const captures = []; let partialFrames = 0; let loadingFrames = 0; let partialDemFrames = 0; let cancellations = 0; let repeatedRequests = 0;
    for (const [name, session] of Object.entries(report.sessions)) {
        assert.equal(name, `${session.run}-${session.scene}-${session.order}-${session.encoding}`);
        const world = session.scene === 'globe-flight'; const demId = world ? 'dem-world' : 'dem-local';
        const tiles = world ? ['vector:0-0-0', 'dem:0-0-0'] : localTiles;
        const order = session.order === 'dem-first' ? [...tiles].reverse() : tiles;
        const schedule = order.map((tile, index) => ({tile, time: world ? index === 0 ? 500 : session.order === 'dem-late' ? 2000 : 1500 : (index + 1) * 250}));
        assert.deepEqual(session.info.canvas, {width: 800, height: 600}); assert.equal(session.info.pixelRatio, 1);
        if (mode === 'hardware') assert.doesNotMatch(session.info.renderer, /swiftshader|llvmpipe|software/i);
        else assert.match(session.info.renderer, /swiftshader/i);
        assert.deepEqual(session.errors, []);
        assert.deepEqual(session.disposal, {pendingAfterRemove: 0, canvases: 0, clockRestored: true, schedulerRestored: true});
        stats(session.initialStats, strict, session.encoding); stats(session.finalStats, strict, session.encoding);
        if (strict && session.encoding === 'mlt') assert.ok(session.finalStats[0].counters.decodedLayers > session.initialStats[0].counters.decodedLayers);
        const prep = session.prepared.renders; assert.ok(prep > 0 && prep <= 20); assert.equal(session.prepared.pending, 0); assert.equal(session.prepared.idle, true);
        const expected = [...Array.from({length: prep}, (_, index) => `${name}-prepare-${index + 1}`), `${name}-bootstrap`,
            ...Array.from({length: 9}, (_, index) => `${name}-frame-${index}`)];
        assert.deepEqual(session.captures.slice(0, expected.length), expected);
        const settling = session.captures.length - expected.length; assert.ok(settling > 0 && settling <= 20);
        assert.deepEqual(session.captures.slice(expected.length), Array.from({length: settling}, (_, index) => `${name}-settle-${index + 1}`));
        captures.push(...session.captures);
        for (const [index, key] of session.captures.entries()) {
            const preparing = index < prep; const time = Math.max(0, Math.min(index - prep - 1, 8)) * 250;
            const delivered = preparing ? [] : schedule.filter(item => item.time <= time).map(item => item.tile).sort();
            const frame = report.captures[key]; const snapshot = frame.snapshot;
            assert.equal(frame.time, time); assert.equal(frame.clockTime, 1000000 + time); assert.equal(frame.frozen, true); assert.equal(frame.clamped, true);
            assert.equal(frame.phase, preparing ? 'preparation' : 'animation'); assert.equal(frame.moving, !preparing && time < 2000);
            assert.deepEqual(frame.gates, delivered); assert.ok(frame.arrivals.every(tile => delivered.includes(tile))); assert.equal(snapshot.globeness, world ? 1 : 0);
            const received = session.terminal.events.filter(event => ['arrival', demId].includes(event.source) && event.tile && event.type === 'sourcedata' && event.frame <= index).map(event => {
                const [, , z, x, y] = event.tile.split('/').map(Number); const level = Math.min(z, world ? 0 : event.source === 'arrival' ? 14 : 12);
                return `${event.source === 'arrival' ? 'vector' : 'dem'}:${level}-${Math.floor(x / 2 ** (z - level))}-${Math.floor(y / 2 ** (z - level))}`;
            });
            assert.deepEqual(frame.arrivals, [...new Set(received)].sort());
            for (const [offset, barrier] of session.terminal.barriers.slice(index * 2, index * 2 + 2).entries()) {
                assert.equal(barrier.frame, index + offset); assert.equal(barrier.time, time); assert.deepEqual(barrier.opened, delivered);
                assert.equal(barrier.sourcesLoaded.corpus, true); assert.equal(barrier.sourcesLoaded.world, true);
            }
            assert.deepEqual(snapshot.vectorSourcesPreserved, [true, true]); assert.deepEqual(snapshot.selectedState, {selected: true}); assert.deepEqual(snapshot.symbolSelectedState, {selected: true});
            if (preparing) { assert.equal(snapshot.terrain, null); assert.deepEqual(snapshot.elevations, [null, null, null]); }
            else assert.deepEqual(snapshot.terrain, {source: demId, exaggeration: 1});
            if (!preparing && !frame.tilesLoaded) loadingFrames++;
            if (delivered.length > 0 && delivered.length < tiles.length && !frame.tilesLoaded) partialFrames++;
            const demCount = frame.arrivals.filter(tile => tile.startsWith('dem:')).length;
            if (!preparing && !demCount) assert.deepEqual(snapshot.elevations, [0, 0, 0]);
            if (demCount > 0 && demCount < tiles.filter(tile => tile.startsWith('dem:')).length && !frame.sourcesLoaded[demId]) partialDemFrames++;
            for (const value of [...snapshot.camera.center, snapshot.camera.zoom, snapshot.camera.pitch, snapshot.camera.bearing, snapshot.camera.elevation]) assert.ok(Number.isFinite(value));
            const queries = JSON.parse(gunzipSync(readFileSync(`${directory}/${key}.json.gz`)));
            assert.deepEqual(Object.keys(queries.source), ['corpus', 'world', 'arrival']);
            for (const [source, values] of Object.entries({...queries.source, rendered: queries.rendered})) {
                assert.equal(signature(values), snapshot.hashes[source]); assert.equal(values.length, snapshot.counts[source]);
            }
            const evicted = !world && session.order === 'vector-first' && (time === 750 || time === 1000);
            if (frame.arrivals.some(tile => tile.startsWith('vector:')) && !evicted) assert.ok(queries.source.arrival.length > 0);
            else assert.equal(queries.source.arrival.length, 0);
            pixels(directory, key);
        }
        const last = report.captures[session.captures.at(-1)]; assert.equal(last.loaded, true); assert.equal(last.tilesLoaded, true);
        const lastQueries = JSON.parse(gunzipSync(readFileSync(`${directory}/${session.captures.at(-1)}.json.gz`)));
        for (const layer of ['arrival-fill', 'arrival-lines']) assert.ok(lastQueries.rendered.some(feature => feature.layer.id === layer));
        for (const layer of world ? ['world-land', 'world-water', 'world-admin'] : ['buildings', 'roads']) assert.ok(last.snapshot.layerCounts[layer] > 0);
        assert.ok(last.snapshot.elevations.every(value => Number.isFinite(value) && value > 0));
        assert.ok(Math.max(...last.snapshot.elevations) - Math.min(...last.snapshot.elevations) > 10);
        const expectedCenter = world ? [-73, 38] : [8803.75 / 16384 * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * 5375.75 / 16384))) * 180 / Math.PI];
        last.snapshot.camera.center.forEach((value, index) => assert.ok(Math.abs(value - expectedCenter[index]) < 1e-9));
        for (const [field, target] of [['zoom', world ? 3.25 : 14.5], ['pitch', world ? 30 : 55], ['bearing', world ? -25 : 20]]) {
            assert.ok(Math.abs(last.snapshot.camera[field] - target) < 1e-9, `Requested ${field} target`);
        }
        assert.equal(session.terminal.pending, 0); assert.equal(session.terminal.idle, true); assert.equal(session.terminal.moving, false); assert.equal(session.terminal.tilesLoaded, true);
        assert.deepEqual(session.terminal.inflight, []); assert.equal(session.terminal.renders, session.captures.length);
        assert.equal(session.terminal.barriers.length, session.captures.length * 2);
        for (const barrier of session.terminal.barriers) assert.ok(!barrier.inflight.some(item => barrier.opened.includes(item.resource)));
        assert.ok(!session.terminal.events.some(event => event.type === 'error' || event.error));
        for (const event of session.terminal.events.filter(event => ['arrival', demId].includes(event.source) && event.tile && event.type === 'sourcedata')) {
            const [, , z, x, y] = event.tile.split('/').map(Number); const level = Math.min(z, world ? 0 : event.source === 'arrival' ? 14 : 12);
            const resource = `${event.source === 'arrival' ? 'vector' : 'dem'}:${level}-${Math.floor(x / 2 ** (z - level))}-${Math.floor(y / 2 ** (z - level))}`;
            const gate = schedule.find(item => item.tile === resource); assert.ok(gate); assert.ok(event.time >= gate.time);
        }
        const releases = session.deliveries.filter(event => event.type === 'released');
        assert.deepEqual(releases, schedule.map(({tile, time}) => ({time, type: 'released', tile})));
        const requests = session.deliveries.filter(event => event.type === 'requested');
        assert.equal(new Set(requests.map(event => event.request)).size, requests.length);
        assert.deepEqual([...new Set(requests.map(event => event.tile))].sort(), [...tiles].sort());
        for (const request of requests) {
            assert.ok(Number.isSafeInteger(request.request) && request.request > 0);
            const terminals = session.deliveries.filter(event => event.request === request.request && ['completed', 'aborted'].includes(event.type));
            assert.equal(terminals.length, 1); assert.equal(terminals[0].tile, request.tile); assert.ok(terminals[0].time >= request.time);
            if (terminals[0].type === 'completed') assert.ok(terminals[0].time >= schedule.find(item => item.tile === request.tile).time);
            else assert.ok(terminals[0].time < schedule.find(item => item.tile === request.tile).time, 'Only pre-release, zero-response cancellations may vary at HTTP');
        }
        assert.equal(session.deliveries.length, requests.length * 2 + tiles.length);
        cancellations += session.terminal.events.filter(event => event.type === 'sourcedataabort').length;
        repeatedRequests += requests.length - tiles.length;
    }
    assert.deepEqual(Object.keys(report.captures), captures); assert.ok(partialFrames > 0); assert.ok(partialDemFrames > 0);
    assert.ok(cancellations > 0); assert.ok(repeatedRequests > 0);
    const comparisons = []; const transportOutcomes = [];
    function compare(actual, reference, kind) {
        const a = report.captures[actual]; const b = report.captures[reference]; const delta = difference(pixels(directory, actual), pixels(directory, reference));
        const stateEqual = JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
        comparisons.push({actual, reference, kind, ...delta, stateEqual});
        if (kind === 'order-outcome') return;
        if (kind === 'delivery-control') { assert.ok(delta.pixels > 0); assert.notDeepEqual(a.arrivals, b.arrivals); assert.equal(a.time, b.time); return; }
        if (kind === 'dem-control') {
            assert.ok(delta.pixels > 0); assert.equal(a.time, b.time); assert.deepEqual(a.snapshot.camera, b.snapshot.camera);
            assert.deepEqual(a.arrivals.filter(tile => tile.startsWith('vector:')), b.arrivals.filter(tile => tile.startsWith('vector:')));
            assert.equal(a.sourcesLoaded['dem-world'], false); assert.equal(b.sourcesLoaded['dem-world'], true); return;
        }
        assert.deepEqual(a, b); assert.deepEqual(delta, {pixels: 0, maxDelta: 0});
    }
    for (const [name, session] of Object.entries(report.sessions)) {
        for (const reference of [session.encoding === 'mvt' ? name.replace(/-mvt$/, '-mlt') : null, session.run > 1 ? name.replace(/^\d+-/, '1-') : null].filter(Boolean)) {
            const other = report.sessions[reference]; assert.equal(session.captures.length, other.captures.length);
            assert.deepEqual(events(session.terminal.events), events(other.terminal.events)); assert.deepEqual(session.terminal.barriers, other.terminal.barriers);
            transportOutcomes.push(transportOutcome(name, reference, session.deliveries, other.deliveries));
            for (const key of session.captures) compare(key, key.replace(`${name}-`, `${reference}-`), reference.startsWith(`${session.run}-`) ? 'encoding' : 'repeat');
        }
        if (session.order === 'dem-late') compare(`${name}-frame-6`, `${name.replace('-dem-late-', '-vector-first-')}-frame-6`, 'dem-control');
        if (session.order !== 'dem-first') continue;
        const other = report.sessions[name.replace('-dem-first-', '-vector-first-')]; const step = session.scene === 'globe-flight' ? 2 : 1;
        compare(`${name}-frame-${step}`, `${name.replace('-dem-first-', '-vector-first-')}-frame-${step}`, 'delivery-control');
        compare(session.captures.at(-1), other.captures.at(-1), 'order-outcome');
    }
    assert.deepEqual(comparisons, report.comparisons);
    assert.deepEqual(transportOutcomes, report.transportOutcomes);
    return {report, summary: {sessions: names.length, captures: captures.length, partialFrames, loadingFrames, partialDemFrames, cancellations, repeatedRequests,
        nonidenticalPreReleaseTransport: transportOutcomes.filter(item => !item.exact).length,
        comparisons: Object.fromEntries(['encoding', 'repeat', 'delivery-control', 'dem-control', 'order-outcome'].map(kind => [kind, comparisons.filter(item => item.kind === kind).length]))}};
}

function main() {
    const [production, gpu, software, unitPath, serverPath] = process.argv.slice(2); assert.ok(serverPath, 'Expected three campaigns, unit JSON and HTTP-server JSON');
    const sourceDiff = execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'});
    const campaigns = [validate(production, false, 'hardware', sourceDiff), validate(gpu, true, 'hardware', sourceDiff), validate(software, true, 'software', sourceDiff)];
    const crossBackendTransport = [];
    for (const campaign of campaigns.slice(1)) {
        assert.deepEqual(campaign.report.captures, campaigns[0].report.captures);
        for (const [name, session] of Object.entries(campaign.report.sessions)) {
            const reference = campaigns[0].report.sessions[name]; assert.deepEqual(events(session.terminal.events), events(reference.terminal.events));
            assert.deepEqual(session.terminal.barriers, reference.terminal.barriers);
            crossBackendTransport.push(transportOutcome(`${campaign.report.strict}-${campaign.report.gpuMode}-${name}`, `production-${name}`, session.deliveries, reference.deliveries));
        }
    }
    const tests = {};
    for (const [name, path, count] of [['unit', unitPath, 405], ['server', serverPath, 5]]) {
        const report = json(path); assert.equal(report.success, true); assert.equal(report.numPassedTests, count); assert.equal(report.numFailedTests, 0); assert.equal(report.numPendingTests, 0);
        tests[name] = {count, sha256: hash(readFileSync(path))}; writeFileSync(`${production}/${name}-tests.json.gz`, gzipSync(readFileSync(path)));
    }
    const result = {status: 'verified-controlled-terrain-arrivals', crossBackendStatesExact: true, crossBackendTransport,
        sourceDiffSha256: hash(sourceDiff), tests, sources: {}, campaigns: {},
        limitation: 'Synthetic DEMs and fixed delivery gates during a local orbit and globe flight; not native timing, memory/performance, arbitrary failures or general final texture convergence across different histories.'};
    for (const path of [...Object.keys(campaigns[0].report.harnessHashes), 'test/bench/e2e/mlt-terrain-arrival-server.test.ts', 'test/bench/e2e/mlt-terrain-arrival-validate.mjs']) {
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
