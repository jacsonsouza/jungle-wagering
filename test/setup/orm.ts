import { MikroORM } from '@mikro-orm/core';

let orm: MikroORM | null = null;

/**
 * Lazily boots a single MikroORM instance per test process.
 *
 * Integration tests need a real EntityManager (transactions, locks, constraint
 * errors), and sharing one instance keeps connection churn out of the way of
 * the concurrency scenarios being measured.
 */
export async function testOrm(): Promise<MikroORM> {
  if (!orm) {
    const { default: config } =
      await import('../../src/database/mikro-orm.config.js');
    orm = await MikroORM.init(config);
  }

  return orm;
}

export async function closeTestOrm(): Promise<void> {
  if (!orm) return;
  await orm.close(true);
  orm = null;
}

/**
 * Runs raw SQL and returns plain rows.
 *
 * Assertions read much better against a plain array than against MikroORM's
 * QueryResult wrapper.
 *
 * Note: this goes through MikroORM's raw path, which does NOT bind parameters
 * — interpolate literals in the caller. Fine for tests, where every value is
 * a constant the test itself chose.
 */
export async function db<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const instance = await testOrm();
  const rows = await instance.em.getConnection().execute<T>(sql, [], 'all');

  return rows as unknown as T[];
}

/** Runs a statement with no interesting result (DDL, TRUNCATE, INSERT). */
export async function dbRun(sql: string): Promise<void> {
  const instance = await testOrm();
  await instance.em.getConnection().execute(sql, [], 'run');
}

/**
 * Wipes every application table between tests.
 *
 * `cascade` is required because `wallet_ledger_entries` and `wager_transactions`
 * reference `wallets`.
 */
export async function truncateAllTables(): Promise<void> {
  await dbRun(
    `truncate table
       "wallet_ledger_entries",
       "wager_transactions",
       "outbox_messages",
       "inbox_messages",
       "wallets"
     cascade`,
  );
}
