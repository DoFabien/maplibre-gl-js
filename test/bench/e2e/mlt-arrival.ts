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
import {installScenario, type ScenarioWindow} from './mlt-lifecycle-page.ts';
import {installArrivalClock, type ArrivalFrame, type ArrivalState, type ArrivalDisposal, type ArrivalWindow} from './mlt-arrival-page.ts';
import {arrivalServer, arrivalTiles, type DeliveryEvent} from './mlt-arrival-server.ts';
import {sha256, signature, difference, workerStats} from './mlt-geography.ts';

type Encoding = 'mvt' | 'mlt';
type Summary = Omit<ArrivalFrame, 'pixels' | 'snapshot'> & {
    snapshot: Omit<ArrivalFrame['snapshot'], 'queries'> & {hashes: Record<string, string>; counts: Record<string, number>};
};
type Session = {run: number; order: string; encoding: Encoding; info: Awaited<ReturnType<typeof installScenario>>;
    captures: string[]; terminal?: ArrivalState; initialStats: Awaited<ReturnType<typeof workerStats>>; finalStats?: Awaited<ReturnType<typeof workerStats>>;
    disposal?: ArrivalDisposal; deliveries?: DeliveryEvent[]; errors: string[]};
type Comparison = {actual: string; reference: string; kind: 'encoding' | 'repeat' | 'final' | 'delivery-control';
    pixels: number; maxDelta: number; stateEqual: boolean};
type Report = {status: string; startedAt: string; strict: boolean; gpuMode: string; runs: number;
    git: string; tileSpecGit: string; productDiff: string; manifest: Awaited<ReturnType<typeof arrivalServer>>['manifest']; requests: Record<string, number>;
    harnessHashes: Record<string, string>; browser: string; sessions: Record<string, Session>; captures: Record<string, Summary>;
    comparisons: Comparison[]; error?: string};

/** Saves every partial render and full query result, not just the eventual fully loaded map. */
function archive(output: string, name: string, frame: ArrivalFrame): Summary {
    const png = new PNG({width: 800, height: 600}); const pixels = Buffer.from(frame.pixels);
    assert.equal(pixels.length, 800 * 600 * 4);
    for (let row = 0; row < 600; row++) pixels.copy(png.data, (599 - row) * 3200, row * 3200, (row + 1) * 3200);
    writeFileSync(`${output}/${name}.png`, PNG.sync.write(png));
    const {pixels: _, snapshot: {queries, ...snapshot}, ...state} = frame;
    writeFileSync(`${output}/${name}.json.gz`, gzipSync(JSON.stringify(queries)));
    const collections = {...queries.source, rendered: queries.rendered};
    return {...state, snapshot: {...snapshot, hashes: Object.fromEntries(Object.entries(collections).map(([key, value]) => [key, signature(value)])),
        counts: Object.fromEntries(Object.entries(collections).map(([key, value]) => [key, value.length]))}};
}

