import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'rolldown';

const outputDirectory = resolve(process.argv[2] ?? '');
assert(process.argv[2] && !existsSync(outputDirectory), 'Provide a new output directory');
const benchmarkModule = resolve('test/bench/lib/mlt_worker_parse.ts');

/** Preserve source-relative fixture URLs when relocating the diagnostic harness into a bundle. */
function preserveBenchmarkFixtures() {
    return {
        name: 'preserve-benchmark-fixtures',
        transform(code, id) {
            if (id !== benchmarkModule) return;
            return {code: code.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(benchmarkModule).href)), map: null};
        },
    };
}

await build({
    input: resolve('test/bench/run-mlt-diagnostics.ts'),
    platform: 'node',
    treeshake: false,
    plugins: [preserveBenchmarkFixtures()],
    output: {
        dir: outputDirectory,
        format: 'esm',
        entryFileNames: 'diagnostics.mjs',
        chunkFileNames: '[name]-[hash].mjs',
        sourcemap: false,
        minify: false,
    },
});
console.log(`Diagnostic bundle written to ${outputDirectory}; this is not the browser product build.`);
