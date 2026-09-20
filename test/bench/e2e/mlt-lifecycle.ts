import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpus, platform, release} from 'node:os';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import type {AddressInfo} from 'node:net';
import minimist from 'minimist';
import {PNG} from 'pngjs';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import type {Browser, CDPSession, Page, WebWorker} from 'puppeteer';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {summarizeNumbers} from '../lib/mlt_benchmark_statistics.ts';
import {installScenario, type ScenarioWindow, type CycleResult, type Checkpoint, type QuerySample, type StyleMutation} from './mlt-lifecycle-page.ts';
import type {MltMaterializationStats} from '../../../src/util/mlt_materialization_stats.ts';

type Encoding = 'mvt' | 'mlt';
type Heap = {usedSize: number; totalSize: number; embedderHeapUsedSize?: number; backingStorageSize?: number};
type MemorySample = {phase: string; cycle: number; main: Heap; workers: Heap[]};
type Session = {page: Page; client: CDPSession; workers: Set<WebWorker>; errors: string[]; assets: Record<string, number>};

const args = minimist(process.argv.slice(2), {
    boolean: ['measure-with-differences', 'strict'],
    default: {runs: 3, cycles: 30, 'memory-cycles': 100, 'style-cycles': 3, phase: 'all', scenario: 'base'}
});

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Serves only fixed local files, without caching or compression; tile counters are HTTP payload, not worker transfer. */
async function localServer(referenceDist?: string, strict = false, symbols = false): Promise<{
    origin: string;
    close(): Promise<void>;
    manifest: Record<string, {bytes: number; sha256: string}>;
    traffic: Record<Encoding, {requests: number; payloadBytes: number}>;
}> {
    const files = new Map<string, {bytes: Buffer; mime: string}>();
    const manifest: Record<string, {bytes: number; sha256: string}> = {};
    function add(url: string, path: string, mime: string): void {
        const bytes = readFileSync(path);
        files.set(url, {bytes, mime});
        manifest[path] = {bytes: bytes.length, sha256: sha256(bytes)};
    }
    for (const name of ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl.css']) {
        add(`/dist/${name}`, `${strict ? 'dist/mlt-validation' : 'dist'}/${name}`, name.endsWith('.css') ? 'text/css' : 'text/javascript');
        if (referenceDist) add(`/reference/${name}`, `${referenceDist}/${name}`, name.endsWith('.css') ? 'text/css' : 'text/javascript');
    }
    add('/', 'test/bench/e2e/index.html', 'text/html');
    if (symbols) {
        for (const range of ['0-255', '256-511', '8192-8447']) {
            const path = `glyphs/Open Sans Semibold,Arial Unicode MS Bold/${range}.pbf`;
            add(`/${path}`, `test/integration/assets/${path}`, 'application/octet-stream');
            if (args.scenario === 'styles') add(`/${path.replace('glyphs/', 'glyphs-alt/')}`, `test/integration/assets/${path}`, 'application/octet-stream');
        }
        for (const extension of ['json', 'png']) {
            add(`/sprites/sprite.${extension}`, `test/integration/assets/sprites/sprite.${extension}`,
                extension === 'json' ? 'application/json' : 'image/png');
            if (args.scenario === 'styles') add(`/sprites-alt/sprite.${extension}`, `test/integration/assets/sprites/sprite.${extension}`,
                extension === 'json' ? 'application/json' : 'image/png');
        }
    }
    for (const x of [8802, 8803]) {
        for (const y of [5374, 5375]) {
            for (const encoding of ['mvt', 'mlt'] as const) {
                const name = `14-${x}-${y}.${encoding}`;
                const path = `test/integration/assets/tiles/${encoding === 'mlt' ? 'mlt/gl-js/' : ''}${name}`;
                add(`/tiles/${encoding}/${name}`, path, 'application/octet-stream');
            }
        }
    }
    const traffic = {mvt: {requests: 0, payloadBytes: 0}, mlt: {requests: 0, payloadBytes: 0}};
    const server = createServer((req, res) => {
        const pathname = decodeURI(new URL(req.url, 'http://localhost').pathname);
        const file = files.get(pathname);
        if (!file) {
            res.writeHead(pathname === '/favicon.ico' ? 204 : 404);
            res.end();
            return;
        }
        const encoding = pathname.split('/')[2] as Encoding;
        if (pathname.startsWith('/tiles/')) {
            traffic[encoding].requests++;
            traffic[encoding].payloadBytes += file.bytes.length;
        }
        res.writeHead(200, {
            'Content-Type': file.mime, 'Content-Length': file.bytes.length, 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'"
        });
        res.end(file.bytes);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, manifest, traffic,
        close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    };
}

async function newSession(browser: Browser, origin: string, bundle = 'dist'): Promise<Session> {
    const page = await browser.newPage();
    const workers = new Set<WebWorker>();
    const errors: string[] = [];
    const assets: Record<string, number> = {};
    page.on('workercreated', worker => workers.add(worker));
    page.on('workerdestroyed', worker => workers.delete(worker));
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => {
        const url = request.url();
        if (url.startsWith(`${origin}/`) || url.startsWith('blob:') || url.startsWith('data:')) return;
        errors.push(`Non-local request: ${url}`);
    });
    page.on('response', response => {
        if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
        const pathname = decodeURI(new URL(response.url()).pathname);
        if (/^\/(glyphs|sprites)(-alt)?\//.test(pathname)) {
            assets[pathname] = (assets[pathname] ?? 0) + 1;
        }
    });
    await page.setViewport({width: 800, height: 600, deviceScaleFactor: 1});
    await page.setCacheEnabled(false);
    await page.goto(origin, {waitUntil: 'load'});
    await page.addStyleTag({content: '#map {width: 800px; height: 600px}'});
    await page.addStyleTag({url: `${origin}/${bundle}/maplibre-gl.css`});
    const client = await page.createCDPSession();
    return {page, client, workers, errors, assets};
}

