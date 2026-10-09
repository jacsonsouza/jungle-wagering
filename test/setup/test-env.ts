import { config as loadDotenv } from 'dotenv';

loadDotenv({ quiet: true });

/**
 * Integration and concurrency suites run against a dedicated database so they
 * can migrate, truncate and fail freely without touching local development
 * data.
 *
 * They deliberately do NOT share `DATABASE_URL`: the whole point is that a
 * suite can wipe its own state between runs.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is required to run integration/concurrency tests.\n' +
        'Copy .env.example to .env, fill it in, and start the stack with `bun run infra:up`.',
    );
  }
  return url;
}

/**
 * Injected into workers via `test.env`. Overrides the parent process so a
 * developer's local `DATABASE_URL` can never leak into a test run.
 */
export function testEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
  };
}
