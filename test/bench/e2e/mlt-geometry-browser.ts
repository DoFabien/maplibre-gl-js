import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import minimist from 'minimist';
import type {Page} from 'puppeteer';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {localServer, sha256, signature, difference} from './mlt-geography.ts';
import {installScenario, type ScenarioWindow} from './mlt-lifecycle-page.ts';

type Phase = 'native' | 'overzoom';
type Timing = {firstRenderMs: number; settledMs: number; queryMs: number};
type Capture = {hashes: {source: string; rendered: string}; counts: {source: number; rendered: number}};
type PhaseResult = {phase: Phase; first: Timing & Capture; rows: Array<Timing & Capture>; image: string; queries: string; heaps: unknown};
type Session = {run: number; version: string; encoding: string; info: unknown; phases: PhaseResult[]};

/** Measures unchanged public actions in before/after production builds at native zoom and overzoom, without profiling. */
async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {default: {runs: 3, samples: 20, warmup: 5, scenario: 'base'}});
    assert.ok(args.output && args.reference, 'Pass a new --output and a frozen --reference dist directory');
    assert.ok(['base', 'symbols'].includes(args.scenario));
    for (const value of [args.runs, args.samples, args.warmup]) assert.ok(Number.isSafeInteger(Number(value)) && Number(value) > 0);
    const output = resolve(String(args.output)); mkdirSync(output);
    for (const version of ['before', 'after']) mkdirSync(`${output}/${version}`);
    const servers = {before: await localServer(`${output}/before`, false, resolve(String(args.reference))),
        after: await localServer(`${output}/after`, false)};
    const report = {status: 'running', startedAt: new Date().toISOString(), options: args,
        browser: '', gpu: process.env.PUPPETEER_GPU ?? 'software',
        manifests: {before: servers.before.manifest, after: servers.after.manifest},
        harnessHashes: Object.fromEntries(['mlt-geometry-browser.ts', 'mlt-geography.ts', 'mlt-lifecycle-page.ts'].map(name =>
            [name, sha256(readFileSync(`test/bench/e2e/${name}`))])),
        productDiff: execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}),
        sessions: [] as Session[], summary: [] as unknown[], error: undefined as string | undefined,
        limitation: 'Local fixed corpus. Render marks CPU draw submission, not GPU completion or presentation. Initial map/style/glyph setup is excluded. Native reloads decode fresh tables; overzoom reloads change URLs but reuse identical content. Settled time includes the scenario stability fence, not only the idle event. Queries, hashing, PNGs and forced-GC memory are outside render timing. First samples have only one observation per session; no cold-start gain is inferred from them.'};
    const references = new Map<Phase, Capture>(); const images = new Map<Phase, string>();
    const browser = await launchPuppeteer();
    const variants = [{version: 'before', encoding: 'mvt'}, {version: 'before', encoding: 'mlt'},
        {version: 'after', encoding: 'mvt'}, {version: 'after', encoding: 'mlt'}] as const;
    function save(): void { writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2)); }
    try {
        report.browser = await browser.version();
        for (let run = 0; run < Number(args.runs); run++) {
            const order = [...variants.slice(run % 4), ...variants.slice(0, run % 4)];
            for (const {version, encoding} of order) {
                const server = servers[version]; const page = await browser.newPage(); const errors: string[] = [];
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
                    const info = await page.evaluate(installScenario, {encoding, origin: server.origin, scenario: args.scenario});
                    if (report.gpu === 'hardware') assert.doesNotMatch(info.renderer, /swiftshader|llvmpipe|software/i);
                    assert.equal(page.workers().length, 1);
                    const phases: PhaseResult[] = [];
                    for (const phase of ['native', 'overzoom'] as const) {
                        const first = verifySample(await page.evaluate(measure, phase === 'overzoom' ? 'visit' : 'reload'), phase, references);
                        const rows = [];
                        for (let iteration = -Number(args.warmup); iteration < Number(args.samples); iteration++) {
                            const row = verifySample(await page.evaluate(measure, 'reload'), phase, references);
                            if (iteration >= 0) rows.push(row);
                        }
                        const queries = `${output}/${version}-${encoding}-${run}-${phase}.json.gz`;
                        const values = await page.evaluate(() => (window as ScenarioWindow).mltScenario.queryJSON());
                        assert.deepEqual(queryCapture(values), references.get(phase));
                        writeFileSync(queries, gzipSync(JSON.stringify(values)));
                        const image = `${output}/${version}-${encoding}-${run}-${phase}.png`;
                        await (await page.$('#map')).screenshot({path: image});
                        if (images.has(phase)) assert.equal(difference(image, images.get(phase)).pixels, 0);
                        else images.set(phase, image);
                        phases.push({phase, first, rows, image, queries, heaps: await heaps(page)});
                    }
                    await page.evaluate(() => (window as ScenarioWindow).mltScenario.destroy());
                    assert.deepEqual(errors, []);
                    report.sessions.push({run, version, encoding, info, phases}); save();
                    console.log(`geometry browser ${run + 1}/${args.runs}: ${version}/${encoding} passed`);
                } finally { await page.close(); }
            }
        }
        for (const manifest of Object.values(report.manifests)) {
            for (const [path, expected] of Object.entries(manifest)) assert.equal(sha256(readFileSync(path)), expected.sha256);
        }
        for (const variant of variants) for (const phase of ['native', 'overzoom'] as const) {
            const sessions = report.sessions.filter(session => session.version === variant.version && session.encoding === variant.encoding);
            const sessionMedians = sessions.map(session => {
                const rows = session.phases.find(item => item.phase === phase).rows;
                return Object.fromEntries(['firstRenderMs', 'settledMs', 'queryMs'].map(key => [key, median(rows.map(row => row[key]))]));
            });
            report.summary.push({...variant, phase, sessionMedians, medianOfSessionMedians:
                Object.fromEntries(Object.keys(sessionMedians[0]).map(key => [key, median(sessionMedians.map(row => row[key]))]))});
        }
        report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
    finally { save(); await browser.close(); await servers.before.close(); await servers.after.close(); }
}

