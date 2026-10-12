import { configDefaults, defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Unit suite: pure domain and use-case logic. Nothing external is allowed in
 * here — no PostgreSQL, no LocalStack — which is exactly why it can run
 * anywhere in seconds.
 *
 * The four suites are partitioned by filename suffix, each with its own
 * config: `*.int-spec.ts`, `*.conc-spec.ts` and `*.e2e-spec.ts` all need
 * containers and are excluded here so `bun run test` can never accidentally
 * start requiring them.
 */
export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    exclude: [
      ...configDefaults.exclude,
      '**/*.int-spec.ts',
      '**/*.conc-spec.ts',
      '**/*.e2e-spec.ts',
    ],
  },
});
