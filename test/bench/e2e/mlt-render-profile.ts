import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import minimist from 'minimist';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import type {CDPSession, Page} from 'puppeteer';
import type {Protocol} from 'devtools-protocol';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {localServer, sha256, signature, difference} from './mlt-geography.ts';
import {installScenario, type ScenarioWindow} from './mlt-lifecycle-page.ts';

type Phase = 'native-reload' | 'first-overzoom' | 'warm-overzoom';

/** Profiles production CPU work in both execution contexts; query construction and image readback are outside profiles. */
async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2), {default: {runs: 2, repeats: 5, scenario: 'symbols'}});
    assert.ok(args.output, 'Pass a new --output directory');
    assert.ok(['base', 'symbols'].includes(args.scenario));
    for (const value of [args.runs, args.repeats]) assert.ok(Number.isSafeInteger(Number(value)) && Number(value) > 0);
    const output = resolve(String(args.output)); mkdirSync(output);
    const server = await localServer(output, false);
    const maps = new Map<string, TraceMap>();
    const mapHashes: Record<string, string> = {};
    for (const name of ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
        const path = `dist/${name}.map`; const bytes = readFileSync(path);
        maps.set(`${server.origin}/dist/${name}`, new TraceMap(JSON.parse(bytes.toString())));
        mapHashes[path] = sha256(bytes);
    }
    const report = {status: 'running', startedAt: new Date().toISOString(), options: args,
        browser: '', gpu: process.env.PUPPETEER_GPU ?? 'software', manifest: server.manifest, mapHashes,
        harnessHashes: Object.fromEntries(['mlt-render-profile.ts', 'mlt-geography.ts', 'mlt-lifecycle-page.ts'].map(name =>
            [name, sha256(readFileSync(`test/bench/e2e/${name}`))])),
        productDiff: execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}),
        sessions: [] as Record<string, unknown>[], error: undefined as string | undefined,
        limitation: 'Diagnostic CPU samples, not a benchmark or GPU execution time. Initial map/style/glyph setup is outside profiles. Native reload decodes fresh tables in a warm map; first overzoom starts with no overzoom parent cache; warm overzoom reuses identical content across changing URLs. Inclusive frame costs overlap and must not be summed.'};
    const reference = new Map<Phase, {source: string; rendered: string; image: string}>();
    const browser = await launchPuppeteer();
    function save(): void { writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2)); }
    try {
        report.browser = await browser.version();
        for (let run = 0; run < Number(args.runs); run++) {
            for (const encoding of run % 2 ? ['mlt', 'mvt'] as const : ['mvt', 'mlt'] as const) {
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
                    const info = await page.evaluate(installScenario, {encoding, origin: server.origin, scenario: args.scenario});
                    if (report.gpu === 'hardware') assert.doesNotMatch(info.renderer, /swiftshader|llvmpipe|software/i);
                    assert.equal(page.workers().length, 1, 'The comparison requires one worker per map');
                    const mainClient = await page.createCDPSession();
                    const clients = [{name: 'main', client: mainClient}, {name: 'worker', client: page.workers()[0].client}];
                    const phases = [];
                    try {
                        for (const phase of ['native-reload', 'first-overzoom', 'warm-overzoom'] as const) {
                            const repeats = phase === 'first-overzoom' ? 1 : Number(args.repeats);
                            const profiles = await profilePhase(page, clients, phase, repeats);
                            const captured = [];
                            for (const {name, profile} of profiles) {
                                const file = `${output}/${encoding}-${run}-${phase}-${name}.cpuprofile.gz`;
                                writeFileSync(file, gzipSync(JSON.stringify(profile)));
                                captured.push({name, file, ...summarizeProfile(profile, maps)});
                            }
                            const queries = await page.evaluate(() => (window as ScenarioWindow).mltScenario.queryJSON());
                            const hashes = {source: signature(queries.source), rendered: signature(queries.rendered)};
                            assert.ok(queries.source.length && queries.rendered.length);
                            const image = `${output}/${encoding}-${run}-${phase}.png`;
                            await (await page.$('#map')).screenshot({path: image});
                            const expected = reference.get(phase);
                            if (expected) {
                                assert.equal(hashes.source, expected.source); assert.equal(hashes.rendered, expected.rendered);
                                assert.equal(difference(image, expected.image).pixels, 0);
                            } else reference.set(phase, {...hashes, image});
                            assert.deepEqual(errors, []);
                            phases.push({phase, repeats, profiles: captured, hashes,
                                counts: {source: queries.source.length, rendered: queries.rendered.length}, image});
                        }
                    } finally { await mainClient.detach(); }
                    await page.evaluate(() => (window as ScenarioWindow).mltScenario.destroy());
                    report.sessions.push({run, encoding, info, phases}); save();
                    console.log(`render profile ${run + 1}/${args.runs}: ${encoding} passed`);
                } finally { await page.close(); }
            }
        }
        report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
    finally { save(); await browser.close(); await server.close(); }
}

