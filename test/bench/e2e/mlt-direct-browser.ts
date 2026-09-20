import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import minimist from 'minimist';
import type {Page} from 'puppeteer';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {localServer, sha256, signature, difference} from './mlt-geography.ts';
import {installScenario, type ScenarioWindow} from './mlt-lifecycle-page.ts';
import type {VectorTileSource} from '../../../dist/maplibre-gl';

/**
 * Measures uninstrumented production reload-to-render latency, separately from lazy queries and
 * post-GC memory. A render event marks CPU draw submission, not GPU completion or presentation.
 * Each variant has a fresh page; run order rotates to expose order effects without background tabs.
 */
async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {default: {runs: 3, samples: 20, warmup: 5}});
    assert.ok(args.output && args.reference, 'Pass a new --output and frozen --reference browser-dist directory');
    for (const value of [args.runs, args.samples, args.warmup]) assert.ok(Number.isSafeInteger(Number(value)) && Number(value) > 0);
    const output = resolve(String(args.output)); mkdirSync(output);
    for (const name of ['before', 'after']) mkdirSync(`${output}/${name}`);
    const servers = {
        before: await localServer(`${output}/before`, false, resolve(String(args.reference))),
        after: await localServer(`${output}/after`, false),
    };
    const report = {status: 'running', startedAt: new Date().toISOString(), options: args,
        browser: '', gpu: process.env.PUPPETEER_GPU ?? 'software',
        manifests: {before: servers.before.manifest, after: servers.after.manifest},
        productDiff: execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}),
        harnessHashes: Object.fromEntries(['mlt-direct-browser.ts', 'mlt-geography.ts', 'mlt-lifecycle-page.ts'].map(name =>
            [name, sha256(readFileSync(`test/bench/e2e/${name}`))])),
        sessions: [] as Record<string, unknown>[], error: undefined as string | undefined,
        limitation: 'Local HTTP, reload-to-first-render with fully loaded source, not GPU execution/presentation time; queries and forced-GC memory sampled separately. Historical cold/warm labels mean unique/reused URLs, not decoded-content cache state: content-addressed implementations may reuse identical bytes across URLs. firstOverzoom measures the first overzoom in a fresh map/worker after native-zoom setup, before warmups.'};
    const browser = await launchPuppeteer();
    const variants = [{version: 'before', encoding: 'mvt'}, {version: 'before', encoding: 'mlt'},
        {version: 'after', encoding: 'mvt'}, {version: 'after', encoding: 'mlt'}] as const;
    let expected: {source: string; rendered: string}; let expectedImage: string;
    function save(): void { writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2)); }
    try {
        report.browser = await browser.version();
        for (let run = 0; run < Number(args.runs); run++) {
            for (const variant of [...variants.slice(run % 4), ...variants.slice(0, run % 4)]) {
                const {version, encoding} = variant; const server = servers[version];
                const page = await browser.newPage(); const errors: string[] = [];
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
                    const info = await page.evaluate(installScenario, {encoding, origin: server.origin});
                    if (report.gpu === 'hardware') assert.doesNotMatch(info.renderer, /swiftshader|llvmpipe|software/i);
                    const first = await page.evaluate(firstOverzoomAndQuery);
                    const firstHashes = {source: signature(first.queries.source), rendered: signature(first.queries.rendered)};
                    expected ??= firstHashes; assert.deepEqual(firstHashes, expected, `${version}/${encoding}/first-overzoom`);
                    const firstOverzoom = {...first.times, counts: first.counts, hashes: firstHashes};
                    const rows = []; const memory = [];
                    for (let iteration = -Number(args.warmup); iteration < Number(args.samples); iteration++) {
                        for (const cache of iteration % 2 ? ['cold', 'warm'] : ['warm', 'cold']) {
                            const sample = await page.evaluate(reloadAndQuery, {encoding, origin: server.origin, cache, iteration});
                            const actual = {source: signature(sample.queries.source), rendered: signature(sample.queries.rendered)};
                            expected ??= actual; assert.deepEqual(actual, expected, `${version}/${encoding}/${cache}/${iteration}`);
                            if (iteration >= 0) rows.push({iteration, cache, ...sample.times, counts: sample.counts, hashes: actual});
                        }
                        if (iteration === -1 || (iteration + 1) % 10 === 0 || iteration === Number(args.samples) - 1) {
                            memory.push({phase: 'loaded', iteration, heaps: await heaps(page)});
                        }
                    }
                    const image = `${output}/${version}-${encoding}-${run}.png`;
                    const element = await page.$('#map'); await element.screenshot({path: image});
                    expectedImage ??= image; assert.equal(difference(expectedImage, image).pixels, 0);
                    await page.evaluate(() => (window as ScenarioWindow).mltScenario.removeSource());
                    memory.push({phase: 'source-removed', heaps: await heaps(page)});
                    await page.evaluate(() => (window as ScenarioWindow).mltScenario.destroy());
                    memory.push({phase: 'map-removed', heaps: await heaps(page)});
                    assert.deepEqual(errors, []);
                    report.sessions.push({run, version, encoding, info, firstOverzoom, rows, memory, image, requests: {...server.requests}});
                    save(); console.log(`direct browser ${run + 1}/${args.runs}: ${version}/${encoding} passed`);
                } finally { await page.close(); }
            }
        }
        report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
    finally { save(); await browser.close(); await servers.before.close(); await servers.after.close(); }
}

