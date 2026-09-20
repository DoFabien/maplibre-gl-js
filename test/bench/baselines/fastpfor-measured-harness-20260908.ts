import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {cpus, platform, arch, release} from 'node:os';
import {gzipSync} from 'node:zlib';
import type {AddressInfo} from 'node:net';
import type {Page} from 'puppeteer';
import minimist from 'minimist';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {sha256, signature, difference, workerStats} from './mlt-geography.ts';
import {installScenario, type ScenarioWindow} from './mlt-lifecycle-page.ts';

type Variant = 'mvt' | 'varint' | 'fastpfor';
type Phase = 'native' | 'overzoom';
type Capture = {hashes: Record<string, string>; counts: Record<string, number>};

/** All six permutations balance session position and pairwise ordering for the three encodings. */
const orders: Variant[][] = [['mvt', 'varint', 'fastpfor'], ['varint', 'fastpfor', 'mvt'], ['fastpfor', 'mvt', 'varint'],
    ['fastpfor', 'varint', 'mvt'], ['varint', 'mvt', 'fastpfor'], ['mvt', 'fastpfor', 'varint']];

/** Uses one unchanged build, immutable input variants and separate parity, latency and allocation processes. */
async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {boolean: ['strict'], default: {mode: 'parity', runs: 1, samples: 20, warmup: 5, repeats: 10, interval: 16384}});
    assert.ok(args.output && args.fixtures, 'Pass a new --output and audited --fixtures directory');
    assert.ok(['parity', 'timing', 'allocations'].includes(args.mode));
    assert.ok(!args.strict || args.mode === 'parity', 'Instrumentation must be excluded from performance measurements');
    for (const key of ['runs', 'samples', 'warmup', 'repeats', 'interval']) assert.ok(Number.isSafeInteger(args[key]) && args[key] > 0);
    const output = resolve(String(args.output)); mkdirSync(output);
    const fixtures = resolve(String(args.fixtures));
    const audit = JSON.parse(readFileSync(`${fixtures}/manifest.json`, 'utf8'));
    assert.equal(audit.tiles.length, 4);
    for (const tile of audit.tiles) {
        for (const variant of ['mvt', 'varint', 'fastpfor']) assert.equal(sha256(readFileSync(tile[variant].path)), tile[variant].sha256);
        assert.ok(tile.afterStreams.some(stream => stream.technique === 'FAST_PFOR'));
        for (const name of ['landuse', 'water', 'building', 'road', 'poi_label']) {
            assert.equal(tile.layers.find(layer => layer.name === name)?.status, 'passed', `${tile.name}/${name}`);
        }
    }
    const bundle = args.strict ? 'dist/mlt-validation' : 'dist';
    const servers = Object.fromEntries(await Promise.all(orders[0].map(async variant => [variant, await serve(variant, bundle, audit)])));
    const report = {status: 'running', startedAt: new Date().toISOString(), finishedAt: '', options: args, browser: '', gpu: process.env.PUPPETEER_GPU ?? 'software',
        environment: {node: process.version, platform: platform(), arch: arch(), release: release(), cpu: cpus()[0].model, logicalCPUs: cpus().length},
        inputAudit: {path: `${fixtures}/manifest.json`, sha256: sha256(readFileSync(`${fixtures}/manifest.json`)), status: audit.status,
            failures: audit.tiles.flatMap(tile => tile.layers.filter(layer => layer.status !== 'passed').map(layer => ({tile: tile.name, ...layer})))},
        harnessHashes: Object.fromEntries(['mlt-fastpfor-browser.ts', 'mlt-lifecycle-page.ts', 'mlt-geography.ts'].map(name =>
            [name, sha256(readFileSync(`test/bench/e2e/${name}`))])),
        manifests: Object.fromEntries(Object.entries(servers).map(([variant, server]: [string, any]) => [variant, server.manifest])),
        requests: Object.fromEntries(Object.entries(servers).map(([variant, server]: [string, any]) => [variant, server.requests])),
        sessions: [] as any[], summary: [] as any[], error: undefined as string | undefined,
        limitation: 'Fixed four-tile Berlin base scene: fill, line, circle and heatmap, no contour layer. Global input parity fails on contour in one tile; no global FastPFOR qualification is claimed. First loaded render is CPU draw submission, not GPU completion or FPS. Network is local, uncompressed, no artificial latency. Allocation profiling is a separate run and excludes public queries; it estimates allocations including collected objects, not retained/peak/GPU memory.'};
    const browser = await launchPuppeteer();
    const references = new Map<string, Capture>(); const images = new Map<string, string>();
    function save(): void { writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2)); }
    try {
        report.browser = await browser.version();
        for (let run = 0; run < args.runs; run++) {
            for (const variant of orders[run % orders.length]) {
                const server = servers[variant]; const page = await browser.newPage(); const errors: string[] = [];
                const encoding = variant === 'mvt' ? 'mvt' : 'mlt';
                const session = {run, variant, info: undefined as any, phases: [] as any[], profiles: [] as any[]};
                report.sessions.push(session); save();
                page.on('pageerror', error => errors.push(String(error)));
                page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
                page.on('request', request => {
                    if (!request.url().startsWith(`${server.origin}/`) && !request.url().startsWith('blob:')) errors.push(`Non-local: ${request.url()}`);
                });
                try {
                    await page.setViewport({width: 800, height: 600, deviceScaleFactor: 1});
                    await page.setCacheEnabled(false); await page.goto(server.origin);
                    await page.addStyleTag({content: '#map {width:800px;height:600px}'});
                    await page.addStyleTag({url: `${server.origin}/dist/maplibre-gl.css`});
                    session.info = await page.evaluate(installScenario, {encoding, origin: server.origin, scenario: 'base' as const});
                    assert.deepEqual(session.info.canvas, {width: 800, height: 600}); assert.equal(session.info.pixelRatio, 1);
                    if (report.gpu === 'hardware') assert.doesNotMatch(session.info.renderer, /swiftshader|llvmpipe|software/i);
                    assert.equal(page.workers().length, 1);
                    if (args.mode === 'allocations') {
                        session.profiles = await allocations(page, server.origin, bundle, output, `${variant}-${run}`, args);
                        session.phases.push(await capture(page, 'native', output, `${variant}-${run}-native`, references, images));
                    } else {
                        for (const phase of ['native', 'overzoom'] as const) {
                            const first = verify(await page.evaluate(measure, phase === 'native' ? 'reload' : 'visit'), phase, references);
                            const rows = [];
                            if (args.mode === 'timing') {
                                for (let iteration = -args.warmup; iteration < args.samples; iteration++) {
                                    const row = verify(await page.evaluate(measure, 'reload'), phase, references);
                                    if (iteration >= 0) rows.push(row);
                                }
                            }
                            const result = await capture(page, phase, output, `${variant}-${run}-${phase}`, references, images);
                            const stats = await workerStats(page, args.strict, encoding);
                            if (args.strict && encoding === 'mlt' && phase === 'native') {
                                assert.ok(stats[0].counters.pretriangulatedFillFeatures > 0);
                                assert.ok(stats[0].counters.pretriangulatedFillTriangles > 0);
                            }
                            session.phases.push({...result, first, rows, stats}); save();
                        }
                    }
                    for (const tile of audit.tiles) assert.ok(server.requests[`/tiles/${encoding}/${tile.name}.${encoding}`] > 0);
                    await page.evaluate(() => (window as ScenarioWindow).mltScenario.destroy());
                    assert.deepEqual(errors, []);
                    console.log(`FastPFOR ${args.mode} ${run + 1}/${args.runs}: ${variant} passed`); save();
                } finally { await page.close(); }
            }
        }
        for (const server of Object.values(servers) as any[]) {
            for (const [path, expected] of Object.entries(server.manifest) as any[]) assert.equal(sha256(readFileSync(path)), expected.sha256, path);
        }
        for (const variant of orders[0]) {
            const sessions = report.sessions.filter(session => session.variant === variant);
            if (args.mode === 'timing') {
                for (const phase of ['native', 'overzoom']) {
                    const sessionMedians = sessions.map(session => Object.fromEntries(['firstRenderMs', 'settledMs', 'queryMs'].map(key =>
                        [key, median(session.phases.find(item => item.phase === phase).rows.map(row => row.times[key]))])));
                    report.summary.push({variant, phase, sessionMedians, medianOfSessionMedians: Object.fromEntries(
                        Object.keys(sessionMedians[0]).map(key => [key, median(sessionMedians.map(row => row[key]))]))});
                }
            }
            if (args.mode === 'allocations') report.summary.push({variant, ...Object.fromEntries(['main', 'worker'].map(context =>
                [context, median(sessions.map(session => session.profiles.find(profile => profile.context === context).summary.totalBytes))]))});
        }
        report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
    finally { report.finishedAt = new Date().toISOString(); save(); await browser.close(); await Promise.all(Object.values(servers).map((server: any) => server.close())); }
}

