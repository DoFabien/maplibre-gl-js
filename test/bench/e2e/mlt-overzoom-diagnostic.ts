import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {cpus, release} from 'node:os';
import {gzipSync} from 'node:zlib';
import minimist from 'minimist';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import type {Protocol} from 'devtools-protocol';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {localServer, sha256, signature, difference} from './mlt-geography.ts';
import {installScenario, type ScenarioWindow} from './mlt-lifecycle-page.ts';

type DiagnosticWindow = ScenarioWindow & {overzoomDiagnostic: {lastRaf: number; raf: number}};
type Observation = {
    firstRenderMs: number; settledMs: number; lastTileDataMs: number; readyToRenderMs: number;
    startRafPhaseMs: number; contents: number[]; tiles: {t: number; key: string}[]; renders: number[];
    queryMs: number; visibility: DocumentVisibilityState;
};

/** Separates warm-overzoom reload latency, frame waiting and sampled CPU work in frozen production bundles. */
async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {boolean: ['queries'], default: {
        mode: 'timing', runs: 6, samples: 40, warmup: 10, native: 26, candidate: 'dist', encoding: 'mlt'
    }});
    assert.ok(args.output && args.reference, 'Pass new --output and frozen --reference directories');
    assert.ok(['timing', 'profile'].includes(args.mode));
    assert.ok(['mvt', 'mlt'].includes(args.encoding));
    for (const key of ['runs', 'samples', 'warmup', 'native']) assert.ok(Number.isSafeInteger(args[key]) && args[key] > 0);
    const output = resolve(args.output); mkdirSync(output);
    const bundles = {before: resolve(args.reference), after: resolve(args.candidate)};
    const servers = {} as Record<string, Awaited<ReturnType<typeof localServer>>>;
    for (const version of ['before', 'after']) {
        mkdirSync(`${output}/${version}`);
        servers[version] = await localServer(`${output}/${version}`, false, bundles[version]);
    }
    const report = {status: 'running', startedAt: new Date().toISOString(), options: args, bundles,
        host: {node: process.version, os: release(), cpu: cpus()[0].model}, browser: '',
        gpu: process.env.PUPPETEER_GPU ?? 'software', headless: process.env.PUPPETEER_HEADLESS !== 'false',
        manifests: Object.fromEntries(Object.entries(servers).map(([key, server]) => [key, server.manifest])),
        harnessHashes: Object.fromEntries(['mlt-overzoom-diagnostic.ts', 'mlt-geography.ts', 'mlt-lifecycle-page.ts'].map(name =>
            [name, sha256(readFileSync(`test/bench/e2e/${name}`))])),
        sessions: [] as unknown[], error: undefined as string | undefined,
        limitation: 'Fixed Berlin corpus, one worker, warm clipped-parent cache, forced URL reloads. No query serialization or node-side hashing between observations. Queries are optional and remain outside the reload clock. CPU profiling is a separate mode; its latency is not benchmark evidence. Render is CPU submission, not GPU presentation. Source-ready to render includes frame scheduling and main-thread draw/upload.'};
    const browser = await launchPuppeteer();
    let reference: {source: string; rendered: string; image: string};
    function save(): void { writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2)); }
    try {
        report.browser = await browser.version();
        for (let run = 0; run < args.runs; run++) for (const version of run % 2 ? ['after', 'before'] : ['before', 'after']) {
            const server = servers[version]; const page = await browser.newPage(); const errors: string[] = [];
            page.on('pageerror', error => errors.push(String(error)));
            page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
            page.on('request', request => {
                if (!request.url().startsWith(`${server.origin}/`) && !request.url().startsWith('blob:')) errors.push(`Non-local request: ${request.url()}`);
            });
            try {
                await page.setViewport({width: 800, height: 600, deviceScaleFactor: 1});
                await page.setCacheEnabled(false); await page.goto(server.origin);
                await page.addStyleTag({content: '#map {width:800px;height:600px}'});
                await page.addStyleTag({url: `${server.origin}/dist/maplibre-gl.css`});
                const encoding = args.encoding as 'mlt' | 'mvt';
                const info = await page.evaluate(installScenario, {encoding, origin: server.origin, scenario: 'base' as const});
                if (report.gpu === 'hardware') assert.doesNotMatch(info.renderer, /swiftshader|llvmpipe|software/i);
                assert.equal(page.workers().length, 1);
                await page.evaluate(async ({native, warmup}) => {
                    const scope = window as unknown as DiagnosticWindow;
                    for (let i = 0; i < native; i++) await scope.mltScenario.reload();
                    await scope.mltScenario.visit(0);
                    for (let i = 0; i < warmup; i++) await scope.mltScenario.reload();
                    scope.overzoomDiagnostic = {lastRaf: performance.now(), raf: 0};
                    function tick(): void {
                        scope.overzoomDiagnostic.lastRaf = performance.now();
                        scope.overzoomDiagnostic.raf = requestAnimationFrame(tick);
                    }
                    scope.overzoomDiagnostic.raf = requestAnimationFrame(tick);
                }, {native: args.native, warmup: args.warmup});
                const clients = [{name: 'main', client: await page.createCDPSession()}, {name: 'worker', client: page.workers()[0].client}];
                const profiles: unknown[] = [];
                const observations: Observation[] = [];
                try {
                    if (args.mode === 'profile') for (const {client} of clients) {
                        await client.send('Profiler.enable');
                        await client.send('Profiler.setSamplingInterval', {interval: 250});
                        await client.send('Profiler.start');
                    }
                    for (let i = 0; i < args.samples; i++) observations.push(await page.evaluate(observeReload, args.queries));
                    if (args.mode === 'profile') for (const {name, client} of clients) {
                        const {profile} = await client.send('Profiler.stop'); await client.send('Profiler.disable');
                        const file = `${output}/${version}-${run}-${name}.cpuprofile.gz`;
                        writeFileSync(file, gzipSync(JSON.stringify(profile)));
                        const maps = new Map<string, TraceMap>(); const hashes: Record<string, string> = {};
                        for (const bundle of ['maplibre-gl', 'maplibre-gl-worker', 'maplibre-gl-shared']) {
                            const path = `${bundles[version]}/${bundle}.mjs.map`; const bytes = readFileSync(path);
                            maps.set(`${server.origin}/dist/${bundle}.mjs`, new TraceMap(JSON.parse(bytes.toString()))); hashes[path] = sha256(bytes);
                        }
                        profiles.push({name, file, sha256: sha256(readFileSync(file)), maps: hashes, ...summarizeProfile(profile, maps)});
                    }
                } finally { await clients[0].client.detach(); }
                const queries = await page.evaluate(() => (window as ScenarioWindow).mltScenario.queryJSON());
                const hashes = {source: signature(queries.source), rendered: signature(queries.rendered)};
                assert.ok(queries.source.length && queries.rendered.length);
                const queryPath = `${output}/${version}-${run}.json.gz`;
                writeFileSync(queryPath, gzipSync(JSON.stringify(queries)));
                const image = `${output}/${version}-${run}.png`;
                await (await page.$('#map')).screenshot({path: image});
                if (reference) {
                    assert.equal(hashes.source, reference.source); assert.equal(hashes.rendered, reference.rendered);
                    assert.equal(difference(image, reference.image).pixels, 0);
                } else reference = {...hashes, image};
                await page.evaluate(() => {
                    const scope = window as unknown as DiagnosticWindow;
                    cancelAnimationFrame(scope.overzoomDiagnostic.raf); scope.mltScenario.destroy();
                });
                assert.deepEqual(errors, []);
                const median = Object.fromEntries(['firstRenderMs', 'lastTileDataMs', 'readyToRenderMs', 'startRafPhaseMs', 'queryMs'].map(key =>
                    [key, percentile(observations.map(row => row[key]), 0.5)]));
                report.sessions.push({run, version, encoding, info, observations, median, profiles, image, queries: queryPath, hashes,
                    counts: {source: queries.source.length, rendered: queries.rendered.length}});
                save(); console.log(JSON.stringify({run, version, median}));
            } finally { await page.close(); }
        }
        for (const manifest of Object.values(report.manifests)) for (const [path, expected] of Object.entries(manifest)) {
            assert.equal(sha256(readFileSync(path)), expected.sha256, path);
        }
        report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
    finally { save(); await browser.close(); for (const server of Object.values(servers)) await server.close(); }
}

