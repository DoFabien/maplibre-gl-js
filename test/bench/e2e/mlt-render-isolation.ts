import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import type {AddressInfo} from 'node:net';
import minimist from 'minimist';
import {PNG} from 'pngjs';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {installScenario, type ScenarioWindow, type RenderObservation} from './mlt-lifecycle-page.ts';

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

function difference(a: Uint8Array, b: Uint8Array): {pixels: number; maxDelta: number} {
    assert.equal(a.length, b.length);
    let pixels = 0;
    let maxDelta = 0;
    for (let index = 0; index < a.length; index += 4) {
        let changed = false;
        for (let channel = 0; channel < 4; channel++) {
            const delta = Math.abs(a[index + channel] - b[index + channel]);
            maxDelta = Math.max(maxDelta, delta);
            changed ||= delta > 0;
        }
        if (changed) pixels++;
    }
    return {pixels, maxDelta};
}

/** Uses the existing fixed corpus and production renderer; changes only public camera/style/layer operations. */
async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {boolean: ['read-idle', 'assert-stable'], default: {runs: 1, journeys: 'camera,styles', layers: 'all'}});
    assert.ok(args.output, 'Use a new --output directory');
    const output = resolve(String(args.output));
    const journeys = String(args.journeys).split(',');
    assert.ok(journeys.every(journey => ['camera', 'styles', 'full', 'repaint'].includes(journey)));
    assert.ok(Number.isSafeInteger(Number(args.runs)) && Number(args.runs) > 0);
    const layers = String(args.layers).split(',');
    assert.ok(layers.every(layer => ['all', 'background', 'land', 'water', 'buildings', 'roads', 'density', 'pois', 'poi-labels', 'street-labels'].includes(layer)));
    assert.ok(!layers.includes('all') || layers.length === 1);
    assert.ok(layers.includes('all') || journeys.every(journey => ['camera', 'repaint'].includes(journey)), 'Layer ablations cannot reset visibility after a style journey: that would mask the terminal frame');
    mkdirSync(output, {recursive: false});
    const files = new Map<string, {bytes: Buffer; mime: string}>();
    const manifest: Record<string, {bytes: number; sha256: string}> = {};
    function add(url: string, path: string, mime: string): void {
        const bytes = readFileSync(path);
        files.set(url, {bytes, mime});
        manifest[path] = {bytes: bytes.length, sha256: sha256(bytes)};
    }
    for (const name of ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl.css']) {
        add(`/dist/${name}`, `dist/${name}`, name.endsWith('.css') ? 'text/css' : 'text/javascript');
    }
    add('/', 'test/bench/e2e/index.html', 'text/html');
    for (const x of [8802, 8803]) for (const y of [5374, 5375]) for (const encoding of ['mvt', 'mlt']) {
        const name = `14-${x}-${y}.${encoding}`;
        add(`/tiles/${encoding}/${name}`, `test/integration/assets/tiles/${encoding === 'mlt' ? 'mlt/gl-js/' : ''}${name}`, 'application/octet-stream');
    }
    for (const prefix of ['', '-alt']) {
        for (const range of ['0-255', '256-511', '8192-8447']) {
            const path = `Open Sans Semibold,Arial Unicode MS Bold/${range}.pbf`;
            add(`/glyphs${prefix}/${path}`, `test/integration/assets/glyphs/${path}`, 'application/octet-stream');
        }
        for (const extension of ['json', 'png']) add(`/sprites${prefix}/sprite.${extension}`, `test/integration/assets/sprites/sprite.${extension}`,
            extension === 'json' ? 'application/json' : 'image/png');
    }
    const server = createServer((request, response) => {
        const path = decodeURI(new URL(request.url, 'http://localhost').pathname);
        const file = files.get(path);
        if (!file) { response.writeHead(path === '/favicon.ico' ? 204 : 404); response.end(); return; }
        response.writeHead(200, {'Content-Type': file.mime, 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'"});
        response.end(file.bytes);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const result = {status: 'running', startedAt: new Date().toISOString(), gpuMode: process.env.PUPPETEER_GPU ?? 'software',
        manifest, harnessHashes: Object.fromEntries(['test/bench/e2e/mlt-render-isolation.ts', 'test/bench/e2e/mlt-lifecycle-page.ts'].map(path => [path, sha256(readFileSync(path))])),
        git: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        productDiff: execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}), layers, readIdle: args['read-idle'], assertStable: args['assert-stable'], sessions: [] as unknown[]};
    const browser = await launchPuppeteer();
    function save(): void { writeFileSync(`${output}/results.json`, `${JSON.stringify(result, null, 2)}\n`); }
    try {
        for (let run = 1; run <= Number(args.runs); run++) for (const journey of journeys) for (const encoding of ['mvt', 'mlt'] as const) {
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(String(error)));
            page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()}: ${response.url()}`); });
            page.on('request', request => {
                if (!request.url().startsWith(`${origin}/`) && !request.url().startsWith('blob:')) errors.push(`Non-local request: ${request.url()}`);
            });
            try {
                await page.setViewport({width: 800, height: 600, deviceScaleFactor: 1});
                await page.setCacheEnabled(false);
                await page.goto(origin);
                await page.addStyleTag({content: '#map {width:800px;height:600px}'});
                await page.addStyleTag({url: `${origin}/dist/maplibre-gl.css`});
                const info = await page.evaluate(installScenario, {encoding, origin, scenario: 'styles' as const});
                assert.equal(page.workers().length, 1);
                const observations = [];
                const rawFrames: Buffer[] = [];
                const screenshots: Buffer[] = [];
                const beforeScreenshots: Buffer[] = [];
                function topDownPixels(pixels: number[]): Buffer {
                    const raw = Buffer.from(pixels);
                    const topDown = Buffer.alloc(raw.length);
                    for (let row = 0; row < 600; row++) raw.copy(topDown, row * 3200, (599 - row) * 3200, (600 - row) * 3200);
                    return topDown;
                }
                function writePNG(path: string, pixels: Buffer): void {
                    const image = new PNG({width: 800, height: 600});
                    image.data = pixels;
                    writeFileSync(path, PNG.sync.write(image));
                }
                async function capture(name: string, idle?: RenderObservation): Promise<void> {
                    const prefix = `${encoding}-${journey}-${run}-${name}`;
                    const before = PNG.sync.read(Buffer.from(await page.screenshot({path: `${output}/${prefix}-before-screen.png`}))).data;
                    const observation = await page.evaluate(() => (window as ScenarioWindow).mltScenario.observeRender());
                    const topDown = topDownPixels(observation.pixels);
                    writePNG(`${output}/${prefix}-raw.png`, topDown);
                    const idlePixels = idle ? topDownPixels(idle.pixels) : undefined;
                    if (idle) writePNG(`${output}/${prefix}-idle-raw.png`, idlePixels);
                    const screenshot = PNG.sync.read(Buffer.from(await page.screenshot({path: `${output}/${prefix}-screen.png`}))).data;
                    rawFrames.push(topDown);
                    screenshots.push(screenshot);
                    beforeScreenshots.push(before);
                    observations.push({name, camera: observation.camera, rawHash: sha256(topDown), screenshotHash: sha256(screenshot),
                        rawVsScreenshot: difference(topDown, screenshot), rawVsInitial: difference(rawFrames[0], topDown), screenVsInitial: difference(screenshots[0], screenshot),
                        beforeVsInitial: difference(beforeScreenshots[0], before), repaintDifference: difference(before, screenshot),
                        ...(idle ? {idleCamera: idle.camera, idleVsBefore: difference(idlePixels, before), idleVsInitial: difference(rawFrames[0], idlePixels)} : {})});
                }
                if (!layers.includes('all')) await page.evaluate(layers => (window as ScenarioWindow).mltScenario.isolateLayers(layers), layers);
                await capture('initial');
                const idle = await page.evaluate(async ({journey, readIdle}) => {
                    const scenario = (window as ScenarioWindow).mltScenario;
                    if (journey === 'full') {
                        await scenario.selectSymbol(true); await scenario.reload(); await scenario.selectSymbol(false);
                        await scenario.select(true); await scenario.reload(); await scenario.select(false);
                        await scenario.cycle(false); await scenario.visit(0); await scenario.visit(1); await scenario.visit(2);
                        await scenario.select(true); await scenario.selectSymbol(true);
                        for (const operation of ['direct', 'direct-restore', 'diff', 'restore', 'assets', 'rebuild'] as const) await scenario.mutateStyle(operation);
                        await scenario.select(true); await scenario.selectSymbol(true);
                        await scenario.mutateStyle('encoding'); await scenario.mutateStyle('restore');
                        await scenario.select(true); await scenario.selectSymbol(true);
                        await scenario.mutateStyle('empty'); await scenario.mutateStyle('restore');
                    }
                    if (journey === 'repaint') return;
                    await scenario.visit(0);
                    if (journey !== 'camera') { await scenario.mutateStyle('diff'); await scenario.mutateStyle('restore'); }
                    if (readIdle) return scenario.visitWithReadback(2);
                    await scenario.visit(2);
                }, {journey, readIdle: args['read-idle']});
                await capture('returned', idle);
                await capture('repainted');
                await page.evaluate(() => (window as ScenarioWindow).mltScenario.destroy());
                assert.deepEqual(errors, []);
                result.sessions.push({run, journey, encoding, info, observations});
                save();
                console.log(`${run} ${journey} ${encoding}: ${JSON.stringify(observations.map(row => ({name: row.name, raw: row.rawVsInitial,
                    screen: row.screenVsInitial, composition: row.rawVsScreenshot, before: row.beforeVsInitial, repaint: row.repaintDifference})))}`);
                if (args['assert-stable']) {
                    for (const observation of observations) {
                        for (const key of ['rawVsScreenshot', 'rawVsInitial', 'screenVsInitial', 'beforeVsInitial', 'repaintDifference', 'idleVsBefore', 'idleVsInitial']) {
                            if (observation[key]) assert.equal(observation[key].pixels, 0, `${encoding}/${journey}/${observation.name}/${key}`);
                        }
                        if (observation.idleCamera) assert.deepEqual(observation.camera, observation.idleCamera);
                    }
                }
            } finally { await page.close(); }
        }
        result.status = args['assert-stable'] ? 'stable' : 'diagnostic-complete';
    } catch (error) { result.status = 'failed'; throw error; }
    finally { save(); await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
