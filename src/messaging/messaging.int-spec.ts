import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import {
  CurrencyCode,
  InboxMessage,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/index.js';
import { env } from '../config/env.js';
import { SystemClock } from '../ports/clock.port.js';
import type { IdGeneratorPort } from '../ports/id-generator.port.js';
import type { MetricsPort } from '../ports/metrics.port.js';
import { MikroOrmUnitOfWork } from '../ports/unit-of-work.port.js';
import { MikroOrmInboxRepository } from '../repositories/inbox.repository.js';
import { MikroOrmOutboxRepository } from '../repositories/outbox.repository.js';
import { MikroOrmWagerTransactionRepository } from '../repositories/wager-transaction.repository.js';
import { MikroOrmWalletRepository } from '../repositories/wallet.repository.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { ReferenceWorker, MAX_PENDING_ATTEMPTS } from './reference-worker.js';
import { TransactionConsumer } from './transaction-consumer.js';
import { CreateWalletUseCase } from '../use-cases/create-wallet.use-case.js';
import type { SubmitTransactionCommand } from '../use-cases/submit-transaction.use-case.js';
import { SubmitTransactionUseCase } from '../use-cases/submit-transaction.use-case.js';
import {
  closeTestOrm,
  db,
  dbRun,
  testOrm,
  truncateAllTables,
} from '../../test/setup/orm.js';
import {
  bodyOf,
  buildQueue,
  drainQueues,
  freshDedupId,
  queueDepth,
} from '../../test/setup/sqs.js';
import {
  quietLogger,
  recordingMetrics,
} from '../../test/setup/observability.js';

/**
 * The messaging layer against real PostgreSQL and real SQS (LocalStack).
 *
 * The unit suite cannot prove the three things that matter here: that the
 * inbox's unique index really rejects a redelivery, that a message really
 * leaves the queue only after the commit, and that a poison payload really
 * lands on the dead-letter queue. All three are transport and database
 * behaviour, so all three need the transport and the database.
 */

/**
 * One sequence shared by every instance in the file: two use cases drawing ids
 * independently would generate the same UUIDs and collide on the primary key.
 * Each concurrent instance has to look like a separate process.
 *
 * Random, not a counter. A counter restarts at zero in every test process, so
 * the outbox rows carry the same ids run after run — and since the publisher
 * uses the row id as the FIFO deduplication id, SQS silently drops the sends
 * of any run that follows another within five minutes. Tests that need
 * predictable ids build their own generator instead.
 */
const sharedIds: IdGeneratorPort = {
  newId: () => randomUUID(),
};

async function buildSubmit(
  ids: IdGeneratorPort = sharedIds,
  metrics: MetricsPort = recordingMetrics(),
) {
  const orm = await testOrm();

  return new SubmitTransactionUseCase(
    new MikroOrmUnitOfWork(orm.em),
    new MikroOrmWalletRepository(),
    new MikroOrmWagerTransactionRepository(),
    new MikroOrmOutboxRepository(),
    new SystemClock(),
    ids,
    quietLogger,
    metrics,
  );
}

async function buildConsumer(metrics: MetricsPort = recordingMetrics()) {
  const orm = await testOrm();

  return new TransactionConsumer(
    new MikroOrmUnitOfWork(orm.em),
    new MikroOrmInboxRepository(),
    await buildSubmit(),
    buildQueue(),
    new SystemClock(),
    quietLogger,
    metrics,
    env.sqs.queueUrl,
    env.sqs.dlqUrl,
    // Short waits: an idle poll must not cost a test its patience, and the
    // assertions below are about outcome, not about long-polling.
    { maxMessages: 10, waitTimeSeconds: 1, visibilityTimeoutSeconds: 30 },
  );
}

async function buildPublisher(metrics: MetricsPort = recordingMetrics()) {
  const orm = await testOrm();

  return new OutboxPublisher(
    new MikroOrmUnitOfWork(orm.em),
    new MikroOrmOutboxRepository(),
    buildQueue(),
    new SystemClock(),
    quietLogger,
    metrics,
    env.sqs.queueUrl,
  );
}

async function buildReferenceWorker(metrics: MetricsPort = recordingMetrics()) {
  const orm = await testOrm();

  return new ReferenceWorker(
    new MikroOrmUnitOfWork(orm.em),
    new MikroOrmWagerTransactionRepository(),
    new MikroOrmWalletRepository(),
    new MikroOrmOutboxRepository(),
    await buildSubmit(),
    new SystemClock(),
    sharedIds,
    quietLogger,
    metrics,
  );
}

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

function command(
  walletId: string,
  externalTransactionId: string,
  overrides: Partial<SubmitTransactionCommand> = {},
): SubmitTransactionCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: 'player-1',
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: CurrencyCode.BRL },
    ...overrides,
  };
}

