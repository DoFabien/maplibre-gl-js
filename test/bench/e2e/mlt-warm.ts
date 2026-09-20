import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import type {Browser} from 'puppeteer';
import minimist from 'minimist';
import {PNG} from 'pngjs';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {installScenario, type GeographyAction, type ScenarioWindow} from './mlt-lifecycle-page.ts';
import {installWarmClock, type HistoryDisposal, type HistoryFrame, type HistoryState, type WarmWindow} from './mlt-warm-page.ts';
import {localServer, sha256, signature, difference, workerStats} from './mlt-geography.ts';

type Journey = {name: string; setup: GeographyAction; method: 'easeTo' | 'flyTo'; target: {
    center?: [number, number]; zoom?: number; pitch?: number; bearing?: number;
}; blend?: boolean; startZoom?: number};
const journeys: Journey[] = [
    {name: 'projection-forward', setup: {camera: 'world', projection: 'mercator'}, blend: true, method: 'easeTo', target: {zoom: 3.5}},
    {name: 'projection-reverse', setup: {camera: 'world', projection: 'mercator'}, blend: true, startZoom: 3.5, method: 'easeTo', target: {zoom: 2.5}},
    {name: 'terrain-orbit', setup: {camera: 'world', projection: 'globe', terrain: {source: 'dem-world', exaggeration: 1}},
        method: 'easeTo', target: {pitch: 30, bearing: -25}},
    {name: 'terrain-flight', setup: {camera: 'world', projection: 'globe', terrain: {source: 'dem-world', exaggeration: 1}},
        method: 'flyTo', target: {center: [-73, 38], zoom: 3.25, pitch: 30, bearing: -25}}
];
type Encoding = 'mvt' | 'mlt';
type Summary = Omit<HistoryFrame, 'pixels' | 'snapshot'> & {
    snapshot: Omit<HistoryFrame['snapshot'], 'queries'> & {hashes: Record<string, string>; counts: Record<string, number>};
};
type Session = {run: number; journey: string; encoding: Encoding; control: boolean; info: Awaited<ReturnType<typeof installScenario>>;
    captures: string[]; preparation: {stage: string; captures: string[]; state: HistoryState; stats: Awaited<ReturnType<typeof workerStats>>; requests: Record<string, number>}[]; terminal?: HistoryState; initialStats: Awaited<ReturnType<typeof workerStats>>; finalStats?: Awaited<ReturnType<typeof workerStats>>;
    disposal?: HistoryDisposal; errors: string[]};
type Comparison = {actual: string; reference: string; kind: 'encoding' | 'repeat' | 'control-prefix' | 'negative-control';
    pixels: number; maxDelta: number; stateEqual: boolean};
type Report = {status: string; startedAt: string; initialization: string; strict: boolean; gpuMode: string; runs: number; journeys: Journey[]; controls: boolean;
    git: string; tileSpecGit: string; productDiff: string; manifest: Awaited<ReturnType<typeof localServer>>['manifest']; requests: Record<string, number>;
    harnessHashes: Record<string, string>; browser: string; sessions: Record<string, Session>; captures: Record<string, Summary>;
    comparisons: Comparison[]; error?: string};

/** Archives the actual render buffer and complete queries at each scheduled frame, including still-loading frames. */
function archive(output: string, name: string, frame: HistoryFrame): Summary {
    const png = new PNG({width: 800, height: 600});
    assert.equal(frame.pixels.length, 800 * 600 * 4);
    const pixels = Buffer.from(frame.pixels);
    for (let row = 0; row < 600; row++) pixels.copy(png.data, (599 - row) * 3200, row * 3200, (row + 1) * 3200);
    writeFileSync(`${output}/${name}.png`, PNG.sync.write(png));
    const {pixels: _, snapshot: {queries, ...snapshot}, ...state} = frame;
    writeFileSync(`${output}/${name}.json.gz`, gzipSync(JSON.stringify(queries)));
    const collections = {...queries.source, rendered: queries.rendered};
    return {...state, snapshot: {...snapshot, hashes: Object.fromEntries(Object.entries(collections).map(([key, value]) => [key, signature(value)])),
        counts: Object.fromEntries(Object.entries(collections).map(([key, value]) => [key, value.length]))}};
}

