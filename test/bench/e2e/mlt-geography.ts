import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import type {AddressInfo} from 'node:net';
import type {Page} from 'puppeteer';
import minimist from 'minimist';
import {PNG} from 'pngjs';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {installScenario, type GeographyAction, type GeographySnapshot, type ScenarioWindow} from './mlt-lifecycle-page.ts';
import type {MltMaterializationStats} from '../../../src/util/mlt_materialization_stats.ts';

type Step = {name: string; action?: GeographyAction; selected?: boolean; reload?: boolean; sameAs?: string; globe: number; dem?: string; world?: boolean};
type Snapshot = Omit<GeographySnapshot, 'queries'> & {hashes: Record<string, string>; counts: Record<string, number>};

const steps: Step[] = [
    {name: 'initial', globe: 0},
    {name: 'selected', selected: true, globe: 0},
    {name: 'terrain-home', action: {terrain: {source: 'dem-local', exaggeration: 1}}, globe: 0, dem: 'dem-local'},
    {name: 'terrain-pitched', action: {camera: 'pitched'}, globe: 0, dem: 'dem-local'},
    {name: 'terrain-double', action: {terrain: {source: 'dem-local', exaggeration: 2}}, globe: 0, dem: 'dem-local'},
    {name: 'terrain-restored', action: {terrain: {source: 'dem-local', exaggeration: 1}}, sameAs: 'terrain-pitched', globe: 0, dem: 'dem-local'},
    {name: 'terrain-dem-reloaded', action: {reloadDEM: true}, sameAs: 'terrain-pitched', globe: 0, dem: 'dem-local'},
    {name: 'terrain-vector-reloaded', reload: true, sameAs: 'terrain-pitched', globe: 0, dem: 'dem-local'},
    {name: 'terrain-off', action: {terrain: null, removeDEM: true}, globe: 0},
    {name: 'terrain-readded', action: {terrain: {source: 'dem-local', exaggeration: 1}}, sameAs: 'terrain-pitched', globe: 0, dem: 'dem-local'},
    {name: 'terrain-final', action: {terrain: null, removeDEM: true, camera: 'home'}, sameAs: 'selected', globe: 0},
    {name: 'world-mercator', action: {camera: 'world', projection: 'mercator'}, globe: 0, world: true},
    {name: 'world-blend', action: {projection: 'blend'}, globe: 0.5, world: true},
    {name: 'world-globe', action: {projection: 'globe'}, globe: 1, world: true},
    {name: 'world-terrain', action: {terrain: {source: 'dem-world', exaggeration: 1}}, globe: 1, world: true, dem: 'dem-world'},
    {name: 'world-terrain-double', action: {terrain: {source: 'dem-world', exaggeration: 2}}, globe: 1, world: true, dem: 'dem-world'},
    {name: 'world-terrain-restored', action: {terrain: {source: 'dem-world', exaggeration: 1}}, sameAs: 'world-terrain', globe: 1, world: true, dem: 'dem-world'},
    {name: 'world-terrain-off', action: {terrain: null, removeDEM: true}, sameAs: 'world-globe', globe: 1, world: true},
    {name: 'world-rotated', action: {camera: 'rotated'}, globe: 1, world: true},
    {name: 'world-restored', action: {camera: 'world'}, sameAs: 'world-globe', globe: 1, world: true},
    {name: 'mercator-world-restored', action: {projection: 'mercator'}, sameAs: 'world-mercator', globe: 0, world: true},
    {name: 'home-selected', action: {camera: 'home'}, sameAs: 'selected', globe: 0},
    {name: 'cleared', selected: false, sameAs: 'initial', globe: 0}
];