/** Observes public source events and loaded draws; exhaustive queries, when enabled, follow the measured reload. */
async function observeReload(queries: boolean): Promise<Observation> {
    const scope = window as unknown as DiagnosticWindow; const scenario = scope.mltScenario; const map = scenario.getMap();
    if (document.visibilityState !== 'visible') throw new Error('Hidden benchmark page');
    const start = performance.now(); const startRafPhaseMs = start - scope.overzoomDiagnostic.lastRaf;
    const contents: number[] = []; const tiles: Observation['tiles'] = []; const renders: number[] = [];
    let firstRenderMs: number;
    function data(event): void {
        if (event.sourceId !== 'corpus') return;
        const t = performance.now() - start;
        if (event.sourceDataType === 'content') contents.push(t);
        if (event.coord) tiles.push({t, key: event.coord.key});
    }
    function render(): void {
        const now = performance.now() - start; renders.push(now);
        if (contents.length && map.isSourceLoaded('corpus') && map.loaded()) firstRenderMs ??= now;
    }
    map.on('sourcedata', data); map.on('render', render);
    try { await scenario.reload(); }
    finally { map.off('sourcedata', data); map.off('render', render); }
    if (firstRenderMs === undefined || !contents.length || !tiles.length) throw new Error('Missing loaded render, source change or completed tile data');
    const settledMs = performance.now() - start; const lastTileDataMs = tiles.at(-1).t;
    if (lastTileDataMs > firstRenderMs) throw new Error('Tile data arrived after the reported loaded render');
    const queryStart = performance.now();
    if (queries) scenario.queryJSON();
    return {firstRenderMs, settledMs, lastTileDataMs, readyToRenderMs: firstRenderMs - lastTileDataMs,
        startRafPhaseMs, contents, tiles, renders, queryMs: queries ? performance.now() - queryStart : 0, visibility: document.visibilityState};
}

