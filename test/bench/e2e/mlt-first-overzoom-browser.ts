import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import minimist from 'minimist';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {localServer, sha256, signature, difference} from './mlt-geography.ts';
import {installScenario, type ScenarioWindow} from './mlt-lifecycle-page.ts';

const variants = [{version: 'before', encoding: 'mvt'}, {version: 'before', encoding: 'mlt'},
    {version: 'after', encoding: 'mvt'}, {version: 'after', encoding: 'mlt'}] as const;

/** Repeats a first overzoom in fresh maps/workers, rather than relabeling content-cache hits as cold loads. */
async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {default: {runs: 12}});
    if (args.verify) { verify(resolve(String(args.verify))); return; }
    assert.ok(args.output && args.reference, 'Pass a new --output and a frozen --reference dist directory');
    const runs = Number(args.runs); assert.ok(Number.isInteger(runs) && runs >= 12 && runs % 4 === 0);
    const output = resolve(String(args.output)); mkdirSync(output);
    for (const version of ['before', 'after']) mkdirSync(`${output}/${version}`);
    const servers = {before: await localServer(`${output}/before`, false, resolve(String(args.reference))),
        after: await localServer(`${output}/after`, false)};
    const report = {status: 'running', startedAt: new Date().toISOString(), runs,
        gpu: process.env.PUPPETEER_GPU ?? 'software', browser: '',
        manifests: {before: servers.before.manifest, after: servers.after.manifest},
        harnessHashes: Object.fromEntries(['mlt-first-overzoom-browser.ts', 'mlt-geography.ts', 'mlt-lifecycle-page.ts'].map(name =>
            [name, sha256(readFileSync(`test/bench/e2e/${name}`))])),
        sessions: [], error: undefined as string | undefined,
        limitation: 'Local Berlin base style, one worker, fresh map per observation. Native map/style setup is excluded; first overzoom has no earlier child geometry in that worker. Render event means CPU draw submission, not GPU completion or presentation. Queries, gzip and PNG capture are outside render timing. No warmed-up cold-load loop or retained-memory claim.'};
    const browser = await launchPuppeteer();
    function save(): void { writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2)); }
    try {
        report.browser = await browser.version();
        for (let run = 0; run < runs; run++) {
            for (const {version, encoding} of [...variants.slice(run % 4), ...variants.slice(0, run % 4)]) {
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
                    const info = await page.evaluate(installScenario, {encoding, origin: server.origin, scenario: 'base' as const});
                    if (report.gpu === 'hardware') assert.doesNotMatch(info.renderer, /swiftshader|llvmpipe|software/i);
                    assert.equal(page.workers().length, 1);
                    const {times, queries} = await page.evaluate(measure);
                    const hashes = queryHashes(queries);
                    if (report.sessions.length) assert.deepEqual(hashes, report.sessions[0].hashes);
                    const prefix = `${output}/${run}-${version}-${encoding}`;
                    writeFileSync(`${prefix}.json.gz`, gzipSync(JSON.stringify(queries)));
                    await (await page.$('#map')).screenshot({path: `${prefix}.png`});
                    if (report.sessions.length) assert.equal(difference(`${prefix}.png`, report.sessions[0].image).pixels, 0);
                    await page.evaluate(() => (window as ScenarioWindow).mltScenario.destroy());
                    assert.deepEqual(errors, []);
                    report.sessions.push({run, version, encoding, info, times, hashes, image: `${prefix}.png`, queries: `${prefix}.json.gz`}); save();
                } finally { await page.close(); }
            }
            console.log(`first overzoom ${run + 1}/${runs}: all four conditions passed`);
        }
        report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
    finally { save(); await browser.close(); await servers.before.close(); await servers.after.close(); }
    verify(output);
}

/** Starts on the public camera action and stops at the first fully loaded drawing event. */
async function measure() {
    const scenario = (window as ScenarioWindow).mltScenario; const map = scenario.getMap();
    let firstRenderMs: number; const start = performance.now();
    function render(): void { if (map.isSourceLoaded('corpus') && map.loaded()) firstRenderMs ??= performance.now() - start; }
    map.on('render', render);
    try { await scenario.visit(0); } finally { map.off('render', render); }
    if (firstRenderMs === undefined) throw new Error('No loaded render after first overzoom');
    const settledMs = performance.now() - start;
    const queryStart = performance.now(); const queries = scenario.queryJSON(); const queryMs = performance.now() - queryStart;
    return {times: {firstRenderMs, settledMs, queryMs}, queries};
}

function queryHashes(queries: {source: GeoJSON.Feature[]; rendered: GeoJSON.Feature[]}) {
    assert.ok(queries.source.length && queries.rendered.length);
    return {source: signature(queries.source), rendered: signature(queries.rendered),
        sourceCount: queries.source.length, renderedCount: queries.rendered.length};
}

/** Can run separately with --verify; recomputes all archived images, full queries, inputs and order checks. */
function verify(output: string): void {
    const report = JSON.parse(readFileSync(`${output}/results.json`, 'utf8'));
    assert.equal(report.status, 'passed'); assert.ok(report.runs >= 12 && report.runs % 4 === 0);
    assert.equal(report.sessions.length, report.runs * 4);
    for (const manifest of Object.values(report.manifests) as Record<string, {sha256: string}>[]) {
        for (const [path, expected] of Object.entries(manifest)) assert.equal(sha256(readFileSync(path)), expected.sha256);
    }
    for (const [name, hash] of Object.entries(report.harnessHashes)) assert.equal(sha256(readFileSync(`test/bench/e2e/${name}`)), hash);
    for (let index = 0; index < report.sessions.length; index++) {
        const session = report.sessions[index]; const run = Math.floor(index / 4);
        assert.equal(session.run, run);
        assert.deepEqual({version: session.version, encoding: session.encoding}, variants[(index % 4 + run) % 4]);
        for (const value of Object.values(session.times)) assert.ok(Number.isFinite(value) && Number(value) > 0);
        assert.deepEqual(queryHashes(JSON.parse(gunzipSync(readFileSync(session.queries)).toString())), report.sessions[0].hashes);
        assert.deepEqual(session.hashes, report.sessions[0].hashes);
        assert.equal(difference(session.image, report.sessions[0].image).pixels, 0);
    }
    const summary = variants.map(variant => {
        const sessions = report.sessions.filter(session => session.version === variant.version && session.encoding === variant.encoding);
        return {...variant, firstRenderMs: median(sessions.map(session => session.times.firstRenderMs)),
            queryMs: median(sessions.map(session => session.times.queryMs))};
    });
    console.log(JSON.stringify({status: 'verified-first-overzoom-comparison', sessions: report.sessions.length, summary}));
}

function median(values: number[]): number {
    const sorted = values.toSorted((a, b) => a - b); const mid = sorted.length >> 1;
    return (sorted[mid - 1] + sorted[mid]) / 2;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
