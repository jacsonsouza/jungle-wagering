import { env } from '../../src/config/env.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/index.js';
import { closeTestOrm, db, testOrm, truncateAllTables } from '../setup/orm.js';
import { drainQueues, queueDepth } from '../setup/sqs.js';
import {
  balanceOf,
  givenWallet,
  makeDue,
  pendingReferenceCount,
  pinnedBet,
  reportOf,
  sendToQueue,
} from './fixtures.js';
import {
  assertWalletMatchesLedger,
  ledgerRowsFor,
  runWorker,
  runWorkers,
} from './harness.js';

/**
 * §13 scenarios 5–7 — delivery is at-least-once.
 *
 * The same message arrives twice after a worker died before its ack, two
 * publishers race one outbox, and a REFUND lands before the bet it reverses.
 * Each answer is a constraint rather than a timing: the inbox's unique key,
 * `FOR UPDATE SKIP LOCKED`, and the pending-reference worker.
 */
describe('§13 · queue delivery (scenarios 5–7)', () => {
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

  it('5. does not double-apply a message whose worker died before the ack', async () => {
    const walletId = await givenWallet('player-crash', '100.00');
    const command = pinnedBet('player-crash', walletId, 'ext-crash-1', '30.00');

    await sendToQueue(command);

    // The first worker commits the transaction but never acks — the §13.5
    // crash window. A short visibility timeout brings the message back
    // without the suite waiting out the production default.
    const crashed = await runWorker({
      op: 'consume-once',
      skipAck: true,
      visibilityTimeoutSeconds: 1,
    });
    expect(crashed.ok).toBe(true);

    // The work landed even though the ack did not.
    expect(await balanceOf(walletId)).toBe('70.00');

    // Wait out the visibility timeout so SQS redelivers.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // A fresh instance picks the message up again. The inbox row written
    // inside the first worker's transaction is what keeps this a no-op.
    const survivor = await runWorker({ op: 'consume-once' });
    expect(survivor.ok).toBe(true);

    expect(await balanceOf(walletId)).toBe('70.00');

    // Still one debit, and still one inbox row for the message.
    const [transaction] = await db<{ id: string }>(
      `select id from "wager_transactions"
        where external_transaction_id = 'ext-crash-1'`,
    );
    expect(await ledgerRowsFor(transaction.id)).toBe(1);

    const [inbox] = await db<{ count: string }>(
      `select count(*)::text as count from "inbox_messages"`,
    );
    expect(Number(inbox.count)).toBe(1);

    await assertWalletMatchesLedger(walletId);
  });

  it('6. lets two publisher instances drain one outbox without duplication', async () => {
    // Four wallets, four committed outbox events, nothing published yet.
    const walletIds = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        givenWallet(`player-${index}`, '100.00'),
      ),
    );

    const unpublished = await db<{ count: string }>(
      `select count(*)::text as count from "outbox_messages"
        where published_at is null`,
    );
    expect(Number(unpublished[0].count)).toBe(4);

    // Two publishers race over the same rows. `SKIP LOCKED` is what makes
    // their slices disjoint; the totals below are what prove it held.
    const results = await runWorkers(2, () => ({ op: 'publish-outbox' }));
    const pids = new Set(results.map((result) => result.pid));
    expect(pids.size).toBe(2);

    const published = results.map(
      (result) => (result.detail as { published: number }).published,
    );
    expect(published[0] + published[1]).toBe(4);

    // Nothing left behind, and nothing sent twice.
    const stillUnpublished = await db<{ count: string }>(
      `select count(*)::text as count from "outbox_messages"
        where published_at is null`,
    );
    expect(Number(stillUnpublished[0].count)).toBe(0);
    expect(await queueDepth(env.sqs.queueUrl)).toBe(4);

    for (const walletId of walletIds) {
      await assertWalletMatchesLedger(walletId);
    }
  });

  it('7. resolves a REFUND delivered before the bet it reverses', async () => {
    const walletId = await givenWallet('player-reversal', '100.00');

    // The reversal arrives first and names a bet that does not exist yet.
    // §7.1 calls this expected ordering, not an error: the submission answers
    // PENDING_REFERENCE rather than refusing.
    const refund = pinnedBet(
      'player-reversal',
      walletId,
      'ext-refund-1',
      '25.00',
      {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet-1',
      },
    );

    const deferred = reportOf(
      (await runWorker({ op: 'submit', command: refund })).detail,
    );
    expect(deferred.status).toBe(WagerTransactionStatus.PendingReference);

    // No money moved while the reference was missing.
    expect(await balanceOf(walletId)).toBe('100.00');
    expect(await pendingReferenceCount()).toBe(1);

    // The bet it was waiting for finally lands.
    const betCommand = pinnedBet(
      'player-reversal',
      walletId,
      'ext-bet-1',
      '25.00',
    );
    const landed = reportOf(
      (await runWorker({ op: 'submit', command: betCommand })).detail,
    );
    expect(landed.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(walletId)).toBe('75.00');

    // The reference worker replays the deferred submission — the same code
    // path, so the refund cannot drift from what was originally accepted.
    await makeDue(deferred.transactionId);
    const resolved = await runWorker({ op: 'resolve-references' });
    expect(resolved.ok).toBe(true);

    expect(await pendingReferenceCount()).toBe(0);
    expect(await balanceOf(walletId)).toBe('100.00');

    // Bet then refund is a net zero, and the ledger shows both movements.
    expect(await ledgerRowsFor(landed.transactionId)).toBe(1);
    expect(await ledgerRowsFor(deferred.transactionId)).toBe(1);

    await assertWalletMatchesLedger(walletId);
  });
});
