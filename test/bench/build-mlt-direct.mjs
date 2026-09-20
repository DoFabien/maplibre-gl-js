import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {readFileSync, writeFileSync, existsSync, realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {build} from 'rolldown';

const [destination, reference] = process.argv.slice(2);
assert.ok(destination && !existsSync(destination), 'Use a new output directory');
const root = resolve('.'); const frozen = reference ? resolve(reference) : undefined;
const frozenGl = frozen ? realpathSync(`${frozen}/gl-src`) : undefined;
const frozenMlt = frozen ? realpathSync(`${frozen}/mlt-dist`) : undefined;
const sources = {};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Resolves the frozen source trees against the same installed external dependencies, without changing either worktree. */
function frozenSources() {
    return {name: 'frozen-mlt-direct-sources',
        async resolveId(source, importer) {
            if (source === '@maplibre/mlt') return `${frozenMlt}/index.js`;
            if (source.startsWith('.') && importer?.startsWith(`${frozen}/`)) {
                const local = await this.resolve(source, importer, {skipSelf: true});
                if (local) return local;
            }
            const currentImporter = importer?.replace(`${frozenGl}/`, `${root}/src/`)
                .replace(`${frozenMlt}/`, resolve('../maplibre-tile-spec/ts/dist') + '/');
            const resolved = await this.resolve(source, currentImporter, {skipSelf: true});
            if (!resolved || resolved.external) return resolved;
            return {...resolved, id: resolved.id.replace(`${root}/src/`, `${frozenGl}/`)
                .replace(resolve('../maplibre-tile-spec/ts/dist') + '/', `${frozenMlt}/`)};
        }};
}

await build({input: resolve('test/bench/e2e/mlt-direct-module.ts'), platform: 'node', treeshake: false, tsconfig: resolve('tsconfig.json'),
    plugins: [...(frozen ? [frozenSources()] : []), {name: 'archive-module-inputs',
        load(id) { if (existsSync(id)) sources[id] = hash(readFileSync(id)); return null; }}],
    output: {dir: resolve(destination), format: 'esm', entryFileNames: 'pipeline.mjs', sourcemap: false, minify: false}});
writeFileSync(`${destination}/manifest.json`, JSON.stringify({reference: frozen ?? null, sources,
    configuration: {tsconfig: hash(readFileSync('tsconfig.json')), node: process.version,
        rolldown: JSON.parse(readFileSync('node_modules/rolldown/package.json', 'utf8')).version},
    bundle: hash(readFileSync(`${destination}/pipeline.mjs`)), limitation: 'Bundled Node worker APIs; not a browser/GPU timing.'}, null, 2));
