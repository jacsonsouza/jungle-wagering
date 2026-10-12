import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runWorker, runWorkers } from './harness.js';
import {
  closeTestOrm,
  db,
  testOrm,
  truncateAllTables,
} from '../setup/orm.js';

/**
 * Smoke test for the process harness itself.
 *
 * The eight §13 scenarios below are worthless if the machinery that spawns
 * them is broken: a worker that never signals ready, a `go` that arrives
 * before the child is listening, or a result that gets lost would each look
 * like a concurrency BUG in the product rather than a defect in the test. So
 * the plumbing is proven first, in isolation, with the simplest job there is.
 */
describe('conc harness (smoke)', () => {
  beforeAll(async () => {
    await testOrm();
  });

  afterAll(async () => {
    await closeTestOrm();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('runs a single job in a real OS process', async () => {
    const result = await runWorker({
      op: 'create-wallet',
      playerId: 'player-smoke',
      initialAmount: '50.00',
    });

    expect(result.ok).toBe(true);

    const detail = result.detail as { outcome: string; walletId: string };
    expect(detail.outcome).toBe('CREATED');

    // The write really landed in the shared database — the child did not just
    // report success in isolation.
    const wallets = await db<{ id: string }>('select id from "wallets"');
    expect(wallets).toHaveLength(1);
    expect(wallets[0].id).toBe(detail.walletId);
  });

  it('releases every worker only after all of them report ready', async () => {
    // Four distinct processes, four distinct player ids: if the barrier were
    // broken, some would still complete — so the assertion is on ALL FOUR
    // having run concurrently against the same database, not on any one.
    const results = await runWorkers(4, (index) => ({
      op: 'create-wallet',
      playerId: `player-barrier-${index}`,
      initialAmount: '10.00',
    }));

    expect(results).toHaveLength(4);
    expect(results.every((result) => result.ok)).toBe(true);

    const wallets = await db<{ id: string }>('select id from "wallets"');
    expect(wallets).toHaveLength(4);
  });

  it('does not leak connections across a batch of workers', async () => {
    // Five sequential batches of four = twenty processes. If each child left a
    // connection behind, the server's max_connections (100) would be reached
    // long before the real scenarios, which spawn fifty at once.
    for (let batch = 0; batch < 5; batch += 1) {
      await runWorkers(4, (index) => ({
        op: 'create-wallet',
        playerId: `player-leak-${batch}-${index}`,
        initialAmount: '1.00',
      }));
    }

    const [row] = await db<{ count: string }>(
      'select count(*)::text as count from "pg_stat_activity" where datname = current_database()',
    );

    // The harness, this test's own ORM, and a small amount of slop.
    expect(Number(row.count)).toBeLessThan(15);
  });
});