function checkFrame(frame: HistoryFrame, journey: Journey): void {
    assert.equal(frame.frozen, true); assert.equal(frame.clockTime, 1000000 + frame.time); assert.equal(frame.clamped, true);
    const snapshot = frame.snapshot;
    assert.deepEqual(snapshot.vectorSourcesPreserved, [true, true]);
    assert.deepEqual(snapshot.selectedState, {selected: true}); assert.deepEqual(snapshot.symbolSelectedState, {selected: true});
    assert.equal(snapshot.terrain?.source, journey.setup.terrain?.source);
    if (snapshot.terrain) assert.ok(snapshot.elevations.every(value => Number.isFinite(value) && value > 0));
    else assert.deepEqual(snapshot.elevations, [null, null, null]);
    for (const id of ['world-land', 'world-water', 'world-admin']) assert.ok(snapshot.layerCounts[id] > 0, id);
    for (const value of [...snapshot.camera.center, snapshot.camera.zoom, snapshot.camera.pitch, snapshot.camera.bearing, snapshot.camera.roll, snapshot.camera.elevation]) assert.ok(Number.isFinite(value));
    const blend = journey.blend ? Math.max(0, Math.min(1, snapshot.camera.zoom - 2.5)) : 1;
    assert.ok(Math.abs(snapshot.globeness - blend) <= 1e-12);
    assert.equal(frame.moving, frame.time < 2000);
}

/** Arrival order within one held interval may vary; its complete multiset and frame boundary must be identical. Raw events are retained. */
function eventSignature(events: HistoryState['events']): string[] { return events.map(event => JSON.stringify(event)).sort(); }

