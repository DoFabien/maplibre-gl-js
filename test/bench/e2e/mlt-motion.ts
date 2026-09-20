import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import type {Page} from 'puppeteer';
import minimist from 'minimist';
import {PNG} from 'pngjs';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {installScenario, type GeographyAction, type ScenarioWindow} from './mlt-lifecycle-page.ts';
import {installMotionObserver, type CapturedFrame, type MotionSnapshot, type MotionSpec, type MotionTrace, type MotionWindow, type Pose} from './mlt-motion-page.ts';
import {difference, localServer, sha256, signature, workerStats} from './mlt-geography.ts';

type Encoding = 'mvt' | 'mlt';
type Gesture = 'pan' | 'wheel' | 'rotate' | 'keyboard';
type Journey = {name: string; setup: GeographyAction; gesture?: Gesture; blend?: boolean; start?: MotionSpec['target']; motion: MotionSpec};
type Summary = Omit<MotionSnapshot, 'queries'> & {counts: Record<string, number>; hashes: Record<string, string>};
type Sample = {capture: string; frame: number; landmark: number; progress: number};
type Trace = Omit<MotionTrace, 'samples' | 'transients' | 'final'> & {samples: Sample[]; transients: Sample[]; final: string};

const world: GeographyAction = {camera: 'world', projection: 'globe'};
const journeys: Journey[] = [
    {name: 'mercator-pan', setup: {camera: 'home'}, gesture: 'pan', motion: {method: 'gesture'}},
    {name: 'mercator-wheel', setup: {camera: 'home'}, gesture: 'wheel', motion: {method: 'gesture'}},
    {name: 'terrain-pan', setup: {camera: 'home', terrain: {source: 'dem-local', exaggeration: 1}}, gesture: 'pan', motion: {method: 'gesture'}},
    {name: 'terrain-rotate', setup: {camera: 'home', terrain: {source: 'dem-local', exaggeration: 1}}, gesture: 'rotate', motion: {method: 'gesture'}},
    {name: 'globe-pan', setup: world, gesture: 'pan', motion: {method: 'gesture'}},
    {name: 'globe-wheel', setup: world, gesture: 'wheel', motion: {method: 'gesture'}},
    {name: 'globe-terrain-rotate', setup: {...world, terrain: {source: 'dem-world', exaggeration: 1}}, gesture: 'rotate', motion: {method: 'gesture'}},
    {name: 'globe-keyboard', setup: world, gesture: 'keyboard', motion: {method: 'gesture'}},
    {name: 'projection-forward', setup: world, blend: true, motion: {method: 'easeTo', target: {zoom: 3.5}, axis: 'zoom'}},
    {name: 'projection-reverse', setup: world, blend: true, start: {zoom: 3.5}, motion: {method: 'easeTo', target: {zoom: 2.5}, axis: 'zoom'}},
    {name: 'globe-terrain-orbit', setup: {...world, terrain: {source: 'dem-world', exaggeration: 1}},
        motion: {method: 'easeTo', target: {pitch: 30, bearing: -25}, axis: 'bearing'}},
    {name: 'globe-terrain-flight', setup: {...world, terrain: {source: 'dem-world', exaggeration: 1}},
        motion: {method: 'flyTo', target: {center: [-73, 38], zoom: 3.25, pitch: 30, bearing: -25}, axis: 'bearing'}}
];

