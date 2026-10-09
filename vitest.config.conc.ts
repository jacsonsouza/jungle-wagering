import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { testEnv } from './test/setup/test-env.js';

/**
 * Concurrency suite: real parallelism (multiple app instances, racing
 * requests), so files never run in parallel with each other — the scenarios
 * are already running concurrently internally and need a quiet database.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.conc-spec.ts'],
    env: testEnv(),
    globalSetup: ['./test/setup/global-setup.ts'],
    passWithNoTests: true,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