async function count(table: string): Promise<number> {
  const rows = await db<{ count: string }>(
    `select count(*)::text as count from "${table}"`,
  );

  return Number(rows[0].count);
}

/**
 * The invariant every financial scenario re-checks: the balance a wallet
 * claims is exactly what its own ledger adds up to.
 */
async function assertWalletMatchesLedger(walletId: string): Promise<void> {
  const [wallet] = await db<{ balance: string }>(
    `select balance::text as balance from "wallets" where id = '${walletId}'`,
  );

  const [ledger] = await db<{ rebuilt: string }>(
    `select coalesce(
              sum(case when direction = 'CREDIT' then amount else -amount end),
              0.00
            )::text as rebuilt
       from "wallet_ledger_entries"
      where wallet_id = '${walletId}'`,
  );

  expect({ stored: wallet.balance, rebuilt: ledger.rebuilt }).toEqual({
    stored: ledger.rebuilt,
    rebuilt: ledger.rebuilt,
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

describe('messaging layer (integration)', () => {
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

  describe('OutboxPublisher', () => {
    it('publishes a committed event and marks the row published', async () => {
      const walletId = await givenWallet('player-1', '100.00');

      // CreateWallet committed WalletBalanceChanged into the outbox atomically
      // with the wallet row. Nothing has been announced yet.
      expect(await count('outbox_messages')).toBe(1);

      const publisher = await buildPublisher();
      const published = await publisher.publishBatch();

      expect(published).toBe(1);

      const [row] = await db<{ published_at: string | null }>(
        `select published_at::text as published_at from "outbox_messages"`,
      );
      expect(row.published_at).not.toBeNull();

      // The event really reached SQS — not merely a database row that says so.
      expect(await queueDepth(env.sqs.queueUrl)).toBe(1);

      await assertWalletMatchesLedger(walletId);
    });

    it('publishes nothing on a second pass, so a batch is not re-sent', async () => {
      await givenWallet('player-1', '100.00');

      const publisher = await buildPublisher();
      await publisher.publishBatch();
      const second = await publisher.publishBatch();

      expect(second).toBe(0);
      expect(await queueDepth(env.sqs.queueUrl)).toBe(1);
    });

    it('lets a second publisher claim a disjoint slice of the same outbox', async () => {
      // §11: several publishers must share one outbox without stealing from
      // each other. Two wallets produce two independent events.
      await givenWallet('player-1', '100.00');
      await givenWallet('player-2', '100.00');

      const [a, b] = await Promise.all([buildPublisher(), buildPublisher()]);

      // Both drain concurrently. `SKIP LOCKED` is what keeps them from both
      // taking the same row; the totals below are what proves it worked.
      const results = await Promise.all([a.publishBatch(), b.publishBatch()]);

      expect(results[0] + results[1]).toBe(2);

      const unpublished = await db<{ id: string }>(
        `select id from "outbox_messages" where published_at is null`,
      );
      expect(unpublished).toHaveLength(0);
    });
  });

  describe('TransactionConsumer', () => {
    it('applies a wager, records the inbox and acks the message', async () => {
      const walletId = await givenWallet('player-1', '100.00');
      const queue = buildQueue();

      await queue.send(env.sqs.queueUrl, {
        messageGroupId: walletId,
        deduplicationId: freshDedupId(),
        body: bodyOf(command(walletId, 'ext-1')),
      });

      const metrics = recordingMetrics();
      const consumer = await buildConsumer(metrics);
      expect(await consumer.consumeOnce()).toBe(1);

      const [transaction] = await db<{ status: string }>(
        `select status from "wager_transactions" where external_transaction_id = 'ext-1'`,
      );
      expect(transaction.status).toBe(WagerTransactionStatus.Processed);

      // §12: the queue path counts and times its own answers, separately from
      // the HTTP one — a message's processing time spans the inbox write and
      // the whole transaction, which is a different number.
      expect(
        metrics.seen.find((m) => m.name === 'consumer_processed_total')?.labels,
      ).toEqual({ status: WagerTransactionStatus.Processed });
      expect(
        metrics.seen.find((m) => m.name === 'message_processing_seconds')
          ?.seconds,
      ).toBeGreaterThanOrEqual(0);

      expect(await count('inbox_messages')).toBe(1);

      // Acked: the message is gone from the main queue, not merely invisible.
      expect(await queueDepth(env.sqs.queueUrl)).toBe(0);

      const [wallet] = await db<{ balance: string }>(
        `select balance::text as balance from "wallets" where id = '${walletId}'`,
      );
      expect(wallet.balance).toBe('75.00');

      await assertWalletMatchesLedger(walletId);
    });

    it('rejects an unaffordable bet on the merits and acks rather than dead-lettering', async () => {
      const walletId = await givenWallet('player-1', '10.00');
      const queue = buildQueue();

      await queue.send(env.sqs.queueUrl, {
        messageGroupId: walletId,
        deduplicationId: freshDedupId(),
        body: bodyOf(command(walletId, 'ext-poor')),
      });

      const consumer = await buildConsumer();
      await consumer.consumeOnce();

      const [transaction] = await db<{
        status: string;
        failure_code: string;
      }>(
        `select status, failure_code from "wager_transactions"
          where external_transaction_id = 'ext-poor'`,
      );

      // A business refusal is terminal: persisted, auditable, and acked. It
      // must never reach the DLQ, because redelivery cannot change the answer.
      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failure_code).toBe('INSUFFICIENT_FUNDS');
      expect(await queueDepth(env.sqs.dlqUrl)).toBe(0);
      expect(await queueDepth(env.sqs.queueUrl)).toBe(0);

      const [wallet] = await db<{ balance: string }>(
        `select balance::text as balance from "wallets" where id = '${walletId}'`,
      );
      expect(wallet.balance).toBe('10.00');

      await assertWalletMatchesLedger(walletId);
    });

    it('dead-letters a payload that can never be parsed', async () => {
      const queue = buildQueue();

      await queue.send(env.sqs.queueUrl, {
        messageGroupId: 'poison',
        deduplicationId: freshDedupId(),
        body: 'this is not json',
      });

      const metrics = recordingMetrics();
      const consumer = await buildConsumer(metrics);
      await consumer.consumeOnce();

      // Gone from the main queue AND present on the DLQ: a message nobody can
      // parse must not loop forever, and it must not vanish either.
      expect(await queueDepth(env.sqs.queueUrl)).toBe(0);
      expect(await queueDepth(env.sqs.dlqUrl)).toBe(1);
      expect(
        metrics.seen.some((m) => m.name === 'consumer_dead_letters_total'),
      ).toBe(true);
      expect(await count('wager_transactions')).toBe(0);
    });

    it('dead-letters an unknown currency instead of opening a transaction', async () => {
      const walletId = await givenWallet('player-1', '100.00');
      const queue = buildQueue();

      await queue.send(env.sqs.queueUrl, {
        messageGroupId: walletId,
        deduplicationId: freshDedupId(),
        body: bodyOf(
          command(walletId, 'ext-xcd', {
            money: { amount: '25.00', currency: 'XCD' as CurrencyCode },
          }),
        ),
      });

      const consumer = await buildConsumer();
      await consumer.consumeOnce();

      // The message is dead-lettered, and nothing about it was persisted.
      //
      // Scoped to the message's own external id rather than the whole table:
      // `givenWallet` writes an OPENING transaction, so a table-wide count
      // would be 1 even with the consumer behaving perfectly.
      expect(await queueDepth(env.sqs.dlqUrl)).toBe(1);

      const [applied] = await db<{ id: string }>(
        `select id from "wager_transactions"
          where external_transaction_id = 'ext-xcd'`,
      );
      expect(applied).toBeUndefined();
    });
  });

  describe('inbox dedupe', () => {
    it('refuses a second receipt of the same message for the same consumer', async () => {
      const orm = await testOrm();
      const inbox = new MikroOrmInboxRepository();
      const uow = new MikroOrmUnitOfWork(orm.em);

      const receipt = InboxMessage.receive({
        messageId: 'msg-dup',
        consumerName: 'wager-transactions-consumer',
        payloadHash: 'abc123',
        receivedAt: new SystemClock().now(),
      });

      await uow.transaction((tx) => inbox.insert(tx, receipt));

      // The unique index IS the mechanism (§10). This is the exact error the
      // consumer catches to mean "somebody already handled it".
      await expect(
        uow.transaction((tx) => inbox.insert(tx, receipt)),
      ).rejects.toBeInstanceOf(UniqueConstraintViolationException);

      expect(await count('inbox_messages')).toBe(1);
    });

    it('accepts the same message id under a different consumer name', async () => {
      const orm = await testOrm();
      const inbox = new MikroOrmInboxRepository();
      const uow = new MikroOrmUnitOfWork(orm.em);

      const now = new SystemClock().now();

      await uow.transaction((tx) =>
        inbox.insert(
          tx,
          InboxMessage.receive({
            messageId: 'msg-shared',
            consumerName: 'consumer-a',
            payloadHash: 'abc',
            receivedAt: now,
          }),
        ),
      );

      await uow.transaction((tx) =>
        inbox.insert(
          tx,
          InboxMessage.receive({
            messageId: 'msg-shared',
            consumerName: 'consumer-b',
            payloadHash: 'abc',
            receivedAt: now,
          }),
        ),
      );

      // The dedupe key is (consumer, message), not the message alone: two
      // independent consumers must each get their own copy.
      expect(await count('inbox_messages')).toBe(2);
    });
  });

  describe('ReferenceWorker', () => {
    it('resolves a deferral once the reference shows up', async () => {
      const walletId = await givenWallet('player-1', '100.00');
      const submit = await buildSubmit();

      // The refund arrives before its bet — expected ordering from a provider
      // that does not wait (§7.1).
      const deferred = await submit.execute(
        command(walletId, 'ext-refund', {
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'ext-bet',
        }),
      );

      expect(deferred.status).toBe(WagerTransactionStatus.PendingReference);

      const [row] = await db<{
        id: string;
        status: string;
        pending_attempts: number;
        pending_next_attempt_at: string;
      }>(
        `select id, status, pending_attempts,
                pending_next_attempt_at::text as pending_next_attempt_at
           from "wager_transactions"
          where external_transaction_id = 'ext-refund'`,
      );

      // The submission arms attempt #1; every later attempt is the worker's.
      expect(row.status).toBe('PENDING_REFERENCE');
      expect(row.pending_attempts).toBe(1);
      expect(row.pending_next_attempt_at).not.toBeNull();

      // Now the bet lands, and the deferral becomes due.
      await submit.execute(command(walletId, 'ext-bet'));
      await makeDue(row.id);

      const worker = await buildReferenceWorker();
      expect(await worker.runOnce()).toBe(1);

      const [resolved] = await db<{
        status: string;
        reference_transaction_id: string;
        pending_next_attempt_at: string | null;
      }>(
        `select status, reference_transaction_id,
                pending_next_attempt_at::text as pending_next_attempt_at
           from "wager_transactions"
          where external_transaction_id = 'ext-refund'`,
      );

      expect(resolved.status).toBe(WagerTransactionStatus.Processed);
      expect(resolved.reference_transaction_id).not.toBeNull();
      // Resolved rows leave the worker's queue, or they would be retried
      // forever against a transaction that is already answered.
      expect(resolved.pending_next_attempt_at).toBeNull();

      // The refund credited 25.00 after the bet debited 25.00.
      const [wallet] = await db<{ balance: string }>(
        `select balance::text as balance from "wallets" where id = '${walletId}'`,
      );
      expect(wallet.balance).toBe('100.00');

      await assertWalletMatchesLedger(walletId);
    });

    it('answers REJECTED with REFERENCE_NOT_FOUND once the budget is spent', async () => {
      const walletId = await givenWallet('player-1', '100.00');
      const submit = await buildSubmit();

      await submit.execute(
        command(walletId, 'ext-lonely', {
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'ext-never-arrives',
        }),
      );

      const [row] = await db<{ id: string }>(
        `select id from "wager_transactions"
          where external_transaction_id = 'ext-lonely'`,
      );

      // Ten attempts already made, and the reference is still missing.
      await dbRun(
        `update "wager_transactions"
            set pending_attempts = ${MAX_PENDING_ATTEMPTS},
                pending_next_attempt_at = now() - interval '1 second'
          where id = '${row.id}'`,
      );

      const worker = await buildReferenceWorker();
      await worker.runOnce();

      const [exhausted] = await db<{
        status: string;
        failure_code: string;
      }>(
        `select status, failure_code from "wager_transactions"
          where external_transaction_id = 'ext-lonely'`,
      );

      // A provider must get a terminal answer, never a 202 that never resolves.
      expect(exhausted.status).toBe(WagerTransactionStatus.Rejected);
      expect(exhausted.failure_code).toBe('REFERENCE_NOT_FOUND');

      // No money moved: the reversal that started this stays auditable as the
      // reason, and the balance is untouched.
      const [wallet] = await db<{ balance: string }>(
        `select balance::text as balance from "wallets" where id = '${walletId}'`,
      );
      expect(wallet.balance).toBe('100.00');

      await assertWalletMatchesLedger(walletId);
    });

    it('leaves a still-missing reference scheduled rather than answered', async () => {
      const walletId = await givenWallet('player-1', '100.00');
      const submit = await buildSubmit();

      await submit.execute(
        command(walletId, 'ext-patient', {
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'ext-later',
        }),
      );

      const [before] = await db<{
        id: string;
        pending_next_attempt_at: string;
      }>(
        `select id, pending_next_attempt_at::text as pending_next_attempt_at
           from "wager_transactions"
          where external_transaction_id = 'ext-patient'`,
      );

      await makeDue(before.id);

      const worker = await buildReferenceWorker();
      await worker.runOnce();

      const [after] = await db<{
        status: string;
        pending_attempts: number;
        pending_next_attempt_at: string | null;
      }>(
        `select status, pending_attempts,
                pending_next_attempt_at::text as pending_next_attempt_at
           from "wager_transactions"
          where external_transaction_id = 'ext-patient'`,
      );

      // Still waiting, one more attempt spent, and rescheduled — not answered.
      expect(after.status).toBe('PENDING_REFERENCE');
      expect(after.pending_attempts).toBe(2);
      expect(after.pending_next_attempt_at).not.toBeNull();
    });
  });
});