/** Explicit collection is diagnostic-only. Main isolate and live worker heaps remain separate. */
async function memory(session: Session, phase: string, cycle: number): Promise<MemorySample> {
    const clients = [session.client, ...Array.from(session.workers, worker => worker.client)];
    for (const client of clients) await client.send('HeapProfiler.collectGarbage');
    await session.page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    const heaps: Heap[] = [];
    for (const client of clients) {
        await client.send('HeapProfiler.collectGarbage');
        heaps.push(await client.send('Runtime.getHeapUsage'));
    }
    return {phase, cycle, main: heaps[0], workers: heaps.slice(1)};
}

async function start(session: Session, encoding: Encoding, origin: string, bundle = 'dist'): Promise<Awaited<ReturnType<typeof installScenario>>> {
    const info = await session.page.evaluate(installScenario, {encoding, origin, bundle, scenario: args.scenario});
    if (process.env.PUPPETEER_GPU === 'hardware') assert.doesNotMatch(info.renderer, /swiftshader|llvmpipe|software/i);
    assert.equal(session.workers.size, 1, 'Exactly one worker must be exercised');
    assert.equal(info.pixelRatio, 1);
    assert.deepEqual(info.canvas, {width: 800, height: 600});
    return info;
}

function cycle(page: Page, animated: boolean): Promise<CycleResult> {
    return page.evaluate(animated => (window as ScenarioWindow).mltScenario.cycle(animated), animated);
}

/** Reads the dedicated strict worker only; public main-thread query results deliberately materialize GeoJSON. */
async function workerStats(session: Session, encoding: Encoding): Promise<{counters: MltMaterializationStats['counters']; forbidden: string[]}[]> {
    if (!args.strict) return [];
    assert.equal(session.workers.size, 1);
    const snapshots = [];
    for (const worker of session.workers) {
        const snapshot = await worker.evaluate(() => {
            const stats = (globalThis as typeof globalThis & {__mltRenderStats?: MltMaterializationStats}).__mltRenderStats;
            if (!stats?.strict) throw new Error('Strict MLT instrumentation is missing');
            return {counters: {...stats.counters}, forbidden: [...stats.forbiddenCounters]};
        });
        for (const counter of snapshot.forbidden) assert.equal(snapshot.counters[counter], 0, `Forbidden worker materialization: ${counter}`);
        if (encoding === 'mlt') {
            assert.ok(snapshot.counters.decodedLayers > 0, 'MLT decode must be exercised');
            assert.ok(snapshot.counters.overzoomFeaturesClipped > 0, 'MLT overzoom must be exercised');
            assert.equal(snapshot.counters.propertyProxyMisses, 0);
        }
        snapshots.push(snapshot);
    }
    return snapshots;
}

