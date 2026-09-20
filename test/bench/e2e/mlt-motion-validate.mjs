import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {basename} from 'node:path';
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
function signature(features) { return hash(JSON.stringify(features.map(feature => JSON.stringify(canonical(feature))).sort())); }
function pixels(directory, name) {
    const image = PNG.sync.read(readFileSync(`${directory}/${name}.png`));
    assert.equal(image.width, 800); assert.equal(image.height, 600);
    return image.data;
}
function delta(a, b) {
    let different = 0; let maxDelta = 0;
    for (let i = 0; i < a.length; i += 4) {
        let changed = false;
        for (let channel = 0; channel < 4; channel++) {
            const distance = Math.abs(a[i + channel] - b[i + channel]);
            changed ||= distance > 0; maxDelta = Math.max(maxDelta, distance);
        }
        if (changed) different++;
    }
    return {pixels: different, maxDelta};
}
function pose(a, b) {
    for (const key of ['zoom', 'pitch', 'bearing', 'roll', 'elevation']) assert.ok(Number.isFinite(a[key]) && Math.abs(a[key] - b[key]) <= 1e-9, key);
    for (let i = 0; i < 2; i++) assert.ok(Number.isFinite(a.center[i]) && Math.abs(a.center[i] - b.center[i]) <= 1e-9);
}
const forbidden = ['workerFilterFallbackFeatures', 'vectorTileFeatureWrappers', 'propertyObjects', 'pointObjects', 'geometryPartsMaterialized',
    'overzoomPointObjects', 'mvtReencodes', 'rawTileMainThreadDecodes', 'coordinateTuples', 'propertyDescriptors'].sort();
function stats(workers, strict, encoding) {
    assert.equal(workers.length, strict ? 1 : 0);
    for (const worker of workers) {
        assert.deepEqual([...worker.forbidden].sort(), forbidden);
        for (const name of [...forbidden, 'propertyProxyMisses']) assert.equal(worker.counters[name], 0, name);
        if (encoding === 'mvt') assert.equal(worker.counters.decodedLayers, 0);
        else assert.ok(worker.counters.decodedLayers > 0);
    }
}
const expectedJourneys = ['mercator-pan', 'mercator-wheel', 'terrain-pan', 'terrain-rotate', 'globe-pan', 'globe-wheel', 'globe-terrain-rotate',
    'globe-keyboard', 'projection-forward', 'projection-reverse', 'globe-terrain-orbit', 'globe-terrain-flight'];