/** Sampling is enabled only around render-producing public actions, with paired main/worker profiles. */
async function profilePhase(page: Page, clients: Array<{name: string; client: CDPSession}>, phase: Phase, repeats: number) {
    for (const {client} of clients) {
        await client.send('Profiler.enable');
        await client.send('Profiler.setSamplingInterval', {interval: 250});
        await client.send('Profiler.start');
    }
    const profiles: Array<{name: string; profile: Protocol.Profiler.Profile}> = [];
    try {
        await page.evaluate(async ({phase, repeats}) => {
            const scenario = (window as ScenarioWindow).mltScenario;
            for (let index = 0; index < repeats; index++) {
                if (phase === 'first-overzoom') await scenario.visit(0);
                else await scenario.reload();
            }
        }, {phase, repeats});
    } finally {
        for (const {name, client} of clients) {
            const {profile} = await client.send('Profiler.stop'); profiles.push({name, profile});
            await client.send('Profiler.disable');
        }
    }
    return profiles;
}

/** Resolves sampled call stacks through the exact production maps; inclusive costs are non-additive. */
function summarizeProfile(profile: Protocol.Profiler.Profile, maps: Map<string, TraceMap>) {
    const labels = new Map<number, string>(); const parents = new Map<number, number>();
    for (const node of profile.nodes) {
        const frame = node.callFrame; const map = maps.get(frame.url);
        const source = map && frame.lineNumber >= 0 ? originalPositionFor(map, {line: frame.lineNumber + 1, column: frame.columnNumber}) : undefined;
        labels.set(node.id, source?.source ? `${source.source}:${source.line} ${source.name ?? frame.functionName}` : frame.functionName || frame.url);
        for (const child of node.children ?? []) parents.set(child, node.id);
    }
    const self = new Map<string, number>(); const inclusive = new Map<string, number>();
    const samples = profile.samples ?? []; const deltas = profile.timeDeltas ?? [];
    assert.equal(samples.length, deltas.length); assert.ok(samples.length);
    for (let index = 0; index < samples.length; index++) {
        const label = labels.get(samples[index]); const elapsed = deltas[index];
        self.set(label, (self.get(label) ?? 0) + elapsed);
        const stack = new Set<string>();
        for (let node = samples[index]; node !== undefined; node = parents.get(node)) stack.add(labels.get(node));
        for (const entry of stack) inclusive.set(entry, (inclusive.get(entry) ?? 0) + elapsed);
    }
    return {sampleCount: samples.length, sampledMicroseconds: deltas.reduce((sum, value) => sum + value, 0),
        selfMicroseconds: Object.fromEntries([...self].sort((a, b) => b[1] - a[1])),
        inclusiveMicroseconds: Object.fromEntries([...inclusive].sort((a, b) => b[1] - a[1]))};
}

main().catch(error => { console.error(error); process.exitCode = 1; });
