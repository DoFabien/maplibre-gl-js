import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {cpus, arch, platform, release} from 'node:os';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import minimist from 'minimist';
import {PNG} from 'pngjs';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {sha256, signature, difference, workerStats} from './mlt-geography.ts';
import {navigationServer} from './mlt-navigation-server.ts';
import {installNavigation, type NavigationWindow} from './mlt-navigation-page.ts';
import {navigationRoute, summarizePass} from './mlt-navigation-protocol.ts';

/** Compares unchanged production rendering on a continuous multi-tile journey, with parity isolated from timing. */
async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {boolean: ['strict', 'diagnostic-ids'], default: {mode: 'parity', runs: 1, network: 'lan'}});
    assert.ok(args.output && args.fixtures, 'Pass --fixtures and a new --output directory');
    assert.ok(['parity', 'timing'].includes(args.mode)); assert.ok(!args.strict || args.mode === 'parity');
    assert.ok(Number.isSafeInteger(args.runs) && args.runs > 0);
    const output = resolve(args.output); mkdirSync(output);
    const fixtures = resolve(args.fixtures); const corpus = JSON.parse(readFileSync(`${fixtures}/manifest.json`, 'utf8'));
    assert.equal(corpus.tiles.length, 42);
    assert.ok(corpus.tiles.every(tile => tile.layers.length && tile.layers.every(layer => layer.geometryPropertiesParity)));
    assert.ok(corpus.status === 'passed' || args['diagnostic-ids'], 'Input parity fails: require explicit --diagnostic-ids for non-qualifying characterization');
    const network = args.network === 'lan' ? {name: 'lan', latencyMs: 0, bytesPerSecond: 0} :
        {name: '20mbps-40ms', latencyMs: 40, bytesPerSecond: 2500000};
    assert.ok(['lan', '20mbps-40ms'].includes(args.network));
    const bundle = args.strict ? 'dist/mlt-validation' : 'dist';
    const server = await navigationServer(fixtures, bundle, network);
    const harness = ['mlt-navigation.ts', 'mlt-navigation-page.ts', 'mlt-navigation-protocol.ts', 'mlt-navigation-server.ts'];
    mkdirSync(`${output}/harness`);
    for (const name of harness) writeFileSync(`${output}/harness/${name}`, readFileSync(`test/bench/e2e/${name}`));
    const sourcePaths = execFileSync('rg', ['--files', 'src', '../maplibre-tile-spec/ts/src'], {encoding: 'utf8'}).trim().split('\n').sort();
    const report = {status: 'running', startedAt: new Date().toISOString(), finishedAt: '', args, network,
        input: {path: `${fixtures}/manifest.json`, hash: sha256(readFileSync(`${fixtures}/manifest.json`)), status: corpus.status, failures: corpus.failures},
        environment: {node: process.version, cpu: cpus()[0].model, logicalCPUs: cpus().length, arch: arch(), platform: platform(), release: release(), gpu: process.env.PUPPETEER_GPU},
        route: navigationRoute, browser: '', manifests: server.hashes,
        sources: Object.fromEntries(sourcePaths.map(path => [path, sha256(readFileSync(path))])),
        harness: Object.fromEntries(harness.map(name => [name, sha256(readFileSync(`test/bench/e2e/${name}`))])),
        sessions: [] as any[], comparisons: [] as any[], error: undefined as string | undefined,
        limitations: ['RAF and render events are scheduling/submission proxies, not physical presentation or GPU timings.',
            'Cold pass follows a freshly loaded initial view; it is not a guarantee that every request is a cache miss. Warm pass reuses the same map, worker and HTTP cache.',
            'The network model shares one downlink byte budget across gzip tiles, glyphs and sprites; it is not a recorded live network.',
            'Timing uses normal 300ms label fades; settled parity checkpoints disable fades and are not a transient-frame equivalence test.',
            'Input ID mismatches remain failures; diagnostic timings do not qualify full MVT parity. No IDs, geometry, properties or product source are changed.']};
    const references = new Map<string, any>();
    function save(): void { writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2)); }
    const browser = await launchPuppeteer();
    try {
        report.browser = await browser.version();
        for (let run = 0; run < args.runs; run++) {
            for (const encoding of (run % 2 ? ['mlt', 'mvt'] : ['mvt', 'mlt']) as ('mvt' | 'mlt')[]) {
                const context = await browser.createBrowserContext(); const page = await context.newPage();
                const errors: string[] = []; const failedRequests: string[] = [];
                page.on('pageerror', error => errors.push(String(error)));
                page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
                page.on('requestfailed', request => failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`));
                page.on('request', request => { if (!request.url().startsWith(`${server.origin}/`) && !request.url().startsWith('blob:')) errors.push(`Non-local request: ${request.url()}`); });
                const session = {run, encoding, info: undefined as any, initialTraffic: [] as any[], passes: [] as any[], checkpoints: [] as any[], stats: [] as any[], failedRequests};
                report.sessions.push(session); save();
                try {
                    await page.setViewport({width: 800, height: 600, deviceScaleFactor: 1});
                    await page.goto(server.origin); await page.bringToFront();
                    await page.addStyleTag({content: '#map {width:800px;height:600px}'});
                    await page.addStyleTag({url: `${server.origin}/dist/maplibre-gl.css`});
                    const initialTraffic = server.traffic.length;
                    const installed = await page.evaluate(installNavigation, {origin: server.origin, encoding, bundle: 'dist', route: navigationRoute, parity: args.mode === 'parity'});
                    session.info = installed.info; session.initialTraffic = server.traffic.slice(initialTraffic);
                    assert.equal(session.info.workerCount, 1); assert.deepEqual(session.info.canvas, [800, 600]);
                    if (process.env.PUPPETEER_GPU === 'hardware') assert.doesNotMatch(session.info.renderer, /swiftshader|llvmpipe|software/i);
                    if (args.mode === 'timing') {
                        for (const phase of ['cold', 'warm']) {
                            const trafficStart = server.traffic.length;
                            const raw = await page.evaluate(() => (window as unknown as NavigationWindow).navigationBench.run());
                            assert.ok(raw.visibility.every(value => value === 'visible'), 'Background session invalidates navigation timing');
                            assert.equal(raw.windows.length, navigationRoute.length - 1);
                            for (const [index, window] of raw.windows.entries()) assertPose(window.pose, index + 1);
                            session.passes.push({phase, raw, summary: summarizePass(raw), traffic: server.traffic.slice(trafficStart)});
                            save(); console.log(`${args.network} ${run + 1}/${args.runs} ${encoding} ${phase}: navigation completed`);
                        }
                    } else {
                        for (let index = 0; index < navigationRoute.length; index++) {
                            const captured = await page.evaluate(index => (window as unknown as NavigationWindow).navigationBench.checkpoint(index), index);
                            assertPose(captured.pose, index);
                            const name = `${encoding}-${run}-${index}`; const imagePath = `${output}/${name}.png`;
                            const bottomUp = Buffer.from(captured.pixels); const topDown = Buffer.alloc(bottomUp.length);
                            for (let row = 0; row < captured.height; row++) bottomUp.copy(topDown, row * captured.width * 4,
                                (captured.height - row - 1) * captured.width * 4, (captured.height - row) * captured.width * 4);
                            const png = new PNG({width: captured.width, height: captured.height});
                            png.data = topDown;
                            writeFileSync(imagePath, PNG.sync.write(png));
                            const queries = {rendered: captured.rendered, ...captured.sources};
                            writeFileSync(`${output}/${name}.json.gz`, gzipSync(JSON.stringify(queries)));
                            const summary = {index, pose: captured.pose, labelCounts: captured.labelCounts,
                                counts: Object.fromEntries(Object.entries(queries).map(([key, features]: [string, any[]]) => [key, features.length])),
                                hashes: Object.fromEntries(Object.entries(queries).map(([key, features]: [string, any[]]) => [key, signature(features)])),
                                withoutIdHashes: Object.fromEntries(Object.entries(queries).map(([key, features]: [string, any[]]) => [key, signature(features.map(({id, ...rest}) => rest))]))};
                            assert.ok(captured.labelCounts.places > 0, 'No visible place labels');
                            session.checkpoints.push(summary);
                            const reference = references.get(String(index));
                            if (reference) {
                                const pixels = difference(reference.imagePath, imagePath);
                                const queryEqual = JSON.stringify(reference.summary.hashes) === JSON.stringify(summary.hashes);
                                report.comparisons.push({index, run, encoding, pixels, fullQueriesEqual: queryEqual,
                                    excludingIdsEqual: JSON.stringify(reference.summary.withoutIdHashes) === JSON.stringify(summary.withoutIdHashes)});
                                assert.equal(pixels.pixels, 0, `${name}: pixel parity`);
                                assert.deepEqual(summary.counts, reference.summary.counts);
                                assert.deepEqual(summary.withoutIdHashes, reference.summary.withoutIdHashes, `${name}: non-ID query parity`);
                                if (corpus.status === 'passed') assert.ok(queryEqual, `${name}: full query parity`);
                            } else references.set(String(index), {imagePath, summary});
                            save();
                        }
                        session.stats = await workerStats(page, args.strict, encoding);
                        console.log(`${run + 1}/${args.runs} ${encoding}: all settled checkpoints captured`);
                    }
                    assert.deepEqual(errors, []); assert.deepEqual(server.misses, [], 'Corpus coverage or missing glyphs');
                    await page.evaluate(() => (window as unknown as NavigationWindow).navigationBench.destroy());
                } finally { await context.close(); save(); }
            }
        }
        for (const [path, hash] of Object.entries({...report.sources, ...report.manifests})) assert.equal(sha256(readFileSync(path)), hash, path);
        for (const [name, hash] of Object.entries(report.harness)) assert.equal(sha256(readFileSync(`test/bench/e2e/${name}`)), hash, name);
        report.status = corpus.status === 'passed' ? 'passed' : 'diagnostic-input-id-mismatch';
    } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
    finally { report.finishedAt = new Date().toISOString(); save(); await browser.close(); await server.close(); }
}

/** Allows only floating-point round-trip error in public camera coordinates, never a different route or zoom. */
function assertPose(actual: number[], index: number): void {
    const target = navigationRoute[index]; const expected = [...target.center, target.zoom, target.pitch, target.bearing];
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= 1e-9, `${target.name}: camera drift`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
