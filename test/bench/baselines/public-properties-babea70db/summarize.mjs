import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';

function percentile(values, fraction) {
    const sorted = values.toSorted((a, b) => a - b);
    assert(sorted.length > 0);
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

function checkSamples(samples, distribution, expectedCount) {
    assert.equal(samples.length, expectedCount);
    assert(samples.every(value => Number.isFinite(value) && value > 0));
    for (const [name, fraction] of [['median', 0.5], ['p95', 0.95], ['min', 0], ['max', 1]]) {
        const actual = percentile(samples, fraction);
        assert(Math.abs(actual - distribution[name]) <= Math.max(1, actual) * 1e-10, `${name} does not match samples`);
    }
}

assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
assert.equal(percentile([0, 100], 0.95), 95);
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const output = outputIndex >= 0 ? args.splice(outputIndex, 2)[1] : undefined;
assert(args.length > 0, 'Provide campaign report paths');
const reports = args.map(path => JSON.parse(readFileSync(path, 'utf8')));
const first = reports[0];
for (const report of reports) {
    assert.equal(report.node, first.node);
    assert.equal(report.commit, first.commit);
    assert.equal(report.cpu, first.cpu);
    assert.equal(report.statistics.percentileMethod, 'linear-interpolation-r7');
    assert(report.iterations >= 30 && report.warmup >= 10);
    assert.deepEqual(report.benchmarks.map(b => b.benchmark), first.benchmarks.map(b => b.benchmark));
    assert.deepEqual(report.comparisons.map(b => b.candidate), first.comparisons.map(b => b.candidate));
    for (const benchmark of report.benchmarks) {
        assert.equal(benchmark.iterations, report.iterations);
        assert.equal(benchmark.warmup, report.warmup);
        assert.equal(benchmark.node, report.node);
        assert.equal(benchmark.commit, report.commit);
        checkSamples(benchmark.durationSamplesMs, benchmark.durationMs, report.iterations);
    }
    for (const pair of report.comparisons) {
        assert.equal(pair.iterations, report.iterations);
        assert.equal(pair.warmup, report.warmup);
        assert.equal(pair.node, report.node);
        assert.equal(pair.commit, report.commit);
        checkSamples(pair.referenceDurationSamplesMs, pair.referenceDurationMs, report.iterations);
        checkSamples(pair.candidateDurationSamplesMs, pair.candidateDurationMs, report.iterations);
    }
}
const summary = {
    reports: args,
    commit: first.commit,
    node: first.node,
    cpu: first.cpu,
    trackedCodeNote: 'The original benchmark worktreeDirty includes pre-existing untracked artifacts; inspect git status separately.',
    benchmarksPerCampaign: first.benchmarks.length,
    comparisonsPerCampaign: first.comparisons.length,
    iterations: first.iterations,
    warmup: first.warmup,
    pairs: first.comparisons.map((comparison, index) => {
        const individual = first.benchmarks.find(b => b.benchmark === comparison.candidate);
        const operations = individual.workload.operationsPerIteration;
        assert.equal(first.benchmarks.find(b => b.benchmark === comparison.reference).workload.operationsPerIteration, operations);
        const campaigns = reports.map(report => {
            const pair = report.comparisons[index];
            assert.equal(pair.executionOrder, 'alternating');
            assert.equal(pair.referenceDurationSamplesMs.length, report.iterations);
            assert.equal(pair.candidateDurationSamplesMs.length, report.iterations);
            const ratios = pair.candidateDurationSamplesMs.map((value, i) => value / pair.referenceDurationSamplesMs[i]);
            return {
                ratioMedian: percentile(ratios, 0.5),
                ratioP95: percentile(ratios, 0.95),
                mvtMsPerOperation: pair.referenceDurationMs.median / operations,
                mltMsPerOperation: pair.candidateDurationMs.median / operations,
                mltP95MsPerOperation: pair.candidateDurationMs.p95 / operations,
                excessMsPerOperation: (pair.candidateDurationMs.median - pair.referenceDurationMs.median) / operations,
            };
        });
        return {
            candidate: comparison.candidate,
            reference: comparison.reference,
            operation: individual.workload.operation,
            parameters: individual.workload.parameters,
            medianOfCampaignRatioMedians: percentile(campaigns.map(c => c.ratioMedian), 0.5),
            medianOfCampaignExcessMsPerOperation: percentile(campaigns.map(c => c.excessMsPerOperation), 0.5),
            campaigns,
        };
    }).toSorted((a, b) => b.medianOfCampaignExcessMsPerOperation - a.medianOfCampaignExcessMsPerOperation),
    individual: first.benchmarks.map((benchmark, index) => ({
        name: benchmark.benchmark,
        workload: benchmark.workload,
        campaigns: reports.map(report => {
            const b = report.benchmarks[index];
            return {durationMs: b.durationMs, memoryBytes: b.memoryBytes, measurements: b.measurements, materializations: b.materializations.perIteration};
        }),
    })),
};
if (output) writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({commit: summary.commit, node: summary.node, campaigns: reports.length, cases: summary.benchmarksPerCampaign, pairs: summary.comparisonsPerCampaign, largestExcessCosts: summary.pairs.slice(0, 20)}, null, 2));