async function destroy(session: Session): Promise<void> {
    await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.destroy());
    await session.page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 100)));
    assert.equal(await session.page.evaluate(() => document.querySelectorAll('canvas').length), 0);
    assert.deepEqual(session.errors, []);
}

/** Checks state-preserving updates separately from full/source replacement, then repeats the lifecycle without screenshots. */
async function styleCorrectness(session: Session, encoding: Encoding, checkpoints: Record<string, Checkpoint>,
    capture: (name: string) => Promise<void>): Promise<unknown[]> {
    const evidence = [];
    async function selectBoth(): Promise<void> {
        await session.page.evaluate(async () => {
            await (window as ScenarioWindow).mltScenario.select(true);
            await (window as ScenarioWindow).mltScenario.selectSymbol(true);
        });
    }
    async function mutate(name: string, operation: StyleMutation, expected?: string, archive = true): Promise<void> {
        const mutation = await session.page.evaluate(operation => (window as ScenarioWindow).mltScenario.mutateStyle(operation), operation);
        if (archive) await capture(name);
        const checkpoint = archive ? checkpoints[name] : await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.checkpoint());
        if (expected) assert.deepEqual(checkpoint, checkpoints[expected], name);
        evidence.push({name, mutation, checkpoint, assets: {...session.assets}, workerStats: await workerStats(session, encoding)});
    }
    await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.visit(2));
    assert.deepEqual(await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.checkpoint()), checkpoints.initial);
    await selectBoth();
    await capture('style-selected');
    await mutate('style-direct', 'direct');
    assert.notEqual(checkpoints['style-direct'].renderedHash, checkpoints['style-selected'].renderedHash);
    assert.ok(checkpoints['style-direct'].renderedLayerCounts['poi-labels'] < checkpoints['style-selected'].renderedLayerCounts['poi-labels']);
    await mutate('style-direct-restored', 'direct-restore', 'style-selected');
    await mutate('style-diff', 'diff', 'style-direct');
    await mutate('style-diff-restored', 'restore', 'style-selected');
    const previousAssets = {...session.assets};
    await mutate('style-assets', 'assets', 'style-selected');
    for (const path of ['/sprites-alt/sprite.json', '/sprites-alt/sprite.png',
        ...['0-255', '256-511', '8192-8447'].map(range => `/glyphs-alt/Open Sans Semibold,Arial Unicode MS Bold/${range}.pbf`)]) {
        assert.ok(session.assets[path] > (previousAssets[path] ?? 0), `Changed style resource not requested: ${path}`);
    }
    await mutate('style-rebuilt', 'rebuild', 'initial');
    await selectBoth();
    await capture('style-reselected');
    assert.deepEqual(checkpoints['style-reselected'], checkpoints['style-selected']);
    await mutate('style-encoding-swapped', 'encoding', 'initial');
    await mutate('style-encoding-restored', 'restore', 'initial');
    await selectBoth();
    await mutate('style-empty', 'empty');
    assert.equal(checkpoints['style-empty'].sourceCount, 0);
    assert.equal(checkpoints['style-empty'].renderedCount, 0);
    await mutate('style-readded', 'restore', 'initial');
    await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.visit(0));
    await mutate('style-overzoom', 'diff');
    await mutate('style-overzoom-restored', 'restore', 'overzoom-1');
    await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.visit(2));
    await capture('style-final');
    assert.deepEqual(checkpoints['style-final'], checkpoints.initial);
    for (let index = 0; index < Number(args['style-cycles']); index++) {
        await selectBoth();
        for (const [operation, expected] of [['diff', 'style-direct'], ['restore', 'style-selected'], ['rebuild', 'initial'],
            ['encoding', 'initial'], ['restore', 'initial']] as const) {
            await mutate(`repeat-${index + 1}-${operation}-${expected}`, operation, expected, false);
        }
    }
    return evidence;
}