/** Serves only identical build files and the four audited input files; no historical fixtures are overwritten. */
async function serve(variant: Variant, bundle: string, audit: any) {
    const files = new Map<string, {bytes: Buffer; mime: string}>();
    const manifest: Record<string, {sha256: string; bytes: number}> = {}; const requests: Record<string, number> = {};
    function add(url: string, path: string, mime: string): void {
        const bytes = readFileSync(path); files.set(url, {bytes, mime}); manifest[path] = {sha256: sha256(bytes), bytes: bytes.length};
    }
    add('/', 'test/bench/e2e/index.html', 'text/html');
    for (const name of ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl.css']) {
        add(`/dist/${name}`, `${bundle}/${name}`, name.endsWith('.css') ? 'text/css' : 'text/javascript');
        if (name.endsWith('.mjs')) {
            const path = `${bundle}/${name}.map`; const bytes = readFileSync(path);
            manifest[path] = {sha256: sha256(bytes), bytes: bytes.length};
        }
    }
    const encoding = variant === 'mvt' ? 'mvt' : 'mlt';
    for (const tile of audit.tiles) add(`/tiles/${encoding}/${tile.name}.${encoding}`, tile[variant].path, 'application/octet-stream');
    const server = createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost').pathname;
        requests[url] = (requests[url] ?? 0) + 1;
        const file = files.get(url);
        if (!file) { response.writeHead(url === '/favicon.ico' ? 204 : 404); response.end(); return; }
        response.writeHead(200, {'Content-Type': file.mime, 'Cache-Control': 'no-store'}); response.end(file.bytes);
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    return {origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, manifest, requests,
        close: () => new Promise<void>(done => server.close(() => done()))};
}