/** Labels CPU samples with exact sourcemaps; inclusive time overlaps across stack frames. */
function summarizeProfile(profile: Protocol.Profiler.Profile, maps: Map<string, TraceMap>) {
    const labels = new Map<number, string>(); const parents = new Map<number, number>();
    for (const node of profile.nodes) {
        const frame = node.callFrame; const map = maps.get(frame.url);
        const location = map && frame.lineNumber >= 0 ? originalPositionFor(map, {line: frame.lineNumber + 1, column: frame.columnNumber}) : undefined;
        labels.set(node.id, location?.source ? `${location.source}:${location.line} ${location.name ?? frame.functionName}` : frame.functionName || frame.url);
        for (const child of node.children ?? []) parents.set(child, node.id);
    }
    const self: Record<string, number> = Object.create(null); const inclusive: Record<string, number> = Object.create(null);
    const samples = profile.samples ?? []; const deltas = profile.timeDeltas ?? [];
    assert.equal(samples.length, deltas.length); assert.ok(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const label = labels.get(samples[i]); self[label] = (self[label] ?? 0) + deltas[i];
        const stack = new Set<string>();
        for (let id = samples[i]; id !== undefined; id = parents.get(id)) stack.add(labels.get(id));
        for (const value of stack) inclusive[value] = (inclusive[value] ?? 0) + deltas[i];
    }
    return {sampleCount: samples.length, sampledMicroseconds: deltas.reduce((a, b) => a + b, 0), self, inclusive};
}

function percentile(values: number[], fraction: number): number {
    const sorted = values.toSorted((a, b) => a - b); const position = (sorted.length - 1) * fraction;
    return sorted[Math.floor(position)] + (sorted[Math.ceil(position)] - sorted[Math.floor(position)]) * (position % 1);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