/** Screenshots and cryptographic query signatures run in their own session, never in timed samples. */
async function correctness(browser: Browser, origin: string, encoding: Encoding, output: string, bundle = 'dist', label: string = encoding): Promise<{
    info: Awaited<ReturnType<typeof installScenario>>;
    checkpoints: Record<string, Checkpoint>;
    assets: Record<string, number>;
    workerStats: Awaited<ReturnType<typeof workerStats>>;
    styleMutations: unknown[];
}> {
    const session = await newSession(browser, origin, bundle);
    const checkpoints: Record<string, Checkpoint> = {};
    try {
        const info = await start(session, encoding, origin, bundle);
        async function capture(name: string): Promise<void> {
            checkpoints[name] = await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.checkpoint());
            const queries = await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.queryJSON());
            writeFileSync(`${output}/${label}-${name}.json.gz`, gzipSync(JSON.stringify(queries)));
            await session.page.screenshot({path: `${output}/${label}-${name}.png`});
        }
        await capture('initial');
        if (args.scenario !== 'base') {
            await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.selectSymbol(true));
            await capture('symbol-selected');
            assert.equal(checkpoints['symbol-selected'].symbolSelectedState.selected, true);
            assert.deepEqual(checkpoints['symbol-selected'].selectedState, {});
            await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.reload());
            await capture('symbol-selected-reloaded');
            assert.deepEqual(checkpoints['symbol-selected-reloaded'], checkpoints['symbol-selected']);
            await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.selectSymbol(false));
            await capture('symbol-cleared');
            assert.deepEqual(checkpoints['symbol-cleared'], checkpoints.initial);
        }
        await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.select(true));
        await capture('selected');
        assert.equal(checkpoints.selected.selectedState.selected, true);
        assert.notEqual(checkpoints.initial.renderedHash, checkpoints.selected.renderedHash);
        await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.reload());
        await capture('selected-reloaded');
        assert.deepEqual(checkpoints['selected-reloaded'], checkpoints.selected);
        await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.select(false));
        await capture('cleared');
        assert.deepEqual(checkpoints.cleared, checkpoints.initial);
        await cycle(session.page, false);
        await capture('reloaded');
        assert.deepEqual(checkpoints.reloaded, checkpoints.initial);
        for (let index = 0; index < 2; index++) {
            await session.page.evaluate(index => (window as ScenarioWindow).mltScenario.visit(index), index);
            await capture(`overzoom-${index + 1}`);
        }
        const styleMutations = args.scenario === 'styles' ? await styleCorrectness(session, encoding, checkpoints, capture) : [];
        const stats = await workerStats(session, encoding);
        if (args.scenario !== 'base') {
            assert.ok(Object.keys(session.assets).some(path => path.startsWith('/glyphs/')), 'Remote PBF glyphs must be exercised');
            for (const extension of ['json', 'png']) assert.ok(session.assets[`/sprites/sprite.${extension}`], 'Sprite must be exercised');
        }
        await destroy(session);
        return {info, checkpoints, assets: session.assets, workerStats: stats, styleMutations};
    } finally {
        await session.page.close();
    }
}

function imageDifference(first: string, second: string): {differentPixels: number; totalPixels: number; maxChannelDelta: number} {
    const a = PNG.sync.read(readFileSync(first));
    const b = PNG.sync.read(readFileSync(second));
    assert.equal(a.width, b.width);
    assert.equal(a.height, b.height);
    let differentPixels = 0;
    let maxChannelDelta = 0;
    for (let i = 0; i < a.data.length; i += 4) {
        let changed = false;
        for (let channel = 0; channel < 4; channel++) {
            const delta = Math.abs(a.data[i + channel] - b.data[i + channel]);
            maxChannelDelta = Math.max(maxChannelDelta, delta);
            changed ||= delta > 0;
        }
        if (changed) differentPixels++;
    }
    return {differentPixels, totalPixels: a.width * a.height, maxChannelDelta};
}