/** Verifies archived evidence without turning image differences or the incomplete software campaign into passing qualification. */
function validate(directory, strict, mode, sourceDiff, self = false, incomplete = false) {
    const report = json(`${directory}/results.json`);
    assert.equal(report.status, 'failed');
    assert.match(report.error, incomplete ? /2 !== 3/ : /Non-exact image comparisons/);
    assert.equal(report.strict, strict); assert.equal(report.gpuMode, mode);
    assert.equal(report.referenceMode, self ? 'same-encoding-diagnostic' : 'cross-encoding');
    assert.equal(report.productDiff, sourceDiff);
    assert.deepEqual(report.journeys.map(journey => journey.name), self ? ['globe-terrain-orbit', 'globe-terrain-flight'] : expectedJourneys);
    for (const [path, manifest] of Object.entries(report.manifest)) assert.equal(hash(readFileSync(path)), manifest.sha256, path);
    for (const [path, value] of Object.entries(report.harnessHashes)) assert.equal(hash(readFileSync(path)), value, path);
    for (const [encoding, session] of Object.entries(report.sessions)) {
        assert.deepEqual(session.info.canvas, {width: 800, height: 600}); assert.equal(session.info.pixelRatio, 1);
        if (mode === 'hardware') assert.doesNotMatch(session.info.renderer, /swiftshader|llvmpipe|software/i);
        stats(session.initialStats, strict, encoding);
        if (incomplete) assert.equal(session.finalStats, undefined);
        else stats(session.finalStats, strict, encoding);
        if (!incomplete && strict && encoding === 'mlt') assert.ok(session.finalStats[0].counters.overzoomFeaturesClipped > 0);
    }
    for (const [name, capture] of Object.entries(report.captures)) {
        const queries = JSON.parse(gunzipSync(readFileSync(`${directory}/${name}.json.gz`)));
        for (const [key, features] of Object.entries({...queries.source, rendered: queries.rendered})) {
            assert.equal(features.length, capture.counts[key]); assert.equal(signature(features), capture.hashes[key]);
        }
        assert.deepEqual(capture.vectorSourcesPreserved, [true, true]);
        assert.deepEqual(capture.selectedState, {selected: true}); assert.deepEqual(capture.symbolSelectedState, {selected: true});
        pose(capture.camera, capture.camera);
        if (capture.terrain) assert.ok(capture.elevations.every(value => Number.isFinite(value) && value > 0));
        else assert.deepEqual(capture.elevations, [null, null, null]);
        const expectedBlend = name.includes('projection-') ? Math.max(0, Math.min(1, capture.camera.zoom - 2.5)) : name.includes('globe-') ? 1 : 0;
        assert.ok(Math.abs(capture.globeness - expectedBlend) <= 1e-12);
        pixels(directory, name);
    }
    const planned = Array.from({length: report.runs}, (_, index) => report.journeys.flatMap(journey =>
        ['mvt', 'mlt'].map(actor => ({run: index + 1, name: journey.name, actor})))).flat();
    assert.equal(report.motions.length, incomplete ? 22 : planned.length);
    const seen = new Set();
    let loading = 0;
    for (const [index, motion] of report.motions.entries()) {
        const isIncomplete = incomplete && index === report.motions.length - 1;
        assert.deepEqual({run: motion.run, name: motion.name, actor: motion.actor}, planned[index]);
        const key = `${motion.run}-${motion.name}-${motion.actor}`;
        assert.ok(!seen.has(key)); seen.add(key);
        assert.ok(Number.isSafeInteger(motion.run) && motion.run >= 1 && motion.run <= report.runs);
        assert.ok(['mvt', 'mlt'].includes(motion.actor));
        const journey = report.journeys.find(journey => journey.name === motion.name);
        const trace = motion.trace;
        assert.ok(trace.frames.length >= 3);
        assert.ok(trace.frames.some(frame => frame.moving));
        assert.equal(trace.frames.at(-1).moving, false);
        for (const frame of trace.frames) {
            pose(frame.camera, frame.camera);
            assert.ok(Number.isFinite(frame.globeness) && frame.globeness >= 0 && frame.globeness <= 1);
        }
        const types = trace.events.map(event => event.type);
        for (const type of ['movestart', 'move', 'moveend', 'idle']) assert.ok(types.includes(type));
        assert.ok(types.lastIndexOf('idle') > types.lastIndexOf('moveend'));
        stats(motion.stats, strict, motion.actor);
        const after = report.captures[trace.final].camera;
        if (journey.gesture) {
            const input = journey.gesture === 'wheel' ? 'wheel' : journey.gesture === 'keyboard' ? 'keydown' : 'mousedown';
            assert.ok(trace.events.some(event => event.type === `input:${input}` && event.trusted));
            assert.ok(trace.events.some(event => event.original && event.trusted));
            assert.ok(trace.events.filter(event => event.type.startsWith('input:')).every(event => event.trusted));
            if (journey.gesture === 'wheel') {
                assert.ok(after.zoom > motion.before.zoom + 0.05 && after.zoom < motion.before.zoom + 2);
                for (const type of ['zoomstart', 'zoomend']) assert.ok(types.includes(type));
            } else if (journey.gesture === 'rotate') {
                assert.ok(Math.abs(after.bearing - motion.before.bearing) > 2 && Math.abs(after.pitch - motion.before.pitch) > 1);
                for (const type of ['rotatestart', 'rotateend', 'pitchstart', 'pitchend']) assert.ok(types.includes(type));
            } else assert.ok(Math.hypot(after.center[0] - motion.before.center[0], after.center[1] - motion.before.center[1]) > 1e-7);
        } else {
            for (const key of Object.keys(journey.motion.target)) pose({...after, [key]: journey.motion.target[key]}, after);
        }
        if (isIncomplete) assert.equal(key, '1-globe-terrain-orbit-mlt');
        assert.equal(trace.samples.length, journey.gesture ? 0 : isIncomplete ? 2 : 3);
        assert.equal(new Set(trace.samples.map(sample => sample.frame)).size, trace.samples.length);
        for (const sample of trace.samples) {
            assert.equal(trace.frames[sample.frame].loaded, true);
            assert.equal(trace.frames[sample.frame].moving, true);
            assert.ok(sample.progress >= sample.landmark && sample.progress < 1);
            assert.deepEqual(report.captures[sample.capture].camera, trace.frames[sample.frame].camera);
        }
        for (const sample of trace.transients) {
            assert.equal(trace.frames[sample.frame].loaded, false);
            assert.ok(report.captures[sample.capture]);
            assert.ok(!report.comparisons.some(comparison => comparison.actual === sample.capture));
            loading++;
        }
    }
    assert.equal(report.comparisons.length, incomplete ? 36 : (self ? 16 : 48) * report.runs);
    const comparedMotions = incomplete ? report.motions.slice(0, -1) : report.motions;
    assert.deepEqual(report.comparisons.map(comparison => comparison.actual), comparedMotions.flatMap(motion =>
        [motion.trace.final, ...motion.trace.samples.map(sample => sample.capture)]));
    const failures = [];
    for (const comparison of report.comparisons) {
        const {camera: a, ...actual} = report.captures[comparison.actual];
        const {camera: b, ...reference} = report.captures[comparison.reference];
        pose(a, b); assert.deepEqual(actual, reference);
        const difference = delta(pixels(directory, comparison.actual), pixels(directory, comparison.reference));
        assert.deepEqual(difference, {pixels: comparison.pixels, maxDelta: comparison.maxDelta});
        if (difference.pixels) failures.push(comparison.actual);
    }
    const expectedFailures = [];
    for (let run = 1; run <= (incomplete ? 0 : report.runs); run++) for (const encoding of ['mvt', 'mlt']) for (const index of [1, 2, 3]) {
        expectedFailures.push(`${run}-globe-terrain-flight-${encoding}-frame-${index}`);
    }
    assert.deepEqual(failures.sort(), expectedFailures.sort());
    return {report, summary: {status: incomplete ? 'incomplete-coverage' : 'non-exact-static-oracle', plannedMotions: planned.length,
        observedMotions: report.motions.length, comparedMotions: comparedMotions.length, comparisons: report.comparisons.length,
        exact: report.comparisons.length - failures.length, nonExact: failures.length,
        finalExact: report.comparisons.filter(comparison => comparison.kind === 'final' && comparison.pixels === 0).length,
        ...(incomplete ? {coverageFailure: '1-globe-terrain-orbit-mlt: 2 loaded samples instead of 3; remaining journeys and second run not executed'} : {}),
        loadingDiagnostics: loading, failures}};
}