/** Matches the established geometry-browser metric; exhaustive public queries happen after draw timing stops. */
async function measure(action: 'reload' | 'visit') {
    const scenario = (window as ScenarioWindow).mltScenario; const map = scenario.getMap();
    let firstRenderMs: number; let content = false; const start = performance.now();
    function data(event): void { if (event.sourceId === 'corpus' && event.sourceDataType === 'content') content = true; }
    function render(): void {
        if ((action === 'visit' || content) && map.isSourceLoaded('corpus') && map.loaded()) firstRenderMs ??= performance.now() - start;
    }
    map.on('sourcedata', data); map.on('render', render);
    try { if (action === 'visit') await scenario.visit(0); else await scenario.reload(); }
    finally { map.off('sourcedata', data); map.off('render', render); }
    if (firstRenderMs === undefined) throw new Error('No loaded render after the measured action');
    const settledMs = performance.now() - start;
    const queryStart = performance.now(); const queries = scenario.queryJSON(); const queryMs = performance.now() - queryStart;
    return {times: {firstRenderMs, settledMs, queryMs}, queries};
}

/** Hashes every public feature with order-independent canonicalization, preserving geometry, IDs and attributes. */
function queryCapture(queries): Capture {
    for (const key of ['source', 'rendered']) assert.ok(queries[key].length > 0);
    return {hashes: Object.fromEntries(Object.entries(queries).map(([key, features]: [string, any]) => [key, signature(features)])),
        counts: Object.fromEntries(Object.entries(queries).map(([key, features]: [string, any]) => [key, features.length]))};
}

