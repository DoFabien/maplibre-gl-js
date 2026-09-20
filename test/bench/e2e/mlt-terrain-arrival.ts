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
import {installTerrainArrivalClock, type TerrainArrivalWindow, type TerrainArrivalState, type TerrainArrivalFrame} from './mlt-terrain-arrival-page.ts';
import {terrainArrivalServer, terrainTiles, type TerrainScene, type TerrainDelivery} from './mlt-terrain-arrival-server.ts';
import type {ArrivalDisposal} from './mlt-arrival-page.ts';
import {sha256, signature, difference, workerStats} from './mlt-geography.ts';

type Encoding = 'mvt' | 'mlt';
type Summary = Omit<TerrainArrivalFrame, 'pixels' | 'snapshot'> & {snapshot: Omit<TerrainArrivalFrame['snapshot'], 'queries'> & {
    hashes: Record<string, string>; counts: Record<string, number>;
}};
type Session = {run: number; scene: TerrainScene; order: string; encoding: Encoding; info: Awaited<ReturnType<typeof installScenario>>;
    captures: string[]; prepared?: TerrainArrivalState; terminal?: TerrainArrivalState; initialStats: Awaited<ReturnType<typeof workerStats>>;
    finalStats?: Awaited<ReturnType<typeof workerStats>>; disposal?: ArrivalDisposal; deliveries?: TerrainDelivery[]; errors: string[]};
type Comparison = {actual: string; reference: string; kind: 'encoding' | 'repeat' | 'delivery-control' | 'dem-control' | 'order-outcome';
    pixels: number; maxDelta: number; stateEqual: boolean};
type TransportOutcome = {actual: string; reference: string; exact: boolean; requested: number[]; aborted: number[]};
type Report = {status: string; startedAt: string; strict: boolean; gpuMode: string; runs: number; scenes: TerrainScene[];
    git: string; tileSpecGit: string; productDiff: string; manifest: Awaited<ReturnType<typeof terrainArrivalServer>>['manifest'];
    requests: Record<string, number>; harnessHashes: Record<string, string>; browser: string; sessions: Record<string, Session>;
    captures: Record<string, Summary>; comparisons: Comparison[]; transportOutcomes: TransportOutcome[]; error?: string};

/** All delivered responses must match; requests cancelled while their gate is closed can disappear before reaching HTTP. */
function compareTransport(report: Report, actual: string, reference: string): void {
    const a = report.sessions[actual].deliveries; const b = report.sessions[reference].deliveries;
    function normalize(values: TerrainDelivery[], deliveredOnly = false): string[] {
        return values.filter(event => !deliveredOnly || ['released', 'completed'].includes(event.type))
            .map(({request: _, ...event}) => JSON.stringify(event)).sort();
    }
    assert.deepEqual(normalize(a, true), normalize(b, true));
    for (const trace of [a, b]) for (const event of trace.filter(event => event.type === 'aborted')) {
        assert.ok(event.time < trace.find(gate => gate.type === 'released' && gate.tile === event.tile).time);
    }
    report.transportOutcomes.push({actual, reference, exact: isDeepStrictEqual(normalize(a), normalize(b)),
        requested: [a, b].map(trace => trace.filter(event => event.type === 'requested').length),
        aborted: [a, b].map(trace => trace.filter(event => event.type === 'aborted').length)});
}

/** Saves full public query results and framebuffer bytes at every scheduled draw, including preparation and loading. */
function archive(output: string, name: string, frame: TerrainArrivalFrame): Summary {
    const png = new PNG({width: 800, height: 600}); const pixels = Buffer.from(frame.pixels);
    assert.equal(pixels.length, 800 * 600 * 4);
    for (let row = 0; row < 600; row++) pixels.copy(png.data, (599 - row) * 3200, row * 3200, (row + 1) * 3200);
    writeFileSync(`${output}/${name}.png`, PNG.sync.write(png));
    const {pixels: _, snapshot: {queries, ...snapshot}, ...state} = frame;
    writeFileSync(`${output}/${name}.json.gz`, gzipSync(JSON.stringify(queries)));
    const collections = {...queries.source, rendered: queries.rendered};
    return {...state, snapshot: {...snapshot,
        hashes: Object.fromEntries(Object.entries(collections).map(([key, values]) => [key, signature(values)])),
        counts: Object.fromEntries(Object.entries(collections).map(([key, values]) => [key, values.length]))}};
}

