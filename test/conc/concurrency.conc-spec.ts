import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import {
  CurrencyCode,
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/index.js';
import { SystemClock } from '../../src/ports/clock.port.js';
import { MikroOrmUnitOfWork } from '../../src/ports/unit-of-work.port.js';
import { MikroOrmOutboxRepository } from '../../src/repositories/outbox.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../src/repositories/wager-transaction.repository.js';
import { MikroOrmWalletRepository } from '../../src/repositories/wallet.repository.js';
import { CreateWalletUseCase } from '../../src/use-cases/create-wallet.use-case.js';
import type { SubmitTransactionCommand } from '../../src/use-cases/submit-transaction.use-case.js';
import {
  closeTestOrm,
  db,
  dbRun,
  testOrm,
  truncateAllTables,
} from '../setup/orm.js';
import {
  bodyOf,
  buildQueue,
  drainQueues,
  freshDedupId,
  queueDepth,
} from '../setup/sqs.js';
import {
  assertWalletMatchesLedger,
  ledgerRowsFor,
  runWorker,
  runWorkers,
} from './harness.js';

/**
 * The eight concurrency scenarios §13 makes mandatory, each running against
 * real PostgreSQL and real SQS with real OS processes.
 *
 * Two rules shape every test below. First, "paralelismo real, não mocks
 * sequenciais": contention comes from spawned processes released by a
 * handshake, never from `Promise.all` over a mocked repository — a mock would
 * answer the question the test exists to ask. Second, every scenario ends by
 * rebuilding the balance from the ledger, because the one bug with no
 * recovery path is money that stopped adding up.
 */

/** One sequence per process, so id generation never collides across workers. */
const sharedIds = { newId: () => randomUUID() };

/**
 * Creates a funded wallet from the spec process.
 *
 * Setup, not the thing under contention, so it runs in-process: spawning a
 * worker to create a wallet would add boot time to every scenario without
 * making the assertion any stronger.
 */
async function givenWallet(
  playerId: string,
  initialAmount: string,
): Promise<string> {
  const orm = await testOrm();

  const useCase = new CreateWalletUseCase(
    new MikroOrmUnitOfWork(orm.em),
    new MikroOrmWalletRepository(),
    new MikroOrmWagerTransactionRepository(),
    new MikroOrmOutboxRepository(),
    new SystemClock(),
    sharedIds,
  );

  const result = await useCase.execute({
    playerId,
    currency: CurrencyCode.BRL,
    initialAmount,
  });

  return result.wallet.id;
}

/**
 * A bet command. The owner is explicit: §8 makes `walletId` the unit of
 * concurrency, and the use case refuses a command whose `playerId` does not
 * own the wallet, so a hardcoded owner would fail every scenario but the first.
 */
function bet(
  playerId: string,
  walletId: string,
  amount: string,
  overrides: Partial<SubmitTransactionCommand> = {},
): SubmitTransactionCommand {
  const externalTransactionId = `ext-${randomUUID()}`;

  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: CurrencyCode.BRL },
    ...overrides,
  };
}

/** The same command every time — the "50 copies of one bet" shape. */
function pinnedBet(
  playerId: string,
  walletId: string,
  externalTransactionId: string,
  amount: string,
  overrides: Partial<SubmitTransactionCommand> = {},
): SubmitTransactionCommand {
  return bet(playerId, walletId, amount, {
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    ...overrides,
  });
}

/** Makes a PENDING_REFERENCE row due right now, without waiting out a backoff. */
async function makeDue(transactionId: string): Promise<void> {
  await dbRun(
    `update "wager_transactions"
        set pending_next_attempt_at = now() - interval '1 second'
      where id = '${transactionId}'`,
  );
}

/** How many PENDING_REFERENCE rows are still waiting for their reference. */
async function pendingReferenceCount(): Promise<number> {
  const rows = await db<{ count: string }>(
    `select count(*)::text as count from "wager_transactions"
      where status = '${WagerTransactionStatus.PendingReference}'`,
  );

  return Number(rows[0].count);
}

/** The stored balance of one wallet, as the database itself reports it. */
async function balanceOf(walletId: string): Promise<string> {
  const [row] = await db<{ balance: string }>(
    `select balance::text as balance from "wallets" where id = '${walletId}'`,
  );

  return row.balance;
}

/** Sends a command to the queue exactly as a provider would. */
async function sendToQueue(command: SubmitTransactionCommand): Promise<void> {
  const queue = buildQueue();

  await queue.send(env.sqs.queueUrl, {
    messageGroupId: command.walletId,
    deduplicationId: freshDedupId(),
    body: bodyOf(command),
  });
}