/** Browser-side timing stops before complete public queries; reloads must have produced new source content. */
async function measure(action: 'reload' | 'visit') {
    const scenario = (window as ScenarioWindow).mltScenario; const map = scenario.getMap();
    let firstRenderMs: number; let content = false;
    const start = performance.now();
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

function queryCapture(queries: {source: GeoJSON.Feature[]; rendered: GeoJSON.Feature[]}): Capture {
    assert.ok(queries.source.length && queries.rendered.length);
    return {hashes: {source: signature(queries.source), rendered: signature(queries.rendered)},
        counts: {source: queries.source.length, rendered: queries.rendered.length}};
}

function verifySample(sample: Awaited<ReturnType<typeof measure>>, phase: Phase, references: Map<Phase, Capture>): Timing & Capture {
    const capture = queryCapture(sample.queries);
    if (references.has(phase)) assert.deepEqual(capture, references.get(phase)); else references.set(phase, capture);
    for (const value of Object.values(sample.times)) assert.ok(Number.isFinite(value) && value > 0);
    return {...sample.times, ...capture};
}

/** Samples retained V8 heap/backing storage after a phase, outside timing; this excludes GPU memory. */
async function heaps(page: Page) {
    const main = await page.createCDPSession(); const result = [];
    try {
        for (const client of [main, ...page.workers().map(worker => worker.client)]) {
            await client.send('HeapProfiler.collectGarbage'); result.push(await client.send('Runtime.getHeapUsage'));
        }
    } finally { await main.detach(); }
    return {main: result[0], workers: result.slice(1)};
}

function median(values: number[]): number {
    const sorted = values.toSorted((a, b) => a - b);
    assert.ok(sorted.length && sorted.every(Number.isFinite));
    return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