async function until(condition: () => boolean | Promise<boolean>, diagnostic: () => unknown): Promise<void> {
    const start = performance.now();
    while (!await condition()) {
        if (performance.now() - start > 20000) throw new Error(`Timed out: ${JSON.stringify(diagnostic())}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function session(browser: Browser, server: Awaited<ReturnType<typeof terrainArrivalServer>>, output: string, report: Report,
    scene: TerrainScene, encoding: Encoding, run: number, order: string, save: () => void): Promise<void> {
    const name = `${run}-${scene}-${order}-${encoding}`; const page = await browser.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
    page.on('request', request => { if (![server.origin, server.vectorOrigin, server.demOrigin].some(origin => request.url().startsWith(`${origin}/`)) && !request.url().startsWith('blob:')) errors.push(`Non-local: ${request.url()}`); });
    let record: Session;
    try {
        await page.bringToFront(); await page.setViewport({width: 800, height: 600, deviceScaleFactor: 1}); await page.setCacheEnabled(false);
        await page.goto(server.origin); await page.addStyleTag({content: '#map {width:800px;height:600px}'});
        await page.addStyleTag({url: `${server.origin}/dist/maplibre-gl.css`});
        const info = await page.evaluate(installScenario, {encoding, origin: server.origin, scenario: 'geography' as const});
        assert.deepEqual(info.canvas, {width: 800, height: 600}); assert.equal(info.pixelRatio, 1);
        if (report.gpuMode === 'hardware') assert.doesNotMatch(info.renderer, /swiftshader|llvmpipe|software/i);
        else assert.match(info.renderer, /swiftshader/i);
        await page.evaluate(async () => { const scenario = (window as ScenarioWindow).mltScenario; await scenario.select(true); await scenario.selectSymbol(true); });
        record = report.sessions[name] = {run, scene, order, encoding, info, captures: [], initialStats: await workerStats(page, report.strict, encoding), errors};
        await page.evaluate(installTerrainArrivalClock, {origin: server.origin, vectorOrigin: server.vectorOrigin, demOrigin: server.demOrigin, scene});
        console.log(name);
        async function capture(time: number, label: string, delivered: string[]): Promise<void> {
            server.time(time); const key = `${name}-${label}`;
            const frame = await page.evaluate(({time, label}) => (window as TerrainArrivalWindow).mltTerrainArrival.step(time, label.startsWith('prepare') ? 'preparation' : 'animation'), {time, label});
            report.captures[key] = archive(output, key, frame); record.captures.push(key); save();
            assert.deepEqual(frame.gates, [...delivered].sort()); assert.ok(frame.arrivals.every(tile => frame.gates.includes(tile)));
            assert.equal(frame.frozen, true); assert.equal(frame.clockTime, 1000000 + time);
            assert.equal(frame.snapshot.globeness, scene === 'globe-flight' ? 1 : 0);
            assert.deepEqual(frame.snapshot.vectorSourcesPreserved, [true, true]);
            assert.deepEqual(frame.snapshot.selectedState, {selected: true}); assert.deepEqual(frame.snapshot.symbolSelectedState, {selected: true});
            await until(() => server.active() === 0, () => ({active: server.active(), errors}));
        }
        server.start(scene);
        await page.evaluate(() => (window as TerrainArrivalWindow).mltTerrainArrival.prepare());
        for (let step = 1; step <= 20; step++) {
            await capture(0, `prepare-${step}`, []);
            record.prepared = await page.evaluate(() => (window as TerrainArrivalWindow).mltTerrainArrival.state());
            if (!record.prepared.pending) break;
        }
        assert.equal(record.prepared.pending, 0); assert.equal(record.prepared.idle, true);
        assert.equal(server.waiting().length, 0);
        await page.evaluate(encoding => (window as TerrainArrivalWindow).mltTerrainArrival.begin(encoding), encoding);
        await capture(0, 'bootstrap', []);
        await capture(0, 'frame-0', []);
        const tiles = terrainTiles(scene); const schedule = order === 'dem-first' ? [...tiles].reverse() : tiles;
        await until(() => isDeepStrictEqual(server.waiting(), [...tiles].sort()), () => ({expected: tiles, waiting: server.waiting(), errors}));
        const delivered: string[] = [];
        for (let step = 1; step <= 8; step++) {
            const time = step * 250; const release = scene === 'local-orbit' || step === 2 || step === (order === 'dem-late' ? 8 : 6);
            if (release) {
                await page.evaluate(time => (window as TerrainArrivalWindow).mltTerrainArrival.advance(time), time);
                server.time(time); const tile = schedule[delivered.length];
                await page.evaluate(tile => (window as TerrainArrivalWindow).mltTerrainArrival.allow(tile), tile);
                server.release(tile); delivered.push(tile);
                await until(async () => !(await page.evaluate(() => (window as TerrainArrivalWindow).mltTerrainArrival.state())).inflight.some(item => delivered.includes(item.resource)) && server.active() === 0,
                    () => ({released: delivered, trace: server.trace(), errors}));
            }
            await capture(time, `frame-${step}`, delivered);
        }
        record.terminal = await page.evaluate(() => (window as TerrainArrivalWindow).mltTerrainArrival.state());
        for (let step = 1; record.terminal.pending && step <= 20; step++) {
            await capture(2000, `settle-${step}`, delivered);
            record.terminal = await page.evaluate(() => (window as TerrainArrivalWindow).mltTerrainArrival.state());
        }
        assert.equal(record.terminal.pending, 0); assert.equal(record.terminal.idle, true); assert.equal(record.terminal.tilesLoaded, true);
        const last = report.captures[record.captures.at(-1)]; assert.equal(last.loaded, true); assert.equal(last.moving, false);
        assert.ok(last.snapshot.elevations.every(value => Number.isFinite(value) && value > 0));
        assert.ok(Math.max(...last.snapshot.elevations) - Math.min(...last.snapshot.elevations) > 10);
        assert.ok(last.snapshot.counts.arrival > 0);
        record.finalStats = await workerStats(page, report.strict, encoding);
        record.deliveries = server.trace(); assert.equal(record.deliveries.filter(event => event.type === 'released').length, tiles.length); assert.deepEqual(errors, []);
    } finally {
        if (record) {
            record.deliveries = server.trace();
            record.terminal = await page.evaluate(() => (window as TerrainArrivalWindow).mltTerrainArrival?.state());
            record.disposal = await page.evaluate(() => (window as TerrainArrivalWindow).mltTerrainArrival?.dispose()); save();
        }
        await page.close();
    }
}

/** Different terrain histories are diagnostic outcomes, not assumed to converge to identical final texture caches. */
function compare(output: string, report: Report, actual: string, reference: string, kind: Comparison['kind']): void {
    const a = report.captures[actual]; const b = report.captures[reference]; assert.ok(a && b);
    const delta = difference(`${output}/${actual}.png`, `${output}/${reference}.png`); const stateEqual = isDeepStrictEqual(a, b);
    report.comparisons.push({actual, reference, kind, ...delta, stateEqual});
    if (kind === 'order-outcome') return;
    if (kind === 'dem-control') {
        assert.ok(delta.pixels > 0); assert.equal(a.time, b.time); assert.deepEqual(a.snapshot.camera, b.snapshot.camera);
        assert.deepEqual(a.arrivals.filter(tile => tile.startsWith('vector:')), b.arrivals.filter(tile => tile.startsWith('vector:')));
        assert.equal(a.sourcesLoaded['dem-world'], false); assert.equal(b.sourcesLoaded['dem-world'], true); return;
    }
    if (kind === 'delivery-control') { assert.ok(delta.pixels > 0); assert.notDeepEqual(a.arrivals, b.arrivals); assert.equal(a.time, b.time); return; }
    assert.equal(delta.pixels, 0, actual); assert.equal(stateEqual, true, actual);
}

async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {boolean: ['strict'], default: {runs: 2}});
    const runs = Number(args.runs); assert.ok(args.output && Number.isSafeInteger(runs) && runs > 0);
    const scenes: TerrainScene[] = args.only ? String(args.only).split(',') as TerrainScene[] : ['local-orbit', 'globe-flight'];
    assert.ok(scenes.every(scene => ['local-orbit', 'globe-flight'].includes(scene)));
    const output = resolve(String(args.output)); mkdirSync(output, {recursive: false});
    const server = await terrainArrivalServer(output, args.strict);
    const report: Report = {status: 'running', startedAt: new Date().toISOString(), strict: args.strict, gpuMode: process.env.PUPPETEER_GPU ?? 'software', runs, scenes,
        git: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), tileSpecGit: execFileSync('git', ['-C', '../maplibre-tile-spec', 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        productDiff: execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}), manifest: server.manifest, requests: server.requests,
        harnessHashes: Object.fromEntries(['test/bench/e2e/mlt-terrain-arrival.ts', 'test/bench/e2e/mlt-terrain-arrival-page.ts', 'test/bench/e2e/mlt-terrain-arrival-server.ts',
            'test/bench/e2e/mlt-lifecycle-page.ts', 'test/bench/e2e/mlt-geography.ts'].map(path => [path, sha256(readFileSync(path))])),
        browser: '', sessions: {}, captures: {}, comparisons: [], transportOutcomes: []};
    function save(): void { writeFileSync(`${output}/results.json`, `${JSON.stringify(report, null, 2)}\n`); }
    const browser = await launchPuppeteer();
    try {
        report.browser = await browser.version();
        for (let run = 1; run <= runs; run++) for (const scene of scenes) for (const order of scene === 'globe-flight' ? ['vector-first', 'dem-first', 'dem-late'] : ['vector-first', 'dem-first']) for (const encoding of (run % 2 ? ['mvt', 'mlt'] : ['mlt', 'mvt']) as Encoding[]) {
            await session(browser, server, output, report, scene, encoding, run, order, save);
        }
        for (const [name, record] of Object.entries(report.sessions)) {
            for (const reference of [record.encoding === 'mvt' ? name.replace(/-mvt$/, '-mlt') : null, record.run > 1 ? name.replace(/^\d+-/, '1-') : null].filter(Boolean)) {
                const other = report.sessions[reference]; assert.equal(record.captures.length, other.captures.length);
                assert.deepEqual(record.terminal.events.map(event => JSON.stringify(event)).sort(), other.terminal.events.map(event => JSON.stringify(event)).sort());
                assert.deepEqual(record.terminal.barriers, other.terminal.barriers);
                compareTransport(report, name, reference);
                for (const key of record.captures) compare(output, report, key, key.replace(`${name}-`, `${reference}-`), reference.startsWith(`${record.run}-`) ? 'encoding' : 'repeat');
            }
            if (record.order === 'dem-late') {
                compare(output, report, `${name}-frame-6`, `${name.replace('-dem-late-', '-vector-first-')}-frame-6`, 'dem-control');
            }
            if (record.order !== 'dem-first') continue;
            const other = report.sessions[name.replace('-dem-first-', '-vector-first-')];
            compare(output, report, `${name}-frame-${record.scene === 'globe-flight' ? 2 : 1}`, `${name.replace('-dem-first-', '-vector-first-')}-frame-${record.scene === 'globe-flight' ? 2 : 1}`, 'delivery-control');
            compare(output, report, record.captures.at(-1), other.captures.at(-1), 'order-outcome');
        }
        report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
    finally { save(); await browser.close(); await server.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