/** The shape every `submit` worker reports back. */
interface SubmitReport {
  readonly transactionId: string;
  readonly status: string;
  readonly idempotentReplay: boolean;
  readonly failureCode?: string;
}

function reportOf(detail: unknown): SubmitReport {
  return detail as SubmitReport;
}

describe('concurrency scenarios (§13)', () => {
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

  it('1. applies a bet sent 50 times in parallel exactly once', async () => {
    const walletId = await givenWallet('player-1', '1000.00');

    // All fifty submissions are the SAME operation: same external id, same
    // idempotency key. Anything but one debit means the lock or the dedupe
    // store failed under real contention.
    const command = pinnedBet('player-1', walletId, 'ext-race-50', '25.00');

    const results = await runWorkers(50, () => ({ op: 'submit', command }));
    const reports = results.map((result) => reportOf(result.detail));

    // Every copy gets the same answer — that is what replay means.
    expect(reports).toHaveLength(50);
    expect(reports.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);

    // Exactly one copy did the work; the other 49 read the stored answer.
    const fresh = reports.filter((r) => !r.idempotentReplay);
    expect(fresh).toHaveLength(1);
    expect(reports.filter((r) => r.idempotentReplay)).toHaveLength(49);

    // And they all agree on which transaction it was.
    const transactionIds = new Set(reports.map((r) => r.transactionId));
    expect(transactionIds.size).toBe(1);

    // One debit in the ledger, not fifty.
    expect(await ledgerRowsFor(fresh[0].transactionId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('975.00');

    await assertWalletMatchesLedger(walletId);
  });

  it('2. settles two simultaneous 80.00 bets against a 100.00 wallet (§8)', async () => {
    const walletId = await givenWallet('player-hot', '100.00');

    // The mandatory §8 scenario: two bets that cannot both be afforded,
    // processed at the same instant from two separate processes.
    const first = bet('player-hot', walletId, '80.00');
    const second = bet('player-hot', walletId, '80.00');

    const results = await runWorkers(2, (index) => ({
      op: 'submit',
      command: index === 0 ? first : second,
    }));

    const reports = results.map((result) => reportOf(result.detail));
    const processed = reports.filter(
      (r) => r.status === WagerTransactionStatus.Processed,
    );
    const rejected = reports.filter(
      (r) => r.status === WagerTransactionStatus.Rejected,
    );

    // Exactly one wins, and the loser is refused on the merits.
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].failureCode).toBe(FailureCode.InsufficientFunds);

    // §8 states the final balance to the cent.
    expect(await balanceOf(walletId)).toBe('20.00');

    // One debit, and none for the refusal.
    expect(await ledgerRowsFor(processed[0].transactionId)).toBe(1);
    expect(await ledgerRowsFor(rejected[0].transactionId)).toBe(0);

    await assertWalletMatchesLedger(walletId);
  });

  it('3. processes bets on distinct wallets in parallel', async () => {
    // Eight wallets, eight bets, eight processes — no two touch the same row,
    // so nothing should serialize behind a lock it does not need.
    const walletIds = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        givenWallet(`player-${index}`, '500.00'),
      ),
    );

    const results = await runWorkers(8, (index) => ({
      op: 'submit',
      command: bet(`player-${index}`, walletIds[index], '100.00'),
    }));

    const reports = results.map((result) => reportOf(result.detail));
    expect(reports.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(reports.every((r) => !r.idempotentReplay)).toBe(true);

    for (const walletId of walletIds) {
      expect(await balanceOf(walletId)).toBe('400.00');
      await assertWalletMatchesLedger(walletId);
    }
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
    expect(reports.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);

    // Six distinct operations, six debits — no lost update, no duplicate.
    const transactionIds = new Set(reports.map((r) => r.transactionId));
    expect(transactionIds.size).toBe(6);

    expect(await balanceOf(walletId)).toBe('940.00');

    await assertWalletMatchesLedger(walletId);
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
    const refund = pinnedBet('player-reversal', walletId, 'ext-refund-1', '25.00', {
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-bet-1',
    });

    const deferred = reportOf(
      (await runWorker({ op: 'submit', command: refund })).detail,
    );
    expect(deferred.status).toBe(WagerTransactionStatus.PendingReference);

    // No money moved while the reference was missing.
    expect(await balanceOf(walletId)).toBe('100.00');
    expect(await pendingReferenceCount()).toBe(1);

    // The bet it was waiting for finally lands.
    const betCommand = pinnedBet('player-reversal', walletId, 'ext-bet-1', '25.00');
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
