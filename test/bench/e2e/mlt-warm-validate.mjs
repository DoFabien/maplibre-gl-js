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
function pixels(directory, name) {
    const image = PNG.sync.read(readFileSync(`${directory}/${name}.png`));
    assert.equal(image.width, 800); assert.equal(image.height, 600);
    return image.data;
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
const forbidden = ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers', 'propertyObjects', 'pointObjects', 'geometryPartsMaterialized',
    'overzoomPointObjects', 'mvtReencodes', 'rawTileMainThreadDecodes', 'coordinateTuples', 'propertyDescriptors'].sort();
function stats(workers, strict, encoding) {
    assert.equal(workers.length, strict ? 1 : 0);
    for (const worker of workers) {
        assert.deepEqual([...worker.forbidden].sort(), forbidden);
        for (const key of [...forbidden, 'propertyProxyMisses']) assert.equal(worker.counters[key], 0);
        if (encoding === 'mlt') assert.ok(worker.counters.decodedLayers > 0);
        else assert.equal(worker.counters.decodedLayers, 0);
    }
}
function events(events) { return events.map(event => JSON.stringify(event)).sort(); }
const journeyNames = ['projection-forward', 'projection-reverse', 'terrain-orbit', 'terrain-flight'];

/** Independently reconstructs every required comparison, rather than trusting a runner's passing flag or list of comparisons. */
export function validate(directory, strict, mode, sourceDiff) {
    const report = json(`${directory}/results.json`);
    assert.equal(report.status, 'passed'); assert.equal(report.strict, strict); assert.equal(report.gpuMode, mode);
    assert.equal(report.controls, true); assert.equal(report.runs, 2);
    assert.equal(report.initialization, 'controlled-world-preparation-excursion-return-no-reload');
    assert.deepEqual(report.journeys.map(journey => journey.name), journeyNames);
    assert.equal(report.productDiff, sourceDiff);
    assert.equal(report.git, execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim());
    assert.equal(report.tileSpecGit, execFileSync('git', ['-C', '../maplibre-tile-spec', 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim());
    for (const [path, entry] of Object.entries(report.manifest)) {
        const data = readFileSync(path); assert.equal(hash(data), entry.sha256); assert.equal(data.length, entry.bytes);
    }
    for (const [path, value] of Object.entries(report.harnessHashes)) assert.equal(hash(readFileSync(path)), value);
    const previous = json(`test/bench/baselines/browser-motion-${strict ? 'strict-gpu' : 'production'}-v3-20260907/results.json`);
    assert.equal(previous.productDiff, sourceDiff);
    for (const [path, entry] of Object.entries(report.manifest).filter(([path]) => path.startsWith('dist/'))) assert.deepEqual(entry, previous.manifest[path]);
    for (const encoding of ['mvt', 'mlt']) assert.ok(report.requests[`/tiles/${encoding}/0-0-0.${encoding}`] > 0);
    assert.ok(report.requests['/dem-world/0-0-0.png'] > 0);

    const expectedSessions = [];
    for (let run = 1; run <= 2; run++) for (const journey of journeyNames) for (const encoding of run % 2 ? ['mvt', 'mlt'] : ['mlt', 'mvt']) expectedSessions.push(`${run}-${journey}-${encoding}`);
    for (const encoding of ['mvt', 'mlt']) expectedSessions.push(`control-terrain-flight-${encoding}`);
    assert.deepEqual(Object.keys(report.sessions), expectedSessions);
    const expectedCaptures = [];
    let loadingFrames = 0;
    for (const [name, session] of Object.entries(report.sessions)) {
        const journey = report.journeys.find(journey => journey.name === session.journey);
        assert.ok(journey); assert.equal(name, `${session.control ? 'control' : session.run}-${session.journey}-${session.encoding}`);
        assert.deepEqual(session.info.canvas, {width: 800, height: 600}); assert.equal(session.info.pixelRatio, 1);
        if (mode === 'hardware') assert.doesNotMatch(session.info.renderer, /swiftshader|llvmpipe|software/i);
        else assert.match(session.info.renderer, /swiftshader/i);
        assert.deepEqual(session.errors, []);
        assert.deepEqual(session.disposal, {pendingAfterRemove: 0, canvases: 0, clockRestored: true, schedulerRestored: true});
        stats(session.initialStats, strict, session.encoding); stats(session.finalStats, strict, session.encoding);
        if (strict && session.encoding === 'mlt') {
            assert.ok(session.finalStats[0].counters.overzoomFeaturesClipped > 0);
            assert.ok(session.finalStats[0].counters.decodedLayers > session.initialStats[0].counters.decodedLayers);
        }
        assert.deepEqual(session.preparation.map(stage => stage.stage), ['world', 'configure', 'excursion', 'return']);
        const prepared = session.preparation.flatMap(stage => stage.captures);
        let preparedCount = 0;
        for (const stage of session.preparation) {
            assert.ok(stage.captures.length > 0 && stage.captures.length <= 15);
            assert.deepEqual(stage.captures, Array.from({length: stage.captures.length}, (_, index) => `${name}-prepare-${stage.stage}-${index + 1}`));
            preparedCount += stage.captures.length;
            assert.equal(stage.state.renders, preparedCount); assert.equal(stage.state.pending, 0);
            assert.equal(stage.state.tilesLoaded, true); assert.equal(stage.state.idle, true); assert.equal(stage.state.moving, false);
            stats(stage.stats, strict, session.encoding);
            for (const key of stage.captures) {
                expectedCaptures.push(key);
                const frame = report.captures[key];
                assert.equal(frame.time, 0); assert.equal(frame.clockTime, 1000000); assert.equal(frame.phase, `prepare-${stage.stage}`);
                assert.equal(frame.frozen, true); assert.equal(frame.clamped, true); assert.equal(frame.moving, false);
                assert.deepEqual(frame.snapshot.vectorSourcesPreserved, [true, true]);
                assert.deepEqual(frame.snapshot.selectedState, {selected: true}); assert.deepEqual(frame.snapshot.symbolSelectedState, {selected: true});
                const queries = JSON.parse(gunzipSync(readFileSync(`${directory}/${key}.json.gz`)));
                for (const [name, values] of Object.entries({...queries.source, rendered: queries.rendered})) {
                    assert.equal(signature(values), frame.snapshot.hashes[name]); assert.equal(values.length, frame.snapshot.counts[name]);
                }
                pixels(directory, key);
            }
        }
        const outbound = session.preparation[2]; const returned = session.preparation[3];
        assert.deepEqual(returned.requests, outbound.requests);
        assert.ok(returned.requests[`/tiles/${session.encoding}/0-0-0.${session.encoding}`] > 0);
        if (strict && session.encoding === 'mlt') for (const counter of ['decodedLayers', 'overzoomFeaturesClipped']) {
            assert.equal(returned.stats[0].counters[counter], outbound.stats[0].counters[counter]);
        }
        const terminal = session.terminal;
        assert.equal(terminal.pending, session.control ? 1 : 0); assert.equal(terminal.moving, session.control);
        assert.equal(terminal.idle, !session.control); assert.equal(terminal.tilesLoaded, true);
        assert.equal(terminal.renders, prepared.length + session.captures.length);
        assert.ok(!terminal.events.some(event => event.type === 'error' || event.error));
        const types = terminal.events.slice(returned.state.events.length).map(event => event.type);
        assert.equal(types.filter(type => type === 'movestart').length, 1);
        assert.equal(types.filter(type => type === 'move').length, session.control ? 5 : 16);
        assert.equal(types.filter(type => type === 'moveend').length, session.control ? 0 : 1);
        if (!session.control) assert.ok(types.lastIndexOf('idle') > types.lastIndexOf('moveend'));
        assert.equal(terminal.barriers.length, terminal.renders * 2);
        for (let index = 0; index < terminal.barriers.length; index++) {
            const barrier = terminal.barriers[index];
            assert.equal(barrier.frame, Math.ceil(index / 2));
            assert.ok(Object.entries(barrier.sourcesLoaded).every(([id, value]) => value === true || barrier.initializing?.includes(id)));
            if (barrier.initializing) {
                assert.deepEqual(barrier.initializing, ['dem-world']); assert.ok(journey.setup.terrain);
                assert.equal(barrier.time, 0);
                assert.ok(barrier.frame === session.preparation[0].captures.length || barrier.frame === session.preparation[0].captures.length + 1);
            }
        }
        const animated = Array.from({length: session.control ? 4 : 16}, (_, index) => `${name}-frame-${index + 1}`);
        assert.deepEqual(session.captures.slice(0, animated.length), animated);
        if (session.control) assert.deepEqual(session.captures.slice(4), [`${name}-extra`]);
        else {
            assert.ok(session.captures.length >= 16 && session.captures.length <= 26);
            assert.deepEqual(session.captures.slice(16), Array.from({length: session.captures.length - 16}, (_, index) => `${name}-settle-${index + 1}`));
        }
        for (const [index, key] of session.captures.entries()) {
            expectedCaptures.push(key);
            const frame = report.captures[key];
            assert.ok(frame);
            const expectedTime = session.control && index === 4 ? 500 : Math.min(index + 1, 16) * 125;
            assert.equal(frame.time, expectedTime); assert.equal(frame.clockTime, 1000000 + expectedTime);
            assert.equal(frame.phase, session.control && index === 4 ? 'control' : index >= 16 ? 'settle' : 'animation');
            assert.equal(frame.frozen, true); assert.equal(frame.clamped, true); assert.equal(frame.moving, expectedTime < 2000);
            if (!frame.tilesLoaded) loadingFrames++;
            const snapshot = frame.snapshot;
            assert.deepEqual(snapshot.vectorSourcesPreserved, [true, true]);
            assert.deepEqual(snapshot.selectedState, {selected: true}); assert.deepEqual(snapshot.symbolSelectedState, {selected: true});
            assert.equal(snapshot.terrain?.source, journey.setup.terrain?.source);
            if (snapshot.terrain) assert.ok(snapshot.elevations.every(value => Number.isFinite(value) && value > 0));
            else assert.deepEqual(snapshot.elevations, [null, null, null]);
            for (const layer of ['world-land', 'world-water', 'world-admin']) assert.ok(snapshot.layerCounts[layer] > 0);
            for (const value of [...snapshot.camera.center, snapshot.camera.zoom, snapshot.camera.pitch, snapshot.camera.bearing, snapshot.camera.roll, snapshot.camera.elevation]) assert.ok(Number.isFinite(value));
            const blend = journey.blend ? Math.max(0, Math.min(1, snapshot.camera.zoom - 2.5)) : 1;
            assert.ok(Math.abs(snapshot.globeness - blend) <= 1e-12);
            const queries = JSON.parse(gunzipSync(readFileSync(`${directory}/${key}.json.gz`)));
            for (const [name, values] of Object.entries({...queries.source, rendered: queries.rendered})) {
                assert.equal(signature(values), snapshot.hashes[name]); assert.equal(values.length, snapshot.counts[name]);
            }
            pixels(directory, key);
        }
        if (!session.control) {
            const final = report.captures[session.captures.at(-1)]; assert.equal(final.loaded, true);
            for (const [key, value] of Object.entries(journey.target)) {
                const actual = final.snapshot.camera[key];
                const a = Array.isArray(actual) ? actual : [actual]; const b = Array.isArray(value) ? value : [value];
                for (let index = 0; index < b.length; index++) assert.ok(Math.abs(a[index] - b[index]) <= 1e-9);
            }
        }
    }
    assert.deepEqual(Object.keys(report.captures), expectedCaptures);
    assert.ok(loadingFrames > 0, 'Scheduled loading states must be exercised');

    const comparisons = [];
    function compare(first, second, kind) {
        const a = report.captures[first]; const b = report.captures[second];
        assert.ok(a && b);
        const {phase: _a, ...withoutPhaseA} = a; const {phase: _b, ...withoutPhaseB} = b;
        assert.deepEqual(kind === 'negative-control' ? withoutPhaseA : a, kind === 'negative-control' ? withoutPhaseB : b);
        const delta = difference(pixels(directory, first), pixels(directory, second));
        if (kind === 'negative-control') { assert.ok(delta.pixels > 0); assert.equal(a.loaded, true); }
        else assert.deepEqual(delta, {pixels: 0, maxDelta: 0});
        comparisons.push({actual: first, reference: second, kind, ...delta, stateEqual: true});
    }
    for (const [name, session] of Object.entries(report.sessions)) {
        const prepared = session.preparation.flatMap(stage => stage.captures);
        if (session.control) {
            for (const key of prepared) compare(key, key.replace('control-', '1-'), 'control-prefix');
            for (let frame = 1; frame <= 4; frame++) compare(`${name}-frame-${frame}`, `1-terrain-flight-${session.encoding}-frame-${frame}`, 'control-prefix');
            compare(`${name}-extra`, `${name}-frame-4`, 'negative-control');
            continue;
        }
        if (session.encoding === 'mvt') {
            const other = name.replace(/-mvt$/, '-mlt');
            assert.equal(session.captures.length, report.sessions[other].captures.length);
            for (const key of [...prepared, ...session.captures]) compare(key, key.replace('-mvt-', '-mlt-'), 'encoding');
            assert.deepEqual(events(session.terminal.events), events(report.sessions[other].terminal.events));
            assert.deepEqual(session.terminal.barriers, report.sessions[other].terminal.barriers);
        }
        if (session.run === 1) continue;
        const first = name.replace(/^\d+-/, '1-');
        assert.equal(session.captures.length, report.sessions[first].captures.length);
        for (const key of [...prepared, ...session.captures]) compare(key, key.replace(/^\d+-/, '1-'), 'repeat');
        assert.deepEqual(events(session.terminal.events), events(report.sessions[first].terminal.events));
        assert.deepEqual(session.terminal.barriers, report.sessions[first].terminal.barriers);
    }
    const runnerComparisons = comparisons.filter(item => item.kind !== 'repeat' || !item.actual.includes('-prepare-'));
    assert.deepEqual(runnerComparisons, report.comparisons);
    const counts = Object.fromEntries(['encoding', 'repeat', 'control-prefix', 'negative-control'].map(kind => [kind, comparisons.filter(item => item.kind === kind).length]));
    assert.equal(counts['negative-control'], 2);
    return {report, comparisons, summary: {sessions: expectedSessions.length, captures: expectedCaptures.length, loadingFrames, comparisons: counts,
        independentlyAddedPreparationRepeats: comparisons.length - runnerComparisons.length,
        controls: comparisons.filter(item => item.kind === 'negative-control')}};
}

function main() {
    const [production, gpu, software, unitPath] = process.argv.slice(2);
    assert.ok(unitPath, 'Expected production, strict GPU, strict software directories and a unit report');
    const sourceDiff = execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'});
    const campaigns = [validate(production, false, 'hardware', sourceDiff), validate(gpu, true, 'hardware', sourceDiff), validate(software, true, 'software', sourceDiff)];
    for (const campaign of campaigns.slice(1)) {
        assert.deepEqual(campaign.report.captures, campaigns[0].report.captures);
        for (const [name, session] of Object.entries(campaign.report.sessions)) {
            const reference = campaigns[0].report.sessions[name];
            assert.deepEqual(events(session.terminal.events), events(reference.terminal.events));
            assert.deepEqual(session.terminal.barriers, reference.terminal.barriers);
        }
    }
    const unit = json(unitPath); assert.equal(unit.success, true); assert.equal(unit.numFailedTests, 0); assert.equal(unit.numPassedTests, 336);
    const previous = json('test/bench/baselines/browser-motion-production-v3-20260907/validation.json');
    assert.equal(previous.sourceDiffSha256, hash(sourceDiff));
    const result = {status: 'verified-warm-history-parity', crossBackendStatesExact: true, sourceDiffSha256: hash(sourceDiff), sources: {}, campaigns: {},
        unit: {passed: unit.numPassedTests, failed: unit.numFailedTests, sha256: hash(readFileSync(unitPath))}, previousValidationSha256: hash(JSON.stringify(previous)),
        limitation: 'Controlled world-source warm preparation and excursion/return without source reload, then 125 ms frame schedule and source-completion barriers; initial Berlin startup is not controlled. Not arbitrary native timing, partial arrivals, FPS, or a replay of old real-time traces.'};
    writeFileSync(`${production}/unit.json.gz`, gzipSync(readFileSync(unitPath)));
    writeFileSync(`${production}/previous-motion-validation.json.gz`, gzipSync(JSON.stringify(previous)));
    for (const path of [...Object.keys(campaigns[0].report.harnessHashes), 'test/bench/e2e/mlt-warm-validate.mjs']) {
        result.sources[path] = hash(readFileSync(path)); writeFileSync(`${production}/${basename(path)}.gz`, gzipSync(readFileSync(path)));
    }
    for (const [index, directory] of [production, gpu, software].entries()) {
        writeFileSync(`${directory}/independent-comparisons.json.gz`, gzipSync(JSON.stringify(campaigns[index].comparisons)));
        result.campaigns[basename(directory)] = {...campaigns[index].summary, files: Object.fromEntries(readdirSync(directory)
            .filter(name => /\.(png|json|gz)$/.test(name) && name !== 'validation.json').map(name => [name, hash(readFileSync(`${directory}/${name}`))]))};
    }
    writeFileSync(`${production}/validation.json`, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({status: result.status, campaigns: campaigns.map(campaign => campaign.summary), unit: result.unit}, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
