import {defineConfig, type OutputOptions, type RolldownOptions} from 'rolldown';
import {readFileSync} from 'node:fs';
import configs from './rolldown.config.ts';

/** Builds the regular renderer with a strict test worker in a separate output directory. */
const base = configs[0];

/** Uses the normal dev build options and stylesheet, changing only the worker and destination. */
const config: RolldownOptions = defineConfig({
    ...base,
    plugins: [{
        name: 'validation-stylesheet',
        buildStart() {
            this.emitFile({type: 'asset', fileName: 'maplibre-gl.css', source: readFileSync('dist/maplibre-gl.css')});
        },
    }],
    input: {
        'maplibre-gl': 'src/index.ts',
        'maplibre-gl-worker': 'test/integration/lib/mlt_strict_worker.ts',
    },
    output: {
        ...base.output as OutputOptions,
        dir: 'dist/mlt-validation',
    },
});

export default config;