async function session(browser: Browser, server: Awaited<ReturnType<typeof localServer>>, output: string, report: Report,
    journey: Journey, encoding: Encoding, run: number, control: boolean, save: () => void): Promise<void> {
    const name = `${control ? 'control' : run}-${journey.name}-${encoding}`;
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
    page.on('request', request => { if (!request.url().startsWith(`${server.origin}/`) && !request.url().startsWith('blob:')) errors.push(`Non-local request: ${request.url()}`); });
    try {
        await page.bringToFront();
        await page.setViewport({width: 800, height: 600, deviceScaleFactor: 1});
        await page.setCacheEnabled(false);
        await page.goto(server.origin);
        await page.addStyleTag({content: '#map {width:800px;height:600px}'});
        await page.addStyleTag({url: `${server.origin}/dist/maplibre-gl.css`});
        const info = await page.evaluate(installScenario, {encoding, origin: server.origin, scenario: 'geography' as const});
        assert.deepEqual(info.canvas, {width: 800, height: 600}); assert.equal(info.pixelRatio, 1);
        if (report.gpuMode === 'hardware') assert.doesNotMatch(info.renderer, /swiftshader|llvmpipe|software/i);
        await page.evaluate(async () => {
            const scenario = (window as ScenarioWindow).mltScenario;
            await scenario.select(true); await scenario.selectSymbol(true);
        });
        const record: Session = report.sessions[name] = {run, journey: journey.name, encoding, control, info, captures: [], preparation: [],
            initialStats: await workerStats(page, report.strict, encoding), errors};
        const initialRequests = {...server.requests};
        await page.evaluate(installWarmClock, server.origin);
        for (const stage of ['world', 'configure', 'excursion', 'return'] as const) {
            await page.evaluate(({stage, journey}) => (window as WarmWindow).mltWarm.prepare(stage,
                {blend: journey.blend, startZoom: journey.startZoom, terrain: Boolean(journey.setup.terrain)}), {stage, journey});
            const captures: string[] = [];
            let state = await page.evaluate(() => (window as WarmWindow).mltWarm.state());
            for (let step = 1; state.pending && step <= 15; step++) {
                const key = `${name}-prepare-${stage}-${step}`;
                const frame = await page.evaluate(stage => (window as WarmWindow).mltWarm.step(0, `prepare-${stage}`), stage);
                report.captures[key] = archive(output, key, frame); captures.push(key);
                state = await page.evaluate(() => (window as WarmWindow).mltWarm.state());
                save();
            }
            assert.ok(captures.length > 0); assert.equal(state.pending, 0); assert.equal(state.idle, true); assert.equal(state.tilesLoaded, true);
            record.preparation.push({stage, captures, state, stats: await workerStats(page, report.strict, encoding),
                requests: Object.fromEntries(Object.entries(server.requests).map(([key, value]) => [key, value - (initialRequests[key] ?? 0)]).filter(([, value]) => value !== 0))});
            save();
        }
        const outbound = record.preparation[2]; const returned = record.preparation[3];
        assert.deepEqual(returned.requests, outbound.requests, 'The return must reuse warm tiles without network requests');
        if (report.strict && encoding === 'mlt') for (const key of ['decodedLayers', 'overzoomFeaturesClipped'] as const) {
            assert.equal(returned.stats[0].counters[key], outbound.stats[0].counters[key], `Warm return must not repeat ${key}`);
        }
        await page.evaluate(journey => (window as WarmWindow).mltWarm.begin(journey.method, journey.target), journey);
        async function capture(time: number, phase: string, label: string): Promise<void> {
            const key = `${name}-${label}`;
            const frame = await page.evaluate(({time, phase}) => (window as WarmWindow).mltWarm.step(time, phase), {time, phase});
            report.captures[key] = archive(output, key, frame); record.captures.push(key); save();
            checkFrame(frame, journey);
        }
        console.log(name);
        for (let step = 1; step <= (control ? 4 : 16); step++) await capture(step * 125, 'animation', `frame-${step}`);
        if (control) await capture(500, 'control', 'extra');
        record.terminal = await page.evaluate(() => (window as WarmWindow).mltWarm.state());
        for (let step = 1; !control && record.terminal.pending && step <= 10; step++) {
            await capture(2000, 'settle', `settle-${step}`);
            record.terminal = await page.evaluate(() => (window as WarmWindow).mltWarm.state());
        }
        assert.equal(record.terminal.moving, control); assert.equal(record.terminal.idle, !control);
        assert.equal(record.terminal.pending, control ? 1 : 0); assert.equal(record.terminal.tilesLoaded, true);
        assert.equal(record.terminal.renders, record.captures.length + record.preparation.flatMap(stage => stage.captures).length);
        assert.ok(!record.terminal.events.some(event => event.type === 'error'));
        if (!control) {
            const final = report.captures[record.captures.at(-1)];
            for (const [key, value] of Object.entries(journey.target)) {
                const actual = final.snapshot.camera[key];
                const expectedValues = Array.isArray(value) ? value : [value];
                const actualValues = Array.isArray(actual) ? actual : [actual];
                for (let index = 0; index < expectedValues.length; index++) assert.ok(Math.abs(actualValues[index] - expectedValues[index]) <= 1e-9, `Target ${key}`);
            }
            assert.equal(final.loaded, true);
            for (const time of [500, 1000, 1500]) assert.ok(record.captures.some(key => report.captures[key].time === time && report.captures[key].moving));
        }
        record.finalStats = await workerStats(page, report.strict, encoding);
        assert.deepEqual(errors, []);
        record.disposal = await page.evaluate(() => (window as WarmWindow).mltWarm.dispose());
        assert.deepEqual(record.disposal, {pendingAfterRemove: 0, canvases: 0, clockRestored: true, schedulerRestored: true}); save();
    } finally { await page.close(); }
}

function compare(output: string, report: Report, first: string, second: string, kind: Comparison['kind']): void {
    const a = report.captures[first]; const b = report.captures[second];
    assert.ok(a && b, `Missing capture ${first} / ${second}`);
    const {phase: _a, ...withoutPhaseA} = a; const {phase: _b, ...withoutPhaseB} = b;
    report.comparisons.push({actual: first, reference: second, kind, ...difference(`${output}/${first}.png`, `${output}/${second}.png`),
        stateEqual: isDeepStrictEqual(kind === 'negative-control' ? withoutPhaseA : a, kind === 'negative-control' ? withoutPhaseB : b)});
}