export function sha256(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
export function signature(features: GeoJSON.Feature[]): string { return sha256(JSON.stringify(features.map(feature => JSON.stringify(canonical(feature))).sort())); }

/** Synthetic numeric DEM data, not measured Berlin topography. Pixel centres sample a continuous, non-flat height field. */
function dem(x: number, y: number, world: boolean): Buffer {
    const png = new PNG({width: 256, height: 256});
    for (let row = 0; row < 256; row++) for (let col = 0; col < 256; col++) {
        const u = x + (col + 0.5) / 256;
        const v = y + (row + 0.5) / 256;
        const height = world ? 1200 + 1000 * Math.sin(u * Math.PI * 4) * Math.cos(v * Math.PI * 4) :
            150 + 350 * Math.exp(-40 * ((u - 2200.75) ** 2 + (v - 1343.75) ** 2)) +
            160 * (1 + Math.sin((u - 2200.5) * Math.PI * 6) * Math.cos((v - 1343.5) * Math.PI * 6));
        const encoded = Math.round((height + 10000) * 10);
        const offset = (row * 256 + col) * 4;
        png.data[offset] = encoded >>> 16;
        png.data[offset + 1] = (encoded >>> 8) & 255;
        png.data[offset + 2] = encoded & 255;
        png.data[offset + 3] = 255;
    }
    return PNG.sync.write(png);
}

/** Fixed allowlist includes world/local vector pairs and generated DEM bytes, all archived and hashed. */
export async function localServer(output: string, strict: boolean, bundleDirectory: string = strict ? 'dist/mlt-validation' : 'dist'): Promise<{
    origin: string; manifest: Record<string, {bytes: number; sha256: string}>;
    requests: Record<string, number>; close(): Promise<void>;
}> {
    const files = new Map<string, {bytes: Buffer; mime: string}>();
    const manifest: Record<string, {bytes: number; sha256: string}> = {};
    const requests: Record<string, number> = {};
    function add(url: string, path: string, mime: string): void {
        const bytes = readFileSync(path);
        files.set(url, {bytes, mime});
        manifest[path] = {bytes: bytes.length, sha256: sha256(bytes)};
    }
    for (const name of ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl.css']) {
        add(`/dist/${name}`, `${bundleDirectory}/${name}`, name.endsWith('.css') ? 'text/css' : 'text/javascript');
    }
    add('/', 'test/bench/e2e/index.html', 'text/html');
    const tileNames = ['0-0-0', '14-8802-5374', '14-8802-5375', '14-8803-5374', '14-8803-5375'];
    for (const encoding of ['mvt', 'mlt']) for (const name of tileNames) {
        add(`/tiles/${encoding}/${name}.${encoding}`, `test/integration/assets/tiles/${encoding === 'mlt' ? 'mlt/gl-js/' : ''}${name}.${encoding}`, 'application/octet-stream');
    }
    for (const range of ['0-255', '256-511', '8192-8447']) {
        const path = `glyphs/Open Sans Semibold,Arial Unicode MS Bold/${range}.pbf`;
        add(`/${path}`, `test/integration/assets/${path}`, 'application/octet-stream');
    }
    for (const extension of ['json', 'png']) add(`/sprites/sprite.${extension}`, `test/integration/assets/sprites/sprite.${extension}`,
        extension === 'json' ? 'application/json' : 'image/png');
    for (const [x, y, world] of [[2200, 1343, false], [2201, 1343, false], [2200, 1344, false], [2201, 1344, false], [0, 0, true]] as const) {
        const name = `${world ? 'dem-world/0' : 'dem-local/12'}-${x}-${y}.png`;
        const path = `${output}/${name.replace('/', '-')}`;
        writeFileSync(path, dem(x, y, world));
        add(`/${name}`, path, 'image/png');
    }
    const server = createServer((request, response) => {
        const path = decodeURI(new URL(request.url, 'http://localhost').pathname);
        requests[path] = (requests[path] ?? 0) + 1;
        const file = files.get(path);
        if (!file) { response.writeHead(path === '/favicon.ico' ? 204 : 404); response.end(); return; }
        response.writeHead(200, {'Content-Type': file.mime, 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'"});
        response.end(file.bytes);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, manifest, requests,
        close: () => new Promise<void>(resolve => server.close(() => resolve()))};
}

export function difference(first: string, second: string): {pixels: number; maxDelta: number} {
    const a = PNG.sync.read(readFileSync(first));
    const b = PNG.sync.read(readFileSync(second));
    assert.equal(a.width, b.width); assert.equal(a.height, b.height);
    let pixels = 0; let maxDelta = 0;
    for (let index = 0; index < a.data.length; index += 4) {
        let changed = false;
        for (let channel = 0; channel < 4; channel++) {
            const delta = Math.abs(a.data[index + channel] - b.data[index + channel]);
            changed ||= delta > 0; maxDelta = Math.max(maxDelta, delta);
        }
        if (changed) pixels++;
    }
    return {pixels, maxDelta};
}

async function mutate(page: Page, step: Step): Promise<void> {
    await page.evaluate(async step => {
        const scenario = (window as ScenarioWindow).mltScenario;
        if (step.action) await scenario.geography(step.action);
        if (step.reload) await scenario.reload();
        if (step.selected !== undefined) { await scenario.select(step.selected); await scenario.selectSymbol(step.selected); }
    }, step);
}

async function snapshot(page: Page, step: Step, selected: boolean): Promise<{summary: Snapshot; queries: GeographySnapshot['queries']}> {
    const {queries, ...metadata} = await page.evaluate(() => (window as ScenarioWindow).mltScenario.geographySnapshot());
    assert.equal(metadata.globeness, step.globe, `Actual projection at ${step.name}`);
    assert.deepEqual(metadata.vectorSourcesPreserved, [true, true]);
    assert.deepEqual(metadata.selectedState, selected ? {selected: true} : {});
    assert.deepEqual(metadata.symbolSelectedState, selected ? {selected: true} : {});
    assert.equal(metadata.terrain?.source, step.dem);
    if (step.dem) {
        assert.ok(metadata.elevations.every(value => Number.isFinite(value) && value > 0));
        assert.ok(Math.max(...metadata.elevations) - Math.min(...metadata.elevations) > 10, 'DEM must be non-flat');
    } else assert.deepEqual(metadata.elevations, [null, null, null]);
    const requiredLayers = step.world ? ['world-land', 'world-water', 'world-admin'] : ['buildings', 'roads', 'poi-labels', 'street-labels'];
    for (const id of requiredLayers) assert.ok(metadata.layerCounts[id] > 0, `Layer ${id} is empty at ${step.name}`);
    const collections = {...queries.source, rendered: queries.rendered};
    return {queries, summary: {...metadata,
        hashes: Object.fromEntries(Object.entries(collections).map(([key, features]) => [key, signature(features)])),
        counts: Object.fromEntries(Object.entries(collections).map(([key, features]) => [key, features.length]))}};
}

export async function workerStats(page: Page, strict: boolean, encoding: string): Promise<{counters: MltMaterializationStats['counters']; forbidden: string[]}[]> {
    assert.equal(page.workers().length, 1);
    if (!strict) return [];
    const stats = await page.workers()[0].evaluate(() => {
        const stats = (globalThis as typeof globalThis & {__mltRenderStats?: MltMaterializationStats}).__mltRenderStats;
        if (!stats?.strict) throw new Error('Strict worker instrumentation missing');
        return {counters: {...stats.counters}, forbidden: [...stats.forbiddenCounters]};
    });
    assert.equal(stats.forbidden.length, 10);
    for (const key of [...stats.forbidden, 'propertyProxyMisses']) assert.equal(stats.counters[key], 0, key);
    if (encoding === 'mlt') assert.ok(stats.counters.decodedLayers > 0);
    else assert.equal(stats.counters.decodedLayers, 0);
    return [stats];
}

/** Correctness-only qualification; exact restoration/parity failures stay failures, with raw evidence retained. */
async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {boolean: ['strict'], default: {cycles: 1}});
    assert.ok(args.output, 'Use a new --output directory');
    assert.ok(Number.isSafeInteger(Number(args.cycles)) && Number(args.cycles) > 0);
    const output = resolve(String(args.output));
    mkdirSync(output, {recursive: false});
    const server = await localServer(output, args.strict);
    const report = {status: 'running', startedAt: new Date().toISOString(), strict: args.strict, cycles: Number(args.cycles), steps,
        gpuMode: process.env.PUPPETEER_GPU ?? 'software', manifest: server.manifest, requests: server.requests,
        git: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        tileSpecGit: execFileSync('git', ['-C', '../maplibre-tile-spec', 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        productDiff: execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}),
        harnessHashes: Object.fromEntries(['test/bench/e2e/mlt-geography.ts', 'test/bench/e2e/mlt-lifecycle-page.ts'].map(path => [path, sha256(readFileSync(path))])),
        browser: '', sessions: {} as Record<string, {info: unknown; checkpoints: Record<string, Snapshot>; repeats: unknown[]; stats: unknown[]}>,
        images: {} as Record<string, ReturnType<typeof difference>>, error: undefined as string | undefined};
    const browser = await launchPuppeteer();
    function save(): void { writeFileSync(`${output}/results.json`, `${JSON.stringify(report, null, 2)}\n`); }
    try {
        report.browser = await browser.version();
        for (const encoding of ['mvt', 'mlt'] as const) {
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(String(error)));
            page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
            page.on('request', request => { if (!request.url().startsWith(`${server.origin}/`) && !request.url().startsWith('blob:')) errors.push(`Non-local request: ${request.url()}`); });
            try {
                await page.setViewport({width: 800, height: 600, deviceScaleFactor: 1});
                await page.setCacheEnabled(false);
                await page.goto(server.origin);
                await page.addStyleTag({content: '#map {width:800px;height:600px}'});
                await page.addStyleTag({url: `${server.origin}/dist/maplibre-gl.css`});
                const info = await page.evaluate(installScenario, {encoding, origin: server.origin, scenario: 'geography' as const});
                assert.deepEqual(info.canvas, {width: 800, height: 600});
                assert.equal(info.pixelRatio, 1);
                if (report.gpuMode === 'hardware') assert.doesNotMatch(info.renderer, /swiftshader|llvmpipe|software/i);
                const session = report.sessions[encoding] = {info, checkpoints: {}, repeats: [], stats: []};
                let selected = false;
                for (const step of steps) {
                    console.log(`${encoding}: ${step.name}`);
                    await mutate(page, step);
                    selected = step.selected ?? selected;
                    const {summary, queries} = await snapshot(page, step, selected);
                    session.checkpoints[step.name] = summary;
                    writeFileSync(`${output}/${encoding}-${step.name}.json.gz`, gzipSync(JSON.stringify(queries)));
                    await page.screenshot({path: `${output}/${encoding}-${step.name}.png`});
                    session.stats.push({step: step.name, workers: await workerStats(page, args.strict, encoding)});
                    save();
                    if (step.sameAs) {
                        assert.deepEqual(summary, session.checkpoints[step.sameAs], `${encoding}: restore ${step.name}`);
                        assert.equal(difference(`${output}/${encoding}-${step.name}.png`, `${output}/${encoding}-${step.sameAs}.png`).pixels, 0, `${encoding}: pixels ${step.name}`);
                    }
                    assert.deepEqual(errors, []);
                }
                for (let cycle = 1; cycle <= Number(args.cycles); cycle++) {
                    await page.evaluate(async () => { await (window as ScenarioWindow).mltScenario.select(true); await (window as ScenarioWindow).mltScenario.selectSymbol(true); });
                    for (const name of ['world-mercator', 'world-globe', 'world-terrain', 'world-terrain-off', 'mercator-world-restored', 'home-selected', 'terrain-home', 'terrain-pitched', 'terrain-final']) {
                        const step = steps.find(step => step.name === name);
                        await mutate(page, step);
                        const {summary} = await snapshot(page, step, true);
                        assert.deepEqual(summary, session.checkpoints[name], `${encoding}: repeat ${cycle}/${name}`);
                        session.repeats.push({cycle, name, summary});
                    }
                }
                session.stats.push({step: 'final', workers: await workerStats(page, args.strict, encoding)});
                await page.evaluate(() => (window as ScenarioWindow).mltScenario.destroy());
                assert.equal(await page.evaluate(() => document.querySelectorAll('canvas').length), 0);
                assert.deepEqual(errors, []);
                save();
            } finally { await page.close(); }
        }
        for (const step of steps) {
            assert.deepEqual(report.sessions.mlt.checkpoints[step.name], report.sessions.mvt.checkpoints[step.name], `MVT/MLT ${step.name}`);
            report.images[step.name] = difference(`${output}/mvt-${step.name}.png`, `${output}/mlt-${step.name}.png`);
        }
        save();
        for (const [name, delta] of Object.entries(report.images)) assert.equal(delta.pixels, 0, `MVT/MLT pixels ${name}`);
        assert.ok(difference(`${output}/mvt-selected.png`, `${output}/mvt-terrain-home.png`).pixels > 0, 'Terrain must change the image');
        assert.ok(difference(`${output}/mvt-world-mercator.png`, `${output}/mvt-world-globe.png`).pixels > 0, 'Globe must change the image');
        for (const [first, second] of [['terrain-pitched', 'terrain-double'], ['world-globe', 'world-terrain'], ['world-terrain', 'world-terrain-double']]) {
            assert.ok(difference(`${output}/mvt-${first}.png`, `${output}/mvt-${second}.png`).pixels > 0, `${first}/${second} must change the image`);
        }
        report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
    finally { save(); await browser.close(); await server.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