async function timedRun(browser: Browser, origin: string, encoding: Encoding, cycles: number): Promise<unknown> {
    const session = await newSession(browser, origin);
    try {
        const info = await start(session, encoding, origin);
        const warmup = await cycle(session.page, true);
        const samples: CycleResult[] = [];
        for (let i = 0; i < cycles; i++) {
            const sample = await cycle(session.page, true);
            assert.equal(sample.sourceResults, warmup.sourceResults);
            assert.equal(sample.renderedResults, warmup.renderedResults);
            samples.push(sample);
        }
        await destroy(session);
        const intervals = samples.flatMap(sample => sample.frameIntervals);
        assert.ok(intervals.length > 0);
        return {
            info, samples,
            summary: {
                timings: Object.fromEntries(Object.keys(samples[0].timings).map(key => [key, summarizeNumbers(samples.map(sample => sample.timings[key]))])),
                frameIntervalMs: summarizeNumbers(intervals), frameSamples: intervals.length,
                intervalsOver33ms: intervals.filter(value => value > 33.34).length,
                intervalsOver50ms: intervals.filter(value => value > 50).length,
                longTaskCount: samples.reduce((sum, sample) => sum + sample.longTasks.length, 0),
                longTaskMs: samples.reduce((sum, sample) => sum + sample.longTasks.reduce((sum, value) => sum + value, 0), 0)
            }
        };
    } finally {
        await session.page.close();
    }
}

async function memoryRun(browser: Browser, origin: string, encoding: Encoding, cycles: number): Promise<unknown> {
    const session = await newSession(browser, origin);
    try {
        const samples = [await memory(session, 'empty-page', 0)];
        const info = await start(session, encoding, origin);
        for (let i = 0; i < 5; i++) await cycle(session.page, false);
        const expected = await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.checkpoint());
        samples.push(await memory(session, 'warm', 0));
        for (let i = 1; i <= cycles; i++) {
            await cycle(session.page, false);
            if (i % 10 === 0 || i === cycles) {
                assert.deepEqual(await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.checkpoint()), expected);
                samples.push(await memory(session, 'loaded', i));
            }
            if (i % 50 === 0) console.log(`memory ${encoding}: ${i}/${cycles}`);
        }
        await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.removeSource());
        samples.push(await memory(session, 'source-removed', cycles));
        await destroy(session);
        samples.push(await memory(session, 'map-removed', cycles));
        return {info, samples};
    } finally {
        await session.page.close();
    }
}

/** Samples the main-thread CPU separately from uninstrumented fixed-camera query timings; source maps resolve production frames. */
async function profileRun(browser: Browser, origin: string, encoding: Encoding, output: string, run: number): Promise<unknown> {
    const session = await newSession(browser, origin);
    try {
        const info = await start(session, encoding, origin);
        const poses = [];
        const maps = new Map<string, TraceMap>();
        for (const name of ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs']) {
            maps.set(`${origin}/dist/${name}`, new TraceMap(JSON.parse(readFileSync(`dist/${name}.map`, 'utf8'))));
        }
        for (const pose of [2, 0, 1]) {
            await session.page.evaluate(pose => (window as ScenarioWindow).mltScenario.visit(pose), pose);
            const warm = await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.queryBatch(10));
            const samples = await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.queryBatch(50));
            for (const sample of samples) {
                assert.equal(sample.count, warm[0].count);
                assert.equal(sample.characters, warm[0].characters);
            }
            await session.client.send('Profiler.enable');
            await session.client.send('Profiler.setSamplingInterval', {interval: 1000});
            await session.client.send('Profiler.start');
            await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.queryBatch(100));
            const {profile} = await session.client.send('Profiler.stop');
            await session.client.send('Profiler.disable');
            const filename = `${encoding}-run${run}-pose${pose}.cpuprofile.gz`;
            writeFileSync(`${output}/${filename}`, gzipSync(JSON.stringify(profile)));
            const frames = new Map(profile.nodes.map(node => {
                const frame = node.callFrame;
                const map = maps.get(frame.url);
                const source = map && frame.lineNumber >= 0
                    ? originalPositionFor(map, {line: frame.lineNumber + 1, column: frame.columnNumber}) : undefined;
                return [node.id, source?.source ? `${source.source}:${source.line} ${source.name ?? frame.functionName}` : frame.functionName || frame.url];
            }));
            const self = new Map<string, number>();
            for (let index = 0; index < profile.samples.length; index++) {
                const key = frames.get(profile.samples[index]);
                self.set(key, (self.get(key) ?? 0) + profile.timeDeltas[index]);
            }
            poses.push({pose, samples, summary: Object.fromEntries(['queryMs', 'materializeMs', 'stringifyMs'].map(key =>
                [key, summarizeNumbers(samples.map(sample => sample[key as keyof QuerySample]))])),
            profile: {filename, sampleCount: profile.samples.length, selfMicroseconds: Object.fromEntries([...self].sort((a, b) => b[1] - a[1]))}});
        }
        await destroy(session);
        return {info, poses};
    } finally {
        await session.page.close();
    }
}

