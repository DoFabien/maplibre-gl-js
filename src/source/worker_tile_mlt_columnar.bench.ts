import {test} from 'vitest';
import {mltBenchmarkFactories} from '../../test/bench/mlt_benchmark_registry.ts';

for (const [name, factory] of Object.entries(mltBenchmarkFactories)) {
    test(`MLT columnar worker parsing: ${name}`, async ({bench}) => {
        const instance = factory();
        await instance.setup();
        await bench(name, () => instance.bench());
    });
}
