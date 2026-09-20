import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import minimist from 'minimist';
import {
    MLT_BENCHMARK_MINIMUM_ITERATIONS,
    MLT_BENCHMARK_MINIMUM_WARMUP,
} from './lib/mlt_benchmark_statistics.ts';

const argv = minimist(process.argv.slice(2), {
    boolean: ['skip-check'],
    string: ['output-dir', 'suite', 'baseline', 'budgets'],
    default: {
        campaigns: 3,
        iterations: MLT_BENCHMARK_MINIMUM_ITERATIONS,
        warmup: MLT_BENCHMARK_MINIMUM_WARMUP,
        suite: 'core',
        'output-dir': 'test/bench/results/mlt-campaigns',
    },
});

function positiveInteger(value: unknown, name: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --${name} value: ${value}`);
    return parsed;
}

function runViteNode(script: string, args: string[], label: string): void {
    const result = spawnSync(
        process.execPath,
        ['node_modules/vite-node/dist/cli.mjs', script, ...args],
        {cwd: process.cwd(), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024},
    );
    if (result.status !== 0) {
        throw new Error(`${label} failed:\n${result.stderr || result.stdout}`);
    }
    process.stdout.write(result.stdout);
}

const campaigns = positiveInteger(argv.campaigns, 'campaigns');
const iterations = positiveInteger(argv.iterations, 'iterations');
const warmup = positiveInteger(argv.warmup, 'warmup');
const suite = String(argv.suite);
if (suite !== 'core' && suite !== 'extended') throw new Error(`Invalid --suite value: ${suite}`);

const outputDirectory = resolve(String(argv['output-dir']));
mkdirSync(outputDirectory, {recursive: true});
const reports: string[] = [];

for (let campaign = 1; campaign <= campaigns; campaign++) {
    const reportPath = resolve(outputDirectory, `campaign-${campaign}.json`);
    reports.push(reportPath);
    runViteNode('test/bench/run-mlt-isolated.ts', [
        '--iterations', String(iterations),
        '--warmup', String(warmup),
        '--suite', suite,
        '--output', reportPath,
        ...argv._.map(String),
    ], `MLT benchmark campaign ${campaign}`);

    if (!argv['skip-check']) {
        const checkArgs = ['--report', reportPath];
        if (argv.baseline) checkArgs.push('--baseline', String(argv.baseline));
        if (argv.budgets) checkArgs.push('--budgets', String(argv.budgets));
        runViteNode('test/bench/check-mlt-budgets.ts', checkArgs, `MLT budget check for campaign ${campaign}`);
    }
}

const manifestPath = resolve(outputDirectory, 'manifest.json');
writeFileSync(manifestPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    campaigns,
    iterationsPerCampaign: iterations,
    warmupPerCampaign: warmup,
    suite,
    reports,
}, null, 2)}\n`);
console.log(`MLT campaign manifest written to ${manifestPath}`);