/** Uninstrumented version comparison, isolated from CPU profiling and correctness serialization. */
async function fixedQueryRun(browser: Browser, origin: string, encoding: Encoding, bundle: string,
    expected: Record<string, Checkpoint>): Promise<unknown> {
    const session = await newSession(browser, origin, bundle);
    try {
        const info = await start(session, encoding, origin, bundle);
        const poses = [];
        for (const pose of [2, 0, 1]) {
            await session.page.evaluate(pose => (window as ScenarioWindow).mltScenario.visit(pose), pose);
            const checkpoint = await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.checkpoint());
            assert.deepEqual(checkpoint, expected[pose === 2 ? 'initial' : `overzoom-${pose + 1}`]);
            const warm = await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.queryBatch(10));
            const samples = await session.page.evaluate(() => (window as ScenarioWindow).mltScenario.queryBatch(50));
            for (const sample of samples) {
                assert.equal(sample.count, checkpoint.renderedCount);
                assert.equal(sample.characters, warm[0].characters);
            }
            poses.push({pose, samples, summary: Object.fromEntries(['queryMs', 'materializeMs', 'stringifyMs', 'totalMs'].map(key =>
                [key, summarizeNumbers(samples.map(sample => key === 'totalMs'
                    ? sample.queryMs + sample.materializeMs + sample.stringifyMs : sample[key as keyof QuerySample]))]))});
        }
        await destroy(session);
        return {info, poses};
    } finally {
        await session.page.close();
    }
}

