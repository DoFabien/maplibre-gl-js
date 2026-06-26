import fs from 'fs';
import puppeteer from 'puppeteer';
import PDFMerger from 'pdf-merger-js';
import minimist from 'minimist';
import {spawn} from 'child_process';

const argv = minimist(process.argv.slice(2));
const perfRendererCounters = argv['perf-renderer-counters'] === true || argv['perf-renderer-counters'] === '';
const chromeArgs = argv.sandbox === false ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
const headless = argv.headless === undefined ? false : argv.headless !== false && argv.headless !== 'false';
const localChrome = '/usr/bin/google-chrome-stable';
const executablePath = argv.chrome || process.env.CHROME_BIN || (fs.existsSync(localChrome) ? localChrome : undefined);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const formatTime = (v) => {
    if (typeof v === 'number' && !isNaN(v)) {
        return `${v.toFixed(4)} ms`;
    } else {
        return '';
    }
};

const formatRegression = (v) => {
    if (v) {
        const correlation = v.correlation;
        if (correlation < 0.9) {
            return '\u2620\uFE0F';
        } else if (correlation < 0.99) {
            return '\u26A0\uFE0F';
        }
    }
    return ' ';
};

const readTextFile = (path: string): string => {
    try {
        return fs.readFileSync(path, 'utf8');
    } catch {
        return '';
    }
};

const readChildren = (pid: number): number[] => {
    const children = new Set<number>();
    const taskPath = `/proc/${pid}/task`;
    let tids: string[] = [];
    try {
        tids = fs.readdirSync(taskPath);
    } catch {
        return [];
    }

    for (const tid of tids) {
        const text = readTextFile(`${taskPath}/${tid}/children`).trim();
        if (!text) continue;
        for (const child of text.split(/\s+/)) {
            const parsed = Number(child);
            if (Number.isInteger(parsed)) children.add(parsed);
        }
    }
    return Array.from(children);
};

const descendants = (pid: number): number[] => {
    const seen = new Set<number>();
    const stack = [pid];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const child of readChildren(current)) {
            if (seen.has(child)) continue;
            seen.add(child);
            stack.push(child);
        }
    }
    return Array.from(seen);
};

const cmdline = (pid: number): string => readTextFile(`/proc/${pid}/cmdline`).replace(/\0/g, ' ');

const rendererPids = (browserPid: number): number[] =>
    descendants(browserPid).filter(pid => cmdline(pid).includes('--type=renderer'));

const waitForRendererPids = async (browserPid: number): Promise<number[]> => {
    for (let i = 0; i < 20; i++) {
        const pids = rendererPids(browserPid);
        if (pids.length > 0) return pids;
        await sleep(50);
    }
    return [];
};

const parsePerfStat = (stderr: string) => {
    const counters: {
        cycles: number | null;
        instructions: number | null;
        unavailableReason?: string;
    } = {
        cycles: null,
        instructions: null
    };

    for (const line of stderr.split('\n')) {
        const parts = line.split(',');
        if (parts.length < 3) continue;
        const rawValue = parts[0].trim();
        const event = parts[2].trim();
        if (event !== 'cycles' && event !== 'instructions') continue;
        const value = Number(rawValue);
        if (Number.isFinite(value)) counters[event] = value;
        else counters.unavailableReason ||= rawValue || `perf did not count ${event}`;
    }

    if (counters.cycles === null || counters.instructions === null) {
        counters.unavailableReason ||= 'perf stat did not return both cycles and instructions';
    }
    return counters;
};

