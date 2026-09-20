import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';

const directory = 'test/bench/baselines/pretriangulated-checkpoint-20260908';
assert.ok(!existsSync(`${directory}/gpu-comparison.json`), 'Preserve the previous GPU evidence');
mkdirSync(directory, {recursive: true});
const reportPath = '/tmp/mlt-pretriangulated-render-gpu-20260908.json';
const report = JSON.parse(readFileSync(reportPath));
const previousDirectory = 'test/bench/baselines/owned-indices-checkpoint-20260908';
const previous = JSON.parse(readFileSync(`${previousDirectory}/gpu-comparison.json`));
const failures = report.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed').map(test => test.fullName)).sort();
assert.equal(report.numPassedTests, 236);
assert.equal(report.numFailedTests, 7);
assert.equal(report.numPendingTests, 1680);
assert.deepEqual(failures, previous.images.map(image => image.name).sort());
const files = failures.map(name => `${name.replace('Render tests ', 'test/integration/render/')}/actual.png`);
const images = files.map((file, index) => {
    const actual = PNG.sync.read(readFileSync(file));
    const reference = PNG.sync.read(execFileSync('tar', ['-xOf', `${previousDirectory}/gpu-failure-images.tar.gz`, file]));
    assert.equal(actual.width, reference.width); assert.equal(actual.height, reference.height);
    let pixels = 0;
    for (let offset = 0; offset < actual.data.length; offset += 4) {
        if (!actual.data.subarray(offset, offset + 4).equals(reference.data.subarray(offset, offset + 4))) pixels++;
    }
    assert.equal(pixels, 0, failures[index]);
    return {name: failures[index], pixels};
});
const archive = `${directory}/gpu-failure-images.tar.gz`;
execFileSync('tar', ['-czf', archive, ...files]);
writeFileSync(`${directory}/gpu-comparison.json`, JSON.stringify({status: 'same-seven-failures-and-exact-images',
    reportPath, reportSha256: hash(reportPath), images, archive, sha256: hash(archive)}, null, 2));
console.log('GPU: same seven failure names and images; captured before software rendering');

/** Records the immutable report and image archive consumed by later audits. */
function hash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
