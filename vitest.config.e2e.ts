import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { testEnv } from './test/setup/test-env.js';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    server: { deps: { inline: [/@mikro-orm\//] } },
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Real PostgreSQL: the stack must be up (`bun run infra:up`).
    env: testEnv(),
    globalSetup: ['./test/setup/global-setup.ts'],
  },
});
