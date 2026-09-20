import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import minimist from 'minimist';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import type {Protocol} from 'devtools-protocol';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {localServer, sha256, signature, difference} from './mlt-geography.ts';
import {installScenario, type ScenarioWindow} from './mlt-lifecycle-page.ts';

type Version = 'before' | 'after';
type AllocationSummary = ReturnType<typeof summarize>;
type Session = {run: number; version: Version; encoding: 'mvt' | 'mlt'; renderer: string;
    profiles: Array<{context: string; file: string; sha256: string; summary: AllocationSummary}>;
    queries: string; image: string; hashes: Record<string, string>};

/** Samples allocations including collected objects; timings under this profiler are deliberately not reported. */
async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {default: {runs: 4, repeats: 10, warmup: 5, interval: 16384}});
    if (args.verify) { verify(resolve(String(args.verify))); return; }
    assert.ok(args.output && args.reference, 'Pass new --output and frozen --reference dist directories');
    for (const key of ['runs', 'repeats', 'warmup', 'interval']) assert.ok(Number.isSafeInteger(args[key]) && args[key] > 0);
    const output = resolve(String(args.output)); mkdirSync(output);
    for (const version of ['before', 'after']) mkdirSync(`${output}/${version}`);
    const servers = {before: await localServer(`${output}/before`, false, resolve(String(args.reference))),
        after: await localServer(`${output}/after`, false)};
    const mapFiles: Record<Version, Record<string, {path: string; sha256: string}>> = {before: {}, after: {}};
    const maps = {before: new Map<string, TraceMap>(), after: new Map<string, TraceMap>()};
    for (const version of ['before', 'after'] as const) {
        for (const path of Object.keys(servers[version].manifest).filter(path => path.endsWith('.mjs'))) {
            const url = `${servers[version].origin}/dist/${path.split('/').at(-1)}`;
            const bytes = readFileSync(`${path}.map`);
            maps[version].set(url, new TraceMap(JSON.parse(bytes.toString())));
            mapFiles[version][url] = {path: `${path}.map`, sha256: sha256(bytes)};
        }
    }
    const report = {status: 'running', startedAt: new Date().toISOString(), options: args,
        browser: '', gpu: process.env.PUPPETEER_GPU ?? 'software',
        manifests: {before: servers.before.manifest, after: servers.after.manifest}, mapFiles,
        harnessHashes: Object.fromEntries(['mlt-allocation-profile.ts', 'mlt-geography.ts', 'mlt-lifecycle-page.ts'].map(name =>
            [name, sha256(readFileSync(`test/bench/e2e/${name}`))])),
        sessions: [] as Session[], error: undefined as string | undefined,
        limitation: 'Poisson-sampled V8 allocation estimates, including objects collected by minor and major GC. Not exact byte counts, retained or peak heap, GPU memory, or latency. Warm native reloads on the fixed base corpus; initial setup, warmup, public queries and screenshots excluded. Inclusive stack costs overlap and must not be summed.'};
    const variants = [{version: 'before', encoding: 'mvt'}, {version: 'before', encoding: 'mlt'},
        {version: 'after', encoding: 'mvt'}, {version: 'after', encoding: 'mlt'}] as const;
    const browser = await launchPuppeteer();
    function save(): void { writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2)); }
    try {
        report.browser = await browser.version();
        for (let run = 0; run < args.runs; run++) {
            for (const {version, encoding} of [...variants.slice(run % 4), ...variants.slice(0, run % 4)]) {
                const server = servers[version]; const page = await browser.newPage(); const errors: string[] = [];
                page.on('pageerror', error => errors.push(String(error)));
                page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}`); });
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
                    await page.evaluate(reload, args.warmup);
                    const mainClient = await page.createCDPSession();
                    const clients = [{context: 'main', client: mainClient}, {context: 'worker', client: page.workers()[0].client}];
                    const profiles: Session['profiles'] = [];
                    try {
                        for (const {client} of clients) {
                            await client.send('HeapProfiler.collectGarbage');
                            await client.send('HeapProfiler.startSampling', {samplingInterval: args.interval,
                                includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true});
                        }
                        await page.evaluate(reload, args.repeats);
                        for (const {context, client} of clients) {
                            const {profile} = await client.send('HeapProfiler.stopSampling');
                            const file = `${output}/${version}-${encoding}-${run}-${context}.heapprofile.gz`;
                            const bytes = gzipSync(JSON.stringify(profile)); writeFileSync(file, bytes);
                            profiles.push({context, file, sha256: sha256(bytes), summary: summarize(profile, maps[version])});
                        }
                    } finally { await mainClient.detach(); }
                    const queries = `${output}/${version}-${encoding}-${run}.json.gz`;
                    const values = await page.evaluate(() => (window as ScenarioWindow).mltScenario.queryJSON());
                    writeFileSync(queries, gzipSync(JSON.stringify(values)));
                    const hashes = Object.fromEntries(Object.entries(values).map(([key, features]) => {
                        assert.ok(features.length); return [key, signature(features)];
                    }));
                    const image = `${output}/${version}-${encoding}-${run}.png`;
                    await (await page.$('#map')).screenshot({path: image});
                    if (report.sessions.length) {
                        assert.deepEqual(hashes, report.sessions[0].hashes);
                        assert.equal(difference(image, report.sessions[0].image).pixels, 0);
                    }
                    await page.evaluate(() => (window as ScenarioWindow).mltScenario.destroy());
                    assert.deepEqual(errors, []);
                    report.sessions.push({run, version, encoding, renderer: info.renderer, profiles, queries, image, hashes}); save();
                    console.log(`allocation profile ${run + 1}/${args.runs}: ${version}/${encoding} passed`);
                } finally { await page.close(); }
            }
        }
        report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
    finally { save(); await browser.close(); await servers.before.close(); await servers.after.close(); }
    verify(output);
}

/** Reloads source content through the public scenario without materializing query output. */
async function reload(repeats: number): Promise<void> {
    for (let index = 0; index < repeats; index++) await (window as ScenarioWindow).mltScenario.reload();
}

/** Attributes estimated allocations to exact source-map locations and retains self and non-additive inclusive totals. */
function summarize(profile: Protocol.HeapProfiler.SamplingHeapProfile, maps: Map<string, TraceMap>) {
    const self: Record<string, number> = {}; const inclusive: Record<string, number> = {};
    function visit(node: Protocol.HeapProfiler.SamplingHeapProfileNode): number {
        const frame = node.callFrame; const map = maps.get(frame.url);
        const source = map && frame.lineNumber >= 0 ? originalPositionFor(map, {line: frame.lineNumber + 1, column: frame.columnNumber}) : undefined;
        const label = source?.source ? `${source.source}:${source.line} ${source.name ?? frame.functionName}` : frame.functionName || frame.url;
        self[label] = (self[label] ?? 0) + node.selfSize;
        const bytes = node.selfSize + node.children.reduce((sum, child) => sum + visit(child), 0);
        inclusive[label] = (inclusive[label] ?? 0) + bytes;
        return bytes;
    }
    const totalBytes = visit(profile.head);
    assert.ok(totalBytes > 0 && profile.samples.length > 0);
    return {totalBytes, samples: profile.samples.length,
        selfBytes: Object.fromEntries(Object.entries(self).sort((a, b) => b[1] - a[1])),
        inclusiveBytes: Object.fromEntries(Object.entries(inclusive).sort((a, b) => b[1] - a[1]))};
}

/** Recomputes every stored profile summary, public query signature and image comparison against the captured inputs. */
function verify(directory: string): void {
    const report = JSON.parse(readFileSync(`${directory}/results.json`, 'utf8'));
    assert.equal(report.status, 'passed'); assert.equal(report.sessions.length, report.options.runs * 4);
    for (const files of Object.values(report.manifests) as Array<Record<string, {sha256: string}>>) {
        for (const [path, expected] of Object.entries(files)) assert.equal(sha256(readFileSync(path)), expected.sha256, path);
    }
    for (const [name, expected] of Object.entries(report.harnessHashes)) assert.equal(sha256(readFileSync(`test/bench/e2e/${name}`)), expected);
    const maps = {before: new Map<string, TraceMap>(), after: new Map<string, TraceMap>()};
    for (const version of ['before', 'after'] as const) {
        for (const [url, file] of Object.entries(report.mapFiles[version]) as Array<[string, {path: string; sha256: string}]>) {
            const bytes = readFileSync(file.path); assert.equal(sha256(bytes), file.sha256);
            maps[version].set(url, new TraceMap(JSON.parse(bytes.toString())));
        }
    }
    const variants = ['before/mvt', 'before/mlt', 'after/mvt', 'after/mlt'];
    for (let run = 0; run < report.options.runs; run++) {
        assert.deepEqual(report.sessions.filter((session: Session) => session.run === run).map((session: Session) => `${session.version}/${session.encoding}`),
            [...variants.slice(run % 4), ...variants.slice(0, run % 4)]);
    }
    for (const session of report.sessions as Session[]) {
        assert.deepEqual(session.profiles.map(profile => profile.context), ['main', 'worker']);
        for (const profile of session.profiles) {
            const bytes = readFileSync(profile.file); assert.equal(sha256(bytes), profile.sha256);
            assert.deepEqual(summarize(JSON.parse(gunzipSync(bytes).toString()), maps[session.version]), profile.summary);
        }
        const queries = JSON.parse(gunzipSync(readFileSync(session.queries)).toString());
        for (const key of ['source', 'rendered']) assert.equal(signature(queries[key]), session.hashes[key]);
        assert.deepEqual(session.hashes, report.sessions[0].hashes);
        assert.equal(difference(session.image, report.sessions[0].image).pixels, 0);
    }
    console.log(`Verified ${report.sessions.length} allocation sessions, raw profiles, maps, inputs, images and queries`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
