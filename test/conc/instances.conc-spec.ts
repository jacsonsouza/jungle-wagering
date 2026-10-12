import { env } from '../../src/config/env.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/index.js';
import { closeTestOrm, db, testOrm, truncateAllTables } from '../setup/orm.js';
import { drainQueues, queueDepth } from '../setup/sqs.js';
import {
  balanceOf,
  bet,
  givenWallet,
  pinnedBet,
  reportOf,
  sendToQueue,
} from './fixtures.js';
import { assertWalletMatchesLedger, runWorker, runWorkers } from './harness.js';

/**
 * §13 scenarios 4 and 8 — the boundary of a single process.
 *
 * Six real pids race one wallet, and a consumer restarts over work that
 * arrived while it was down. Nothing survives in memory — no cache, no lock,
 * no unflushed write — so every recovery is the database and the queue each
 * doing their own job.
 */
describe('§13 · separate instances (scenarios 4, 8)', () => {
  beforeAll(async () => {
    await testOrm();
  });

  afterAll(async () => {
    await closeTestOrm();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await drainQueues();
  });

  it('4. runs three or more separate OS instances against one wallet', async () => {
    const walletId = await givenWallet('player-multi', '1000.00');

    // Six processes, six distinct bets, one hot wallet. The assertion on pids
    // is what separates "six instances" from one process pretending.
    const results = await runWorkers(6, () => ({
      op: 'submit',
      command: bet('player-multi', walletId, '10.00'),
    }));

    const pids = new Set(results.map((result) => result.pid));
    expect(pids.size).toBeGreaterThanOrEqual(3);

    const reports = results.map((result) => reportOf(result.detail));
    expect(
      reports.every((r) => r.status === WagerTransactionStatus.Processed),
    ).toBe(true);

    // Six distinct operations, six debits — no lost update, no duplicate.
    const transactionIds = new Set(reports.map((r) => r.transactionId));
    expect(transactionIds.size).toBe(6);

    expect(await balanceOf(walletId)).toBe('940.00');

    await assertWalletMatchesLedger(walletId);
  });

  it('8. converges to a consistent state after a service restart', async () => {
    const walletId = await givenWallet('player-restart', '200.00');

    // Work arrived while the service was down: three bets sit unconsumed on
    // the queue, and the wallet's own OPENING event sits unpublished in the
    // outbox. Neither has been applied yet.
    const commands = [
      pinnedBet('player-restart', walletId, 'ext-restart-1', '10.00'),
      pinnedBet('player-restart', walletId, 'ext-restart-2', '20.00'),
      pinnedBet('player-restart', walletId, 'ext-restart-3', '30.00'),
    ];

    for (const command of commands) {
      await sendToQueue(command);
    }

    // `queueDepth` deliberately receives-and-deletes, so probing the backlog
    // here would consume it before the restart ever happened. The evidence
    // that three messages were waiting is the balance below: 200.00 before the
    // consumer runs, 140.00 after — the work only lands if they were there.
    expect(await balanceOf(walletId)).toBe('200.00');

    // Restart: brand-new processes take over the backlog. No state was kept
    // in memory, so the recovery is entirely the database and the queue.
    const consumed = await runWorker({ op: 'consume-once' });
    expect(consumed.ok).toBe(true);

    // Step one — the backlog itself, measured BEFORE the publisher runs.
    // `publish-outbox` deliberately puts events back on this very queue, so a
    // depth check after it would assert the opposite of §11. The depth and the
    // balance are read together because together they are the whole claim:
    // nothing is left waiting, and the three bets netted against 200.00 once.
    expect(await queueDepth(env.sqs.queueUrl)).toBe(0);
    expect(await balanceOf(walletId)).toBe('140.00');

    // Step two — the events those bets emitted were only *recorded* at commit
    // time (§11); the publisher is what finally puts them on the queue.
    const published = await runWorker({ op: 'publish-outbox' });
    expect(published.ok).toBe(true);

    // Nothing stranded. This is the failure §11 exists to prevent: a database
    // that changed while the world was never told.
    const stillUnpublished = await db<{ count: string }>(
      `select count(*)::text as count from "outbox_messages"
            where published_at is null`,
    );
    expect(Number(stillUnpublished[0].count)).toBe(0);

    // The three bets landed. Scoped to BET because the wallet's own OPENING
    // row is also PROCESSED and would otherwise count as a fourth.
    const processed = await db<{ count: string }>(
      `select count(*)::text as count from "wager_transactions"
            where status = '${WagerTransactionStatus.Processed}'
              and kind = '${WagerTransactionKind.Bet}'`,
    );
    expect(Number(processed[0].count)).toBe(3);

    await assertWalletMatchesLedger(walletId);
  });
});