async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {boolean: ['strict', 'controls'], default: {runs: 2, controls: true}});
    assert.ok(args.output, 'Use a new output directory');
    const runs = Number(args.runs); assert.ok(Number.isSafeInteger(runs) && runs > 0);
    const names = args.only ? String(args.only).split(',') : journeys.map(journey => journey.name);
    assert.ok(names.length && names.every(name => journeys.some(journey => journey.name === name)));
    const selected = journeys.filter(journey => names.includes(journey.name));
    const output = resolve(String(args.output)); mkdirSync(output, {recursive: false});
    const server = await localServer(output, args.strict);
    const report: Report = {status: 'running', startedAt: new Date().toISOString(), initialization: 'controlled-world-preparation-excursion-return-no-reload',
        strict: args.strict, gpuMode: process.env.PUPPETEER_GPU ?? 'software',
        runs, controls: args.controls && names.includes('terrain-flight'), journeys: selected,
        git: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        tileSpecGit: execFileSync('git', ['-C', '../maplibre-tile-spec', 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        productDiff: execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}), manifest: server.manifest, requests: server.requests,
        harnessHashes: Object.fromEntries(['test/bench/e2e/mlt-warm.ts', 'test/bench/e2e/mlt-warm-page.ts', 'test/bench/e2e/mlt-lifecycle-page.ts', 'test/bench/e2e/mlt-geography.ts', 'test/bench/e2e/mlt-motion-page.ts']
            .map(path => [path, sha256(readFileSync(path))])), browser: '', sessions: {}, captures: {}, comparisons: []};
    function save(): void { writeFileSync(`${output}/results.json`, `${JSON.stringify(report, null, 2)}\n`); }
    const browser = await launchPuppeteer();
    try {
        report.browser = await browser.version();
        for (let run = 1; run <= runs; run++) for (const journey of selected) for (const encoding of (run % 2 ? ['mvt', 'mlt'] : ['mlt', 'mvt']) as Encoding[]) {
            await session(browser, server, output, report, journey, encoding, run, false, save);
        }
        if (report.controls) for (const encoding of ['mvt', 'mlt'] as const) await session(browser, server, output, report, journeys.at(-1), encoding, 1, true, save);
        for (const [name, record] of Object.entries(report.sessions)) {
            const prepared = record.preparation.flatMap(stage => stage.captures);
            if (record.control) {
                for (const key of prepared) compare(output, report, key, key.replace('control-', '1-'), 'control-prefix');
                for (let frame = 1; frame <= 4; frame++) compare(output, report, `${name}-frame-${frame}`, `1-terrain-flight-${record.encoding}-frame-${frame}`, 'control-prefix');
                compare(output, report, `${name}-extra`, `${name}-frame-4`, 'negative-control');
                continue;
            }
            if (record.encoding === 'mvt') {
                const other = name.replace(/-mvt$/, '-mlt');
                assert.equal(record.captures.length, report.sessions[other].captures.length);
                for (const capture of [...prepared, ...record.captures]) compare(output, report, capture, capture.replace('-mvt-', '-mlt-'), 'encoding');
                assert.deepEqual(eventSignature(record.terminal.events), eventSignature(report.sessions[other].terminal.events));
                assert.deepEqual(record.terminal.barriers, report.sessions[other].terminal.barriers);
            }
            if (record.run === 1) continue;
            const first = name.replace(/^\d+-/, '1-');
            assert.equal(record.captures.length, report.sessions[first].captures.length);
            for (const capture of record.captures) compare(output, report, capture, capture.replace(/^\d+-/, '1-'), 'repeat');
            assert.deepEqual(eventSignature(record.terminal.events), eventSignature(report.sessions[first].terminal.events));
            assert.deepEqual(record.terminal.barriers, report.sessions[first].terminal.barriers);
        }
        save();
        for (const comparison of report.comparisons) {
            assert.equal(comparison.stateEqual, true, `Non-exact state: ${comparison.actual}`);
            if (comparison.kind === 'negative-control') assert.ok(comparison.pixels > 0, 'Same-time repaint must expose history-dependent terrain textures');
            else assert.equal(comparison.pixels, 0, `Non-exact history replay: ${comparison.actual}`);
        }
        report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
    finally { save(); await browser.close(); await server.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