/** Browser input is dispatched by Puppeteer/CDP, never by DOM dispatchEvent or by replacing a handler. */
async function input(page: Page, gesture: Gesture): Promise<void> {
    await page.mouse.move(400, 300);
    if (gesture === 'wheel') { await page.mouse.wheel({deltaY: -120}); return; }
    if (gesture === 'keyboard') { await page.keyboard.press('ArrowRight'); return; }
    const button = gesture === 'pan' ? 'left' : 'right';
    await page.mouse.down({button});
    try {
        for (let step = 1; step <= 8; step++) {
            await page.mouse.move(400 + step * 6, 300 - step * 3);
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    } finally { await page.mouse.up({button}); }
}

function comparePose(actual: Pose, expected: Pose): void {
    for (const [key, value] of Object.entries(expected)) {
        const a = actual[key];
        const pairs = Array.isArray(value) ? value.map((value, index) => [a[index], value]) : [[a, value]];
        for (const [a, b] of pairs) assert.ok(Number.isFinite(a) && Math.abs(a - b) <= 1e-9, `${key}: ${a} != ${b}`);
    }
}

function checkSnapshot(snapshot: MotionSnapshot, journey: Journey): void {
    comparePose(snapshot.camera, snapshot.camera);
    assert.deepEqual(snapshot.vectorSourcesPreserved, [true, true]);
    assert.deepEqual(snapshot.selectedState, {selected: true});
    assert.deepEqual(snapshot.symbolSelectedState, {selected: true});
    assert.equal(snapshot.terrain?.source, journey.setup.terrain?.source);
    if (snapshot.terrain) assert.ok(snapshot.elevations.every(value => Number.isFinite(value) && value > 0));
    else assert.deepEqual(snapshot.elevations, [null, null, null]);
    for (const name of journey.setup.camera === 'world' ? ['world-land', 'world-water', 'world-admin'] : ['buildings', 'roads', 'poi-labels']) {
        assert.ok(snapshot.layerCounts[name] > 0, `${journey.name}: missing ${name}`);
    }
    const expectedBlend = journey.blend ? Math.max(0, Math.min(1, snapshot.camera.zoom - 2.5)) : journey.setup.projection === 'globe' ? 1 : 0;
    assert.ok(Math.abs(snapshot.globeness - expectedBlend) <= 1e-12);
}

/** Preserves every raw camera coordinate; only public setter/getter round-trips use the existing 1e-9 pose tolerance. */
function checkTrace(trace: MotionTrace, before: Pose, journey: Journey): void {
    assert.ok(trace.frames.length >= 3, `${journey.name}: too few render events`);
    assert.ok(trace.frames.some(frame => frame.moving));
    assert.equal(trace.frames.at(-1).moving, false);
    for (const frame of trace.frames) {
        comparePose(frame.camera, frame.camera);
        assert.ok(Number.isFinite(frame.globeness) && frame.globeness >= 0 && frame.globeness <= 1);
    }
    const types = trace.events.map(event => event.type);
    for (const type of ['movestart', 'move', 'moveend', 'idle']) assert.ok(types.includes(type), `${journey.name}: no ${type}`);
    assert.ok(types.lastIndexOf('moveend') < types.lastIndexOf('idle'));
    const after = trace.final.snapshot.camera;
    const isZoom = journey.gesture === 'wheel' || journey.blend;
    const isRotation = journey.gesture === 'rotate' || journey.motion.method === 'flyTo';
    for (const type of isZoom ? ['zoomstart', 'zoomend'] : isRotation ? ['rotatestart', 'rotateend', 'pitchstart', 'pitchend'] : []) assert.ok(types.includes(type), type);
    if (!journey.gesture) {
        assert.equal(trace.samples.length, 3);
        assert.equal(new Set(trace.samples.map(sample => sample.frame)).size, 3);
        for (const sample of trace.samples) {
            assert.ok(sample.progress >= sample.landmark && sample.progress < 1);
            assert.equal(trace.frames[sample.frame].loaded, true);
        }
        const target = {...before, ...journey.motion.target} as Pose;
        for (const key of Object.keys(journey.motion.target)) comparePose({...after, [key]: target[key]}, after);
        return;
    }
    const expectedInput = journey.gesture === 'wheel' ? 'wheel' : journey.gesture === 'keyboard' ? 'keydown' : 'mousedown';
    assert.ok(trace.events.some(event => event.type === `input:${expectedInput}` && event.trusted));
    assert.ok(trace.events.some(event => event.original && event.trusted));
    assert.ok(trace.events.filter(event => event.type.startsWith('input:')).every(event => event.trusted));
    assert.equal(trace.samples.length, 0);
    if (journey.gesture === 'wheel') assert.ok(after.zoom > before.zoom + 0.05 && after.zoom < before.zoom + 2);
    else if (journey.gesture === 'rotate') assert.ok(Math.abs(after.bearing - before.bearing) > 2 && Math.abs(after.pitch - before.pitch) > 1);
    else assert.ok(Math.hypot(after.center[0] - before.center[0], after.center[1] - before.center[1]) > 1e-7);
}

/** Flips raw WebGL row order into PNG; no filtering, resampling or pixel tolerance. */
function archive(output: string, name: string, frame: CapturedFrame, journey: Journey): Summary {
    checkSnapshot(frame.snapshot, journey);
    const png = new PNG({width: 800, height: 600});
    assert.equal(frame.pixels.length, 800 * 600 * 4);
    const pixels = Buffer.from(frame.pixels);
    for (let row = 0; row < 600; row++) pixels.copy(png.data, (599 - row) * 3200, row * 3200, (row + 1) * 3200);
    writeFileSync(`${output}/${name}.png`, PNG.sync.write(png));
    const {queries, ...metadata} = frame.snapshot;
    writeFileSync(`${output}/${name}.json.gz`, gzipSync(JSON.stringify(queries)));
    const collections = {...queries.source, rendered: queries.rendered};
    return {...metadata, counts: Object.fromEntries(Object.entries(collections).map(([key, features]) => [key, features.length])),
        hashes: Object.fromEntries(Object.entries(collections).map(([key, features]) => [key, signature(features)]))};
}

async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {boolean: ['strict', 'self-reference'], default: {runs: 1}});
    assert.ok(args.output, 'Use a new --output directory');
    assert.ok(Number.isSafeInteger(Number(args.runs)) && Number(args.runs) > 0);
    const selected = args.only ? journeys.filter(journey => String(args.only).split(',').includes(journey.name)) : journeys;
    assert.ok(selected.length);
    const output = resolve(String(args.output));
    mkdirSync(output, {recursive: false});
    const server = await localServer(output, args.strict);
    const report = {status: 'running', startedAt: new Date().toISOString(), strict: args.strict, runs: Number(args.runs), journeys: selected,
        referenceMode: args['self-reference'] ? 'same-encoding-diagnostic' : 'cross-encoding',
        gpuMode: process.env.PUPPETEER_GPU ?? 'software', manifest: server.manifest, requests: server.requests,
        productDiff: execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}),
        git: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        tileSpecGit: execFileSync('git', ['-C', '../maplibre-tile-spec', 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        harnessHashes: Object.fromEntries(['test/bench/e2e/mlt-motion.ts', 'test/bench/e2e/mlt-motion-page.ts', 'test/bench/e2e/mlt-lifecycle-page.ts', 'test/bench/e2e/mlt-geography.ts'].map(path => [path, sha256(readFileSync(path))])),
        browser: '', sessions: {} as Record<string, unknown>, captures: {} as Record<string, Summary>,
        motions: [] as {name: string; actor: Encoding; run: number; before: Pose; trace: Trace; stats: Awaited<ReturnType<typeof workerStats>>}[],
        comparisons: [] as {actual: string; reference: string; kind: string; pixels: number; maxDelta: number}[], error: undefined as string | undefined};
    function save(): void { writeFileSync(`${output}/results.json`, `${JSON.stringify(report, null, 2)}\n`); }
    const browser = await launchPuppeteer();
    const pages = {} as Record<Encoding, Page>;
    const errors: string[] = [];
    try {
        report.browser = await browser.version();
        for (const encoding of ['mvt', 'mlt'] as const) {
            const page = pages[encoding] = await browser.newPage();
            await page.bringToFront();
            page.on('pageerror', error => errors.push(String(error)));
            page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
            page.on('request', request => { if (!request.url().startsWith(`${server.origin}/`) && !request.url().startsWith('blob:')) errors.push(`Non-local request: ${request.url()}`); });
            await page.setViewport({width: 800, height: 600, deviceScaleFactor: 1});
            await page.setCacheEnabled(false);
            await page.goto(server.origin);
            await page.addStyleTag({content: '#map {width:800px;height:600px}'});
            await page.addStyleTag({url: `${server.origin}/dist/maplibre-gl.css`});
            const info = await page.evaluate(installScenario, {encoding, origin: server.origin, scenario: 'geography' as const, interactive: true});
            assert.deepEqual(info.canvas, {width: 800, height: 600}); assert.equal(info.pixelRatio, 1);
            if (report.gpuMode === 'hardware') assert.doesNotMatch(info.renderer, /swiftshader|llvmpipe|software/i);
            await page.evaluate(installMotionObserver);
            await page.evaluate(async () => { const scenario = (window as ScenarioWindow).mltScenario; await scenario.select(true); await scenario.selectSymbol(true); });
            report.sessions[encoding] = {info, initialStats: await workerStats(page, args.strict, encoding)};
        }
        for (let run = 1; run <= Number(args.runs); run++) for (const journey of selected) for (const actor of ['mvt', 'mlt'] as const) {
            const reference = args['self-reference'] ? actor : actor === 'mvt' ? 'mlt' : 'mvt';
            const page = pages[actor];
            const name = `${run}-${journey.name}-${actor}`;
            console.log(name);
            for (const encoding of new Set<Encoding>([reference, actor])) {
                await pages[encoding].bringToFront();
                await pages[encoding].evaluate(async journey => (window as MotionWindow).motionHarness.prepare(journey.setup, !!journey.blend, journey.start), journey);
            }
            await page.focus('.maplibregl-canvas');
            const before = await page.evaluate(() => (window as MotionWindow).motionHarness.pose());
            await page.evaluate(spec => (window as MotionWindow).motionHarness.begin(spec), journey.motion);
            if (journey.gesture) await input(page, journey.gesture);
            const trace = await page.evaluate(() => (window as MotionWindow).motionHarness.end());
            const final = `${name}-final`;
            report.captures[final] = archive(output, final, trace.final, journey);
            const samples: Trace['samples'] = trace.samples.map((sample, index) => {
                const capture = `${name}-frame-${index + 1}`;
                report.captures[capture] = archive(output, capture, sample, journey);
                return {capture, frame: sample.frame, landmark: sample.landmark, progress: sample.progress};
            });
            const transients = trace.transients.map((sample, index) => {
                const capture = `${name}-loading-${index + 1}`;
                report.captures[capture] = archive(output, capture, sample, journey);
                return {capture, frame: sample.frame, landmark: sample.landmark, progress: sample.progress};
            });
            report.motions.push({name: journey.name, actor, run, before, trace: {events: trace.events, frames: trace.frames, samples, transients, final},
                stats: await workerStats(page, args.strict, actor)});
            save();
            checkTrace(trace, before, journey);
            await pages[reference].bringToFront();
            for (const actual of [final, ...samples.map(sample => sample.capture)]) {
                const frame = await pages[reference].evaluate(camera => (window as MotionWindow).motionHarness.replay(camera), report.captures[actual].camera);
                const referenceName = `${actual}-reference`;
                report.captures[referenceName] = archive(output, referenceName, frame, journey);
                const {camera: a, ...actualSummary} = report.captures[actual];
                const {camera: b, ...referenceSummary} = report.captures[referenceName];
                comparePose(a, b);
                assert.deepEqual(actualSummary, referenceSummary, `Queries/state ${actual}`);
                const delta = difference(`${output}/${actual}.png`, `${output}/${referenceName}.png`);
                report.comparisons.push({actual, reference: referenceName, kind: actual === final ? 'final' : 'intermediate', ...delta});
                save();
            }
            assert.deepEqual(errors, []);
        }
        for (const encoding of ['mvt', 'mlt'] as const) {
            const stats = await workerStats(pages[encoding], args.strict, encoding);
            report.sessions[encoding] = {...report.sessions[encoding] as object, finalStats: stats};
            await pages[encoding].evaluate(() => { (window as MotionWindow).motionHarness.dispose(); (window as ScenarioWindow).mltScenario.destroy(); });
            assert.equal(await pages[encoding].evaluate(() => document.querySelectorAll('canvas').length), 0);
        }
        assert.deepEqual(errors, []);
        const differences = report.comparisons.filter(comparison => comparison.pixels !== 0);
        assert.equal(differences.length, 0, `Non-exact image comparisons: ${differences.map(comparison => comparison.actual).join(', ')}`);
        report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
    finally { save(); await browser.close(); await server.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