/** Fails on correctness/network/worker-lifecycle errors; performance is descriptive, without invented budgets. */
async function main(): Promise<void> {
    const phase = String(args.phase);
    assert.ok(['all', 'correctness', 'timing', 'profile', 'compare'].includes(phase), 'Unknown --phase');
    assert.ok(['base', 'symbols', 'styles'].includes(args.scenario), 'Unknown --scenario');
    const styleCycles = Number(args['style-cycles']);
    assert.ok(Number.isSafeInteger(styleCycles) && styleCycles > 0);
    if (args.scenario === 'styles') assert.equal(phase, 'correctness', 'Style lifecycle qualification is correctness-only');
    if (args.strict) {
        assert.equal(phase, 'correctness', 'Strict instrumentation is correctness-only, never a performance measurement');
        assert.equal(Boolean(args['measure-with-differences']), false, 'Strict qualification requires exact parity');
    }
    assert.equal(Boolean(args['reference-dist']), phase === 'compare', '--reference-dist is required only for --phase compare');
    const referenceDist = args['reference-dist'] ? resolve(String(args['reference-dist'])) : undefined;
    const referenceSnapshot = referenceDist ? JSON.parse(readFileSync(`${referenceDist}/snapshot.json`, 'utf8')) : undefined;
    for (const [name, file] of Object.entries(referenceSnapshot?.manifest ?? {})) {
        assert.equal(sha256(readFileSync(`${referenceDist}/${name}`)), (file as {sha256: string}).sha256);
    }
    const runs = Number(args.runs);
    const cycles = Number(args.cycles);
    const memoryCycles = Number(args['memory-cycles']);
    for (const value of [runs, cycles, memoryCycles]) assert.ok(Number.isSafeInteger(value) && value > 0);
    assert.ok(args.output, 'Use --output with a new artifact directory');
    const output = resolve(String(args.output));
    mkdirSync(output, {recursive: false});
    const server = await localServer(referenceDist, args.strict, args.scenario !== 'base');
    let browser: Browser;
    const result = {
        startedAt: new Date().toISOString(), status: 'running',
        git: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        productDiff: execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}),
        harnessHashes: Object.fromEntries(['test/bench/e2e/mlt-lifecycle.ts', 'test/bench/e2e/mlt-lifecycle-page.ts'].map(path => [path, sha256(readFileSync(path))])),
        tileSpecGit: execFileSync('git', ['-C', '../maplibre-tile-spec', 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0].model,
        gpuMode: process.env.PUPPETEER_GPU ?? 'software', headless: process.env.PUPPETEER_HEADLESS !== 'false',
        runs, cycles, memoryCycles, styleCycles, phase, scenario: args.scenario, strict: args.strict,
        viewport: {width: 800, height: 600, deviceScaleFactor: 1}, workerCount: 1,
        manifest: server.manifest, traffic: server.traffic, browser: '',
        correctness: {} as Record<string, Awaited<ReturnType<typeof correctness>>>,
        images: {} as Record<string, ReturnType<typeof imageDifference>>,
        queryDifferences: {} as Record<string, {sourceGeometry: boolean; renderedGeometry: boolean}>,
        measureWithDifferences: Boolean(args['measure-with-differences']),
        referenceSnapshot,
        referenceCorrectness: {} as Record<string, Awaited<ReturnType<typeof correctness>>>,
        comparisons: [] as {run: number; version: 'before' | 'after'; encoding: Encoding; result: unknown}[],
        timings: [] as {run: number; encoding: Encoding; result: unknown}[],
        profiles: [] as {run: number; encoding: Encoding; result: unknown}[],
        memory: [] as {run: number; encoding: Encoding; result: unknown}[], error: undefined as string | undefined
    };
    function save(): void { writeFileSync(`${output}/results.json`, `${JSON.stringify(result, null, 2)}\n`); }
    try {
        browser = await launchPuppeteer();
        result.browser = await browser.version();
        for (const encoding of ['mvt', 'mlt'] as const) {
            result.correctness[encoding] = await correctness(browser, server.origin, encoding, output);
            save();
        }
        for (const name of Object.keys(result.correctness.mvt.checkpoints)) {
            const {sourceHash: mvtSource, renderedHash: mvtRendered, ...mvtAttributes} = result.correctness.mvt.checkpoints[name];
            const {sourceHash: mltSource, renderedHash: mltRendered, ...mltAttributes} = result.correctness.mlt.checkpoints[name];
            assert.deepEqual(mltAttributes, mvtAttributes, `Attributes/state/counts differ at ${name}`);
            result.queryDifferences[name] = {sourceGeometry: mvtSource !== mltSource, renderedGeometry: mvtRendered !== mltRendered};
            result.images[name] = imageDifference(`${output}/mvt-${name}.png`, `${output}/mlt-${name}.png`);
        }
        for (const encoding of ['mvt', 'mlt']) {
            assert.ok(imageDifference(`${output}/${encoding}-initial.png`, `${output}/${encoding}-selected.png`).differentPixels > 0,
                'Feature-state must visibly change the rendered image');
            assert.equal(imageDifference(`${output}/${encoding}-selected.png`, `${output}/${encoding}-selected-reloaded.png`).differentPixels, 0,
                'Reload must preserve visible feature-state');
            if (args.scenario !== 'base') {
                assert.ok(imageDifference(`${output}/${encoding}-initial.png`, `${output}/${encoding}-symbol-selected.png`).differentPixels > 0,
                    'Symbol-only feature-state must visibly change the image');
                assert.equal(imageDifference(`${output}/${encoding}-symbol-selected.png`, `${output}/${encoding}-symbol-selected-reloaded.png`).differentPixels, 0);
                assert.equal(imageDifference(`${output}/${encoding}-initial.png`, `${output}/${encoding}-symbol-cleared.png`).differentPixels, 0);
            }
            if (args.scenario === 'styles') {
                assert.ok(imageDifference(`${output}/${encoding}-style-selected.png`, `${output}/${encoding}-style-direct.png`).differentPixels > 0);
                for (const [first, second] of [['style-direct', 'style-diff'], ['style-selected', 'style-direct-restored'],
                    ['style-selected', 'style-diff-restored'], ['style-selected', 'style-assets'],
                    ['initial', 'style-rebuilt'], ['initial', 'style-readded'], ['initial', 'style-final'],
                    ['overzoom-1', 'style-overzoom-restored']]) {
                    assert.equal(imageDifference(`${output}/${encoding}-${first}.png`, `${output}/${encoding}-${second}.png`).differentPixels, 0,
                        `${first}/${second} must restore the same pixels`);
                }
            }
        }
        const hasDifferences = Object.values(result.images).some(image => image.differentPixels > 0) ||
            Object.values(result.queryDifferences).some(query => query.sourceGeometry || query.renderedGeometry);
        if (hasDifferences) {
            result.status = 'differences';
            save();
            console.log('Attributes/state/counts match; geometry or pixel differences recorded (not a parity pass)');
            if (!args['measure-with-differences']) {
                process.exitCode = 1;
                return;
            }
        } else {
            console.log('Query/state/reload and exact pixel parity passed');
        }
        if (phase === 'compare') {
            assert.equal(hasDifferences, false, 'Version comparisons require exact encoding parity');
            for (const encoding of ['mvt', 'mlt'] as const) {
                const reference = await correctness(browser, server.origin, encoding, output, 'reference', `reference-${encoding}`);
                result.referenceCorrectness[encoding] = reference;
                assert.deepEqual(reference.checkpoints, result.correctness[encoding].checkpoints);
                for (const name of Object.keys(reference.checkpoints)) {
                    assert.equal(imageDifference(`${output}/reference-${encoding}-${name}.png`, `${output}/${encoding}-${name}.png`).differentPixels, 0);
                }
                save();
            }
            const variants = [
                {version: 'before' as const, encoding: 'mvt' as const}, {version: 'before' as const, encoding: 'mlt' as const},
                {version: 'after' as const, encoding: 'mvt' as const}, {version: 'after' as const, encoding: 'mlt' as const}
            ];
            for (let run = 0; run < runs; run++) {
                const order = [...variants.slice(run % 4), ...variants.slice(0, run % 4)];
                for (const variant of order) {
                    const samples = await fixedQueryRun(browser, server.origin, variant.encoding,
                        variant.version === 'before' ? 'reference' : 'dist', result.correctness[variant.encoding].checkpoints);
                    result.comparisons.push({run: run + 1, ...variant, result: samples});
                    save();
                    console.log(`comparison ${run + 1}/${runs}: ${variant.version} ${variant.encoding} done`);
                }
            }
        }
        for (let run = 0; run < runs; run++) {
            if (phase !== 'all' && phase !== 'timing') break;
            const order: Encoding[] = run % 2 ? ['mlt', 'mvt'] : ['mvt', 'mlt'];
            for (const encoding of order) {
                result.timings.push({run: run + 1, encoding, result: await timedRun(browser, server.origin, encoding, cycles)});
                save();
                console.log(`timing pair ${run + 1}/${runs}: ${encoding} done`);
            }
        }
        for (let run = 0; run < runs; run++) {
            if (phase !== 'all') break;
            const order: Encoding[] = run % 2 ? ['mlt', 'mvt'] : ['mvt', 'mlt'];
            for (const encoding of order) {
                result.memory.push({run: run + 1, encoding, result: await memoryRun(browser, server.origin, encoding, memoryCycles)});
                save();
                console.log(`memory pair ${run + 1}/${runs}: ${encoding} done`);
            }
        }
        for (let run = 0; run < runs; run++) {
            if (phase !== 'profile') break;
            const order: Encoding[] = run % 2 ? ['mlt', 'mvt'] : ['mvt', 'mlt'];
            for (const encoding of order) {
                result.profiles.push({run: run + 1, encoding, result: await profileRun(browser, server.origin, encoding, output, run + 1)});
                save();
                console.log(`profile pair ${run + 1}/${runs}: ${encoding} done`);
            }
        }
        result.status = hasDifferences ? 'differences' : 'passed';
        if (hasDifferences) process.exitCode = 1;
    } catch (error) {
        result.status = 'failed';
        result.error = String(error);
        throw error;
    } finally {
        save();
        await browser?.close();
        await server.close();
    }
    console.log(`Saved ${output}/results.json`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