function failures(report) { return report.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed').map(test => test.fullName)).sort(); }
const [production, gpuDirectory, software, self, unit, build, integration, gpu, gpuStats, beforeWheel, geography, renderSoftware, integrationFirst] = process.argv.slice(2);
assert.ok(renderSoftware, 'Expected motion campaigns, same-encoding control, test reports, counters and geography regression');
const sourceDiff = execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'});
const campaigns = [validate(production, false, 'hardware', sourceDiff), validate(gpuDirectory, true, 'hardware', sourceDiff),
    validate(software, true, 'software', sourceDiff, false, true), validate(self, true, 'hardware', sourceDiff, true)];
const result = {status: 'verified-partial-motion-qualification', sourceDiffSha256: hash(sourceDiff), suites: {}, campaigns: {}, sources: {},
    limitation: 'Moving terrain zoom textures retain history; static replay is not an exact intermediate-frame oracle. Software coverage is incomplete. Loading frames and native trajectory equivalence are not certified.'};
for (const [name, path] of Object.entries({unit, build, integration, gpu, beforeWheel, renderSoftware, ...(integrationFirst ? {integrationFirst} : {})})) {
    const report = json(path);
    if (name === 'gpu') {
        const previous = JSON.parse(gunzipSync(readFileSync('test/bench/baselines/browser-geography-production-v4-20260907/gpu.json.gz')));
        assert.deepEqual(failures(report), failures(previous));
        assert.equal(report.numTotalTests, 1923);
    } else if (name === 'beforeWheel') { assert.equal(report.numFailedTests, 1); assert.equal(report.numPassedTests, 1); }
    else if (name === 'integrationFirst') {
        assert.equal(report.numFailedTests, 1); assert.equal(report.numPassedTests, 177);
        assert.match(failures(report)[0], /Marker: correct position/);
    }
    else { assert.equal(report.numFailedTests, 0); assert.equal(report.success, true); }
    if (name === 'renderSoftware') assert.equal(report.numPassedTests, 243);
    result.suites[name] = {passed: report.numPassedTests, failed: report.numFailedTests, sha256: hash(readFileSync(path))};
    writeFileSync(`${production}/${name}.json.gz`, gzipSync(readFileSync(path)));
}
for (const [name, path, count] of [['gpu', gpuStats, 1923], ['software', renderSoftware.replace('render-software-', 'render-software-workers-'), 243]]) {
    const counters = json(path); assert.equal(Object.keys(counters).length, count);
    for (const workers of Object.values(counters)) for (const worker of workers) for (const key of [...forbidden, 'propertyProxyMisses']) assert.equal(worker[key], 0);
    writeFileSync(`${production}/${name}-workers.json.gz`, gzipSync(readFileSync(path)));
    writeFileSync(`${production}/${name}-metadata.json.gz`, gzipSync(readFileSync(path.replace('-workers-', '-metadata-'))));
}
const regression = json(`${geography}/results.json`);
assert.equal(regression.status, 'passed'); assert.equal(regression.productDiff, sourceDiff);
assert.equal(regression.strict, true);
assert.equal(Object.keys(regression.images).length, 23);
for (const step of regression.steps) {
    assert.deepEqual(pixels(geography, `mvt-${step.name}`), pixels(geography, `mlt-${step.name}`));
    assert.deepEqual(regression.sessions.mvt.checkpoints[step.name], regression.sessions.mlt.checkpoints[step.name]);
}
writeFileSync(`${production}/geography-regression.json.gz`, gzipSync(readFileSync(`${geography}/results.json`)));
for (const path of [...Object.keys(campaigns[0].report.harnessHashes), 'test/bench/e2e/mlt-motion-validate.mjs',
    'src/ui/handler/scroll_zoom.ts', 'src/ui/handler/scroll_zoom.test.ts', 'src/webgl/render_to_texture.ts', 'src/webgl/rtt_fingerprint.ts']) {
    writeFileSync(`${production}/${basename(path)}.gz`, gzipSync(readFileSync(path))); result.sources[path] = hash(readFileSync(path));
}
for (const [index, directory] of [production, gpuDirectory, software, self].entries()) {
    result.campaigns[basename(directory)] = {...campaigns[index].summary, files: Object.fromEntries(readdirSync(directory)
        .filter(name => /\.(png|json|gz)$/.test(name) && name !== 'validation.json').map(name => [name, hash(readFileSync(`${directory}/${name}`))]))};
}
writeFileSync(`${production}/validation.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({status: result.status, campaigns: campaigns.map(campaign => campaign.summary), suites: result.suites}, null, 2));
process.exitCode = 1;