/** Asynchronous work completes while the browser frame scheduler stays held. */
async function until(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const started = performance.now();
    while (!await condition()) {
        if (performance.now() - started > 20000) throw new Error(`Timed out: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function session(browser: Browser, server: Awaited<ReturnType<typeof arrivalServer>>, output: string, report: Report,
    encoding: Encoding, run: number, order: string, save: () => void): Promise<void> {
    const name = `${run}-${order}-${encoding}`; const page = await browser.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
    page.on('request', request => { if (!request.url().startsWith(`${server.origin}/`) && !request.url().startsWith('blob:')) errors.push(`Non-local: ${request.url()}`); });
    try {
        await page.bringToFront(); await page.setViewport({width: 800, height: 600, deviceScaleFactor: 1}); await page.setCacheEnabled(false);
        await page.goto(server.origin); await page.addStyleTag({content: '#map {width:800px;height:600px}'});
        await page.addStyleTag({url: `${server.origin}/dist/maplibre-gl.css`});
        const info = await page.evaluate(installScenario, {encoding, origin: server.origin, scenario: 'geography' as const});
        assert.deepEqual(info.canvas, {width: 800, height: 600}); assert.equal(info.pixelRatio, 1);
        if (report.gpuMode === 'hardware') assert.doesNotMatch(info.renderer, /swiftshader|llvmpipe|software/i);
        await page.evaluate(async () => { const scenario = (window as ScenarioWindow).mltScenario; await scenario.select(true); await scenario.selectSymbol(true); });
        server.start();
        const record: Session = report.sessions[name] = {run, order, encoding, info, captures: [], initialStats: await workerStats(page, report.strict, encoding), errors};
        await page.evaluate(installArrivalClock, server.origin);
        await page.evaluate(encoding => (window as ArrivalWindow).mltArrival.begin(encoding), encoding);
        const tiles = order === 'forward' ? [...arrivalTiles] : [...arrivalTiles].reverse();
        async function capture(time: number, label: string, delivered: number): Promise<void> {
            const key = `${name}-${label}`; server.time(time);
            const frame = await page.evaluate(time => (window as ArrivalWindow).mltArrival.step(time, 'animation'), time);
            report.captures[key] = archive(output, key, frame); record.captures.push(key); save();
            assert.deepEqual(frame.arrivals, tiles.slice(0, delivered).sort());
            assert.equal(frame.sourcesLoaded.arrival, delivered === 4);
            assert.equal(frame.tilesLoaded, label === 'bootstrap' || delivered === 4); assert.equal(frame.moving, time < 2000);
            assert.equal(frame.frozen, true); assert.equal(frame.clockTime, 1000000 + time);
            assert.deepEqual(frame.snapshot.vectorSourcesPreserved, [true, true]);
            assert.deepEqual(frame.snapshot.selectedState, {selected: true}); assert.deepEqual(frame.snapshot.symbolSelectedState, {selected: true});
            assert.equal(frame.snapshot.terrain, null); assert.equal(frame.snapshot.globeness, 0);
        }
        console.log(name);
        await capture(0, 'bootstrap', 0);
        await until(() => page.evaluate(() => (window as ArrivalWindow).mltScenario.getMap().getSource('arrival').loaded()), 'source metadata initialized');
        await capture(0, 'frame-0', 0);
        await until(() => isDeepStrictEqual(server.waiting(), arrivalTiles), 'four held HTTP responses');
        for (let step = 1; step <= 8; step++) {
            const delivered = Math.floor(step / 2); const time = step * 250;
            if (step % 2 === 0) {
                await page.evaluate(time => (window as ArrivalWindow).mltArrival.advance(time), time);
                server.time(time); server.release(tiles[delivered - 1]);
                await until(async () => isDeepStrictEqual(await page.evaluate(() => (window as ArrivalWindow).mltArrival.delivered()), tiles.slice(0, delivered).sort()), 'released tile parsed');
            }
            await capture(time, `frame-${step}`, delivered);
        }
        record.terminal = await page.evaluate(() => (window as ArrivalWindow).mltArrival.state());
        for (let step = 1; record.terminal.pending && step <= 10; step++) {
            await capture(2000, `settle-${step}`, 4);
            record.terminal = await page.evaluate(() => (window as ArrivalWindow).mltArrival.state());
        }
        assert.equal(record.terminal.pending, 0); assert.equal(record.terminal.idle, true); assert.equal(record.terminal.moving, false);
        assert.equal(record.terminal.renders, record.captures.length); assert.equal(record.terminal.tilesLoaded, true);
        assert.deepEqual(server.waiting(), []); record.deliveries = server.trace();
        assert.equal(record.deliveries.length, 12); assert.ok(!record.deliveries.some(event => event.type === 'aborted'));
        record.finalStats = await workerStats(page, report.strict, encoding); assert.deepEqual(errors, []);
        record.disposal = await page.evaluate(() => (window as ArrivalWindow).mltArrival.dispose());
        assert.deepEqual(record.disposal, {pendingAfterRemove: 0, canvases: 0, clockRestored: true, schedulerRestored: true}); save();
    } finally { await page.close(); }
}

function compare(output: string, report: Report, actual: string, reference: string, kind: Comparison['kind']): void {
    const a = report.captures[actual]; const b = report.captures[reference]; assert.ok(a && b);
    const delta = difference(`${output}/${actual}.png`, `${output}/${reference}.png`);
    const stateEqual = isDeepStrictEqual(a, b);
    report.comparisons.push({actual, reference, kind, ...delta, stateEqual});
    if (kind === 'delivery-control') {
        assert.ok(delta.pixels > 0); assert.equal(stateEqual, false);
        assert.deepEqual(a.snapshot.camera, b.snapshot.camera); assert.equal(a.time, b.time);
        assert.notDeepEqual(a.arrivals, b.arrivals); return;
    }
    assert.equal(delta.pixels, 0, actual); assert.equal(stateEqual, true, actual);
}

/** Source arrivals within a held interval can arrive in any order, but none may cross a logical frame boundary. */
function compareTrace(a: Session, b: Session): void {
    assert.equal(a.captures.length, b.captures.length);
    assert.deepEqual(a.terminal.events.map(event => JSON.stringify(event)).sort(), b.terminal.events.map(event => JSON.stringify(event)).sort());
    assert.deepEqual(a.terminal.barriers, b.terminal.barriers);
    assert.deepEqual(a.deliveries.map(event => JSON.stringify(event)).sort(), b.deliveries.map(event => JSON.stringify(event)).sort());
}

async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {boolean: ['strict'], default: {runs: 2}});
    const runs = Number(args.runs); assert.ok(args.output && Number.isSafeInteger(runs) && runs > 0);
    const output = resolve(String(args.output)); mkdirSync(output, {recursive: false});
    const server = await arrivalServer(output, args.strict);
    const report: Report = {status: 'running', startedAt: new Date().toISOString(), strict: args.strict, gpuMode: process.env.PUPPETEER_GPU ?? 'software', runs,
        git: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), tileSpecGit: execFileSync('git', ['-C', '../maplibre-tile-spec', 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        productDiff: execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}), manifest: server.manifest, requests: server.requests,
        harnessHashes: Object.fromEntries(['test/bench/e2e/mlt-arrival.ts', 'test/bench/e2e/mlt-arrival-page.ts', 'test/bench/e2e/mlt-arrival-server.ts', 'test/bench/e2e/mlt-lifecycle-page.ts', 'test/bench/e2e/mlt-geography.ts']
            .map(path => [path, sha256(readFileSync(path))])), browser: '', sessions: {}, captures: {}, comparisons: []};
    function save(): void { writeFileSync(`${output}/results.json`, `${JSON.stringify(report, null, 2)}\n`); }
    const browser = await launchPuppeteer();
    try {
        report.browser = await browser.version();
        for (let run = 1; run <= runs; run++) for (const order of ['forward', 'reverse']) for (const encoding of (run % 2 ? ['mvt', 'mlt'] : ['mlt', 'mvt']) as Encoding[]) {
            await session(browser, server, output, report, encoding, run, order, save);
        }
        for (const [name, record] of Object.entries(report.sessions)) {
            if (record.encoding === 'mvt') compareTrace(record, report.sessions[name.replace(/-mvt$/, '-mlt')]);
            if (record.run > 1) compareTrace(record, report.sessions[name.replace(/^\d+-/, '1-')]);
            if (record.encoding === 'mvt') for (const key of record.captures) compare(output, report, key, key.replace('-mvt-', '-mlt-'), 'encoding');
            if (record.run > 1) for (const key of record.captures) compare(output, report, key, key.replace(/^\d+-/, '1-'), 'repeat');
            if (record.order !== 'reverse') continue;
            const forward = report.sessions[name.replace('-reverse-', '-forward-')];
            compare(output, report, record.captures.at(-1), forward.captures.at(-1), 'final');
            compare(output, report, `${name}-frame-2`, `${name.replace('-reverse-', '-forward-')}-frame-2`, 'delivery-control');
        }
        report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
    finally { save(); await browser.close(); await server.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
