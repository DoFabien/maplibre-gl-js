import {defineConfig, type ViteUserConfig} from 'vitest/config';
import unit from '../../vitest.config.unit.ts';

const config: ViteUserConfig = defineConfig({...unit, test: {...unit.test,
    include: ['test/bench/e2e/mlt-direct-pipeline.test.ts'], testTimeout: 180000,
}});

export default config;
