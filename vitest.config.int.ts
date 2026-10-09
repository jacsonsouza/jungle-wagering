import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { testEnv } from './test/setup/test-env.js';

/**
 * Integration suite: migrations, constraints, atomicity, inbox/outbox and
 * retry/DLQ behaviour exercised against real PostgreSQL and LocalStack.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.int-spec.ts'],
    env: testEnv(),
    globalSetup: ['./test/setup/global-setup.ts'],
    passWithNoTests: true,
    fileParallelism: false,
  },
});