/** First overzoom in a fresh worker; native-zoom setup is deliberately outside this interval. */
async function firstOverzoomAndQuery() {
    const scenario = (window as ScenarioWindow).mltScenario; const map = scenario.getMap();
    let firstRenderMs: number;
    const started = performance.now();
    function render(): void {
        if (map.isSourceLoaded('corpus') && map.loaded()) firstRenderMs ??= performance.now() - started;
    }
    map.on('render', render);
    try { await scenario.visit(0); } finally { map.off('render', render); }
    const idleMs = performance.now() - started;
    if (firstRenderMs === undefined) throw new Error('First overzoom did not produce a loaded render');
    const queryStart = performance.now(); const queries = scenario.queryJSON(); const firstQueryMs = performance.now() - queryStart;
    if (!queries.source.length || !queries.rendered.length) throw new Error('Empty first-overzoom queries');
    return {times: {firstRenderMs, idleMs, firstQueryMs}, queries, counts: {source: queries.source.length, rendered: queries.rendered.length}};
}

/** Browser-side measurement excludes query construction from render latency and hashes from both timers. */
async function reloadAndQuery(options: {origin: string; encoding: string; cache: string; iteration: number}) {
    const scenario = (window as ScenarioWindow).mltScenario; const map = scenario.getMap();
    let contentEvents = 0; let firstRenderMs: number;
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Reload did not reach a loaded render')); }, 15000);
        function data(event): void { if (event.sourceId === 'corpus' && event.sourceDataType === 'content') contentEvents++; }
        function render(): void {
            if (contentEvents && map.isSourceLoaded('corpus') && map.loaded()) firstRenderMs ??= performance.now() - started;
        }
        function idle(): void { if (firstRenderMs !== undefined) { cleanup(); resolve(); } }
        function cleanup(): void { clearTimeout(timer); map.off('sourcedata', data); map.off('render', render); map.off('idle', idle); }
        map.on('sourcedata', data); map.on('render', render); map.on('idle', idle);
        const key = options.cache === 'warm' ? 'warm' : `cold-${options.iteration}`;
        (map.getSource('corpus') as VectorTileSource).setTiles([`${options.origin}/tiles/${options.encoding}/{z}-{x}-{y}.${options.encoding}?direct=${key}`]);
    });
    const idleMs = performance.now() - started;
    const queryStart = performance.now(); const queries = scenario.queryJSON(); const firstQueryMs = performance.now() - queryStart;
    if (!queries.source.length || !queries.rendered.length) throw new Error('Empty queries');
    return {times: {firstRenderMs, idleMs, firstQueryMs}, queries, counts: {source: queries.source.length, rendered: queries.rendered.length}};
}

/** Separate V8 heaps/backing storage after forced collection; this is not a GPU memory measurement. */
async function heaps(page: Page) {
    const main = await page.createCDPSession(); const clients = [main, ...page.workers().map(worker => worker.client)];
    const result = [];
    try {
        for (const client of clients) {
            await client.send('HeapProfiler.collectGarbage');
            result.push(await client.send('Runtime.getHeapUsage'));
        }
        return {main: result[0], workers: result.slice(1)};
    } finally { await main.detach(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
