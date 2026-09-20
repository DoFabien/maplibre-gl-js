import {defineConfig, type ViteUserConfig} from 'vitest/config';

const config: ViteUserConfig = defineConfig({test: {environment: 'node', include: ['test/bench/e2e/mlt-navigation.test.ts'], testTimeout: 10000}});

export default config;