const startRendererPerf = async (browser) => {
    if (!perfRendererCounters) return null;

    const browserPid = browser.process()?.pid;
    if (!browserPid) {
        return {
            stop: async () => ({
                cycles: null,
                instructions: null,
                unavailableReason: 'Puppeteer did not expose the browser process pid',
                source: 'perf stat'
            })
        };
    }

    const pids = await waitForRendererPids(browserPid);
    if (pids.length === 0) {
        return {
            stop: async () => ({
                cycles: null,
                instructions: null,
                unavailableReason: 'No Chrome renderer process was found under the browser process',
                source: 'perf stat',
                browserPid
            })
        };
    }

    const perf = spawn('perf', ['stat', '-x,', '-e', 'cycles,instructions', '-p', pids.join(',')], {
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    perf.stderr.on('data', data => {
        stderr += data;
    });

    await sleep(50);

    return {
        stop: async () => {
            if (perf.exitCode === null) {
                perf.kill('SIGINT');
            }
            await new Promise<void>(resolve => {
                if (perf.exitCode !== null) {
                    resolve();
                    return;
                }
                perf.once('exit', () => resolve());
                setTimeout(() => {
                    if (perf.exitCode === null) perf.kill('SIGTERM');
                    resolve();
                }, 2_000);
            });

            return {
                ...parsePerfStat(stderr),
                source: 'perf stat -x, -e cycles,instructions -p <renderer pids>',
                browserPid,
                rendererPids: pids
            };
        }
    };
};

const dir = './test/bench/results';
if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
}

const url = new URL('http://localhost:9966/test/bench/versions/index.html');

const compares = argv.compare === undefined || argv.compare === true ? [''] : [].concat(argv.compare);
for (const compare of compares)
    url.searchParams.append('compare', compare || '');

for (const param of ['terrainReplaySamples', 'terrainReplayStyleComplexity', 'terrainReplayDuration']) {
    if (argv[param] !== undefined) url.searchParams.set(param, String(argv[param]));
}

console.log(`Starting ${headless ? 'headless' : 'headed'} chrome at: ${url.toString()}`);

const browser = await puppeteer.launch({headless, executablePath, args: chromeArgs});

try {

    const webPage = await browser.newPage();
    await webPage.setDefaultTimeout(0);
    await webPage.setViewport({width: 1280, height: 1024});
    webPage.on('console', (message) => {
        const text = message.text();
        if (message.type() === 'error' || message.type() === 'warning') {
            console.log(`[page ${message.type()}] ${text}`);
        }
    });
    webPage.on('pageerror', (error) => {
        console.log(`[pageerror] ${error.stack || error.message}`);
    });
    webPage.on('requestfailed', (request) => {
        const errorText = request.failure()?.errorText || '';
        if (errorText === 'net::ERR_ABORTED') return;
        console.log(`[requestfailed] ${request.url()} ${errorText}`);
    });

    let activeRendererPerf = null;
    if (perfRendererCounters) {
        await webPage.exposeFunction('maplibreglBenchmarkBeforeVersionRun', async () => {
            activeRendererPerf = await startRendererPerf(browser);
        });
        await webPage.exposeFunction('maplibreglBenchmarkAfterVersionRun', async () => {
            const rendererPerf = activeRendererPerf;
            activeRendererPerf = null;
            if (!rendererPerf) return null;
            return {
                rendererHardwareCounters: await rendererPerf.stop()
            };
        });
    }

    url.hash = 'NONE'; // this will simply load the page without running any benchmarks
    await webPage.goto(url.toString());

    await webPage.waitForFunction(() => (window as any).maplibreglBenchmarkFinished);
    const initialError = await webPage.evaluate(() => (window as any).maplibreglBenchmarkError);
    if (initialError) throw new Error(`Benchmark page failed to initialize: ${JSON.stringify(initialError)}`);
    const allNames = await webPage.evaluate(() => Object.keys((window as any).maplibreglBenchmarks));
    const versions = await webPage.evaluate((name) => Object.keys((window as any).maplibreglBenchmarks[name]), allNames[0]);
    const versionsDisplayName = await webPage.evaluate(() => (window as any).versionsDisplayName);

    // The following will run all the tests if no arguments are passed, will run only the tests passed as arguments otherwise
    const toRun = argv._.length > 0 ? argv._ : allNames;

    const nameWidth = Math.max(...toRun.map(v => v.length)) + 1;
    const timeWidth = Math.max(...versions.map(v => v.length), 16);

    console.log(''.padStart(nameWidth), ...versions.map((v, i) =>  `${(versionsDisplayName[i]).padStart(timeWidth)} `));

    const merger = new PDFMerger();
    for (const name of toRun) {
        process.stdout.write(name.padStart(nameWidth));

        url.hash = name;
        await webPage.goto(url.toString());
        await webPage.reload();

        await webPage.waitForFunction(
            () => (window as any).maplibreglBenchmarkFinished,
            {
                polling: 200,
                timeout: 0
            }
        );
        const benchmarkError = await webPage.evaluate(() => (window as any).maplibreglBenchmarkError);
        if (benchmarkError) throw new Error(`Benchmark "${name}" failed: ${JSON.stringify(benchmarkError)}`);
        const results = await webPage.evaluate((name) => (window as any).maplibreglBenchmarkResults[name], name);
        fs.writeFileSync(`${dir}/${name}.json`, JSON.stringify(results, null, 2));
        const output = versions.map((v) => {
            if (v && results[v]) {
                const trimmedMean = results[v].summary?.trimmedMean;
                const regression = results[v].regression;
                return formatTime(trimmedMean).padStart(timeWidth) + formatRegression(regression);
            } else {
                return ''.padStart(timeWidth + 1);
            }
        });
        if (versions.length === 2) {
            const [main, current] = versions;
            const delta = results[current]?.summary?.trimmedMean - results[main]?.summary?.trimmedMean;
            output.push(((delta > 0 ? '+' : '') + formatTime(delta)).padStart(15));
        }
        console.log(...output);

        await merger.add(await webPage.pdf({
            format: 'a4',
            path: `${dir}/${name}.pdf`,
            printBackground: true,
            margin: {
                top: '1cm',
                bottom: '1cm',
                left: '1cm',
                right: '1cm'
            }
        }));
    }

    await merger.save(`${dir}/all.pdf`);
} catch (error) {
    if (error.message.startsWith('net::ERR_CONNECTION_REFUSED')) {
        console.log('Could not connect to server. Please run \'npm run start-bench\'.');
    } else {
        console.log(error);
    }
} finally {
    await browser.close();
}