function verify(sample, phase: Phase, references: Map<string, Capture>) {
    const result = queryCapture(sample.queries);
    if (references.has(phase)) assert.deepEqual(result, references.get(phase)); else references.set(phase, result);
    for (const value of Object.values(sample.times)) assert.ok(Number.isFinite(value) && (value as number) > 0);
    return {times: sample.times, ...result};
}

/** Archives complete query values and compares exact rendered pixels outside any measured interval. */
async function capture(page: Page, phase: Phase, output: string, name: string, references: Map<string, Capture>, images: Map<string, string>) {
    const values = await page.evaluate(() => (window as ScenarioWindow).mltScenario.queryJSON());
    const result = queryCapture(values);
    if (references.has(phase)) assert.deepEqual(result, references.get(phase)); else references.set(phase, result);
    const queries = `${output}/${name}.json.gz`; writeFileSync(queries, gzipSync(JSON.stringify(values)));
    const image = `${output}/${name}.png`; await (await page.$('#map')).screenshot({path: image});
    if (images.has(phase)) assert.equal(difference(image, images.get(phase)).pixels, 0); else images.set(phase, image);
    return {phase, ...result, queries, image};
}

/** Measures allocations only; latency produced under the profiler is not reported. */
async function allocations(page: Page, origin: string, bundle: string, output: string, name: string, args: any) {
    await page.evaluate(reload, args.warmup);
    const main = await page.createCDPSession(); const profiles = [];
    const clients = [{context: 'main', client: main}, {context: 'worker', client: page.workers()[0].client}];
    const maps = new Map<string, TraceMap>();
    for (const file of ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
        maps.set(`${origin}/dist/${file}`, new TraceMap(JSON.parse(readFileSync(`${bundle}/${file}.map`, 'utf8'))));
    }
    try {
        for (const {client} of clients) {
            await client.send('HeapProfiler.collectGarbage');
            await client.send('HeapProfiler.startSampling', {samplingInterval: args.interval,
                includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true});
        }
        await page.evaluate(reload, args.repeats);
        for (const {context, client} of clients) {
            const {profile} = await client.send('HeapProfiler.stopSampling');
            const file = `${output}/${name}-${context}.heapprofile.gz`;
            const bytes = gzipSync(JSON.stringify(profile)); writeFileSync(file, bytes);
            profiles.push({context, file, sha256: sha256(bytes), summary: summarize(profile, maps)});
        }
    } finally { await main.detach(); }
    return profiles;
}

async function reload(repeats: number): Promise<void> {
    for (let index = 0; index < repeats; index++) await (window as ScenarioWindow).mltScenario.reload();
}

/** Self sizes are additive; inclusive stack sizes are deliberately omitted. */
function summarize(profile, maps: Map<string, TraceMap>) {
    const self: Record<string, number> = {};
    function visit(node): number {
        const frame = node.callFrame; const map = maps.get(frame.url);
        const source = map && frame.lineNumber >= 0 ? originalPositionFor(map, {line: frame.lineNumber + 1, column: frame.columnNumber}) : undefined;
        const label = source?.source ? `${source.source}:${source.line} ${source.name ?? frame.functionName}` : frame.functionName || frame.url;
        self[label] = (self[label] ?? 0) + node.selfSize;
        return node.selfSize + node.children.reduce((sum, child) => sum + visit(child), 0);
    }
    const totalBytes = visit(profile.head); assert.ok(totalBytes > 0 && profile.samples.length > 0);
    return {totalBytes, samples: profile.samples.length, selfBytes: Object.fromEntries(Object.entries(self).sort((a, b) => b[1] - a[1]))};
}

function median(values: number[]): number {
    const sorted = values.toSorted((a, b) => a - b); assert.ok(sorted.length && sorted.every(Number.isFinite));
    return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
