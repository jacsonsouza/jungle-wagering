import { MikroORM } from '@mikro-orm/core';
import { testEnv } from './test-env.js';

/**
 * Runs once per suite, in the main Vitest process, before any test file.
 *
 * Pointing the process at the test database first means the shared MikroORM
 * config — which reads `DATABASE_URL` — resolves to the isolated database.
 * Migration state is therefore identical for every worker and every test file.
 */
export default async function globalSetup(): Promise<void> {
  Object.assign(process.env, testEnv());

  const { default: config } =
    await import('../../src/database/mikro-orm.config.js');
  const orm = await MikroORM.init(config);

  try {
    const applied = await orm.migrator.up();
    if (applied.length > 0) {
      console.log(`[global-setup] applied ${applied.length} migration(s)`);
    }
  } finally {
    await orm.close(true);
  }
}
