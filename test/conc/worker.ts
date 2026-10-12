import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import { CurrencyCode } from '../../src/domain/index.js';
import { env } from '../../src/config/env.js';
import { SystemClock } from '../../src/ports/clock.port.js';
import type { IdGeneratorPort } from '../../src/ports/id-generator.port.js';
import {
  quietLogger,
  recordingMetrics,
} from '../setup/observability.js';
import type {
  MessageQueuePort,
  OutgoingMessage,
  ReceivedMessage,
} from '../../src/ports/message-queue.port.js';
import { MikroOrmUnitOfWork } from '../../src/ports/unit-of-work.port.js';
import { MikroOrmInboxRepository } from '../../src/repositories/inbox.repository.js';
import { MikroOrmOutboxRepository } from '../../src/repositories/outbox.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../src/repositories/wager-transaction.repository.js';
import { MikroOrmWalletRepository } from '../../src/repositories/wallet.repository.js';
import { OutboxPublisher } from '../../src/messaging/outbox-publisher.js';
import { ReferenceWorker } from '../../src/messaging/reference-worker.js';
import { SqsMessageQueue } from '../../src/messaging/sqs-message-queue.js';
import { TransactionConsumer } from '../../src/messaging/transaction-consumer.js';
import { CreateWalletUseCase } from '../../src/use-cases/create-wallet.use-case.js';
import type { SubmitTransactionCommand } from '../../src/use-cases/submit-transaction.use-case.js';
import { SubmitTransactionUseCase } from '../../src/use-cases/submit-transaction.use-case.js';
import type { SubmitTransactionResult } from '../../src/use-cases/submit-transaction.use-case.js';

/**
 * A real OS process that performs one unit of work against the shared database.
 *
 * Every scenario in §13 that says "processo/instância" runs THIS script —
 * spawned as its own PID, with its own MikroORM instance and its own
 * connection pool. That is what makes "três ou mais instâncias" (§8) a fact
 * rather than a `Promise.all` pretending to be one.
 *
 * Synchronisation is a handshake, not a guessed timestamp: the worker prints
 * `ready` once its database pool is live, then blocks until the parent writes
 * `go`. Processes take a wildly variable time to boot, so a fixed delay would
 * stagger the "simultaneous" operations by hundreds of milliseconds — and the
 * race being tested would never happen. The handshake proves every process is
 * connected before any of them fires.
 *
 * Output protocol: exactly two JSON lines on stdout (`ready`, then `done`).
 * The parent parses only those, so a stray `console.log` in production code
 * cannot corrupt the conversation.
 */

/**
 * One operation a worker may perform.
 *
 * `startAt` is deliberately absent: it describes WHEN the work happens, not
 * WHAT happens, so it lives on the envelope below rather than being repeated
 * on every variant.
 */
export type ConcJob =
  | {
      readonly op: 'create-wallet';
      readonly playerId: string;
      readonly initialAmount: string;
    }
  | {
      readonly op: 'submit';
      readonly command: SubmitTransactionCommand;
    }
  | { readonly op: 'publish-outbox' }
  | {
      readonly op: 'consume-once';
      readonly skipAck?: boolean;
      /**
       * How long the message stays invisible if nobody acks it.
       *
       * §13.5 needs a redelivery to follow a "crash", and waiting out the
       * production visibility timeout would cost the suite half a minute per
       * case. A short one keeps the sequence identical — receive, commit, die,
       * become visible again — and just moves it along.
       */
      readonly visibilityTimeoutSeconds?: number;
    }
  | { readonly op: 'resolve-references' }
  | { readonly op: 'read-wallet'; readonly walletId: string };

/**
 * The worker's argv: just the operation. Timing is agreed over stdio, not
 * baked into the request — see `waitForGo`.
 */
export interface ConcRequest {
  readonly job: ConcJob;
}

/**
 * The worker's one-line reply. `phase` distinguishes the readiness signal
 * (`ready`) from the verdict (`done`) — the parent must not mistake the former
 * for a result.
 */
export interface ConcResult {
  readonly phase: 'ready' | 'done';
  readonly op?: string;
  readonly ok?: boolean;
  readonly detail?: unknown;
  readonly error?: string;
  /**
   * The OS process that produced this verdict.
   *
   * §13.4 asks for "≥ 3 processos/instâncias simultâneos". Reporting the pid
   * turns that from a claim about the harness into something a test can
   * assert: three results with three different pids really were three
   * processes, and one pid repeated would mean the barrier quietly ran them
   * in series.
   */
  readonly pid?: number;
}

/**
 * Counted, never exported.
 *
 * The worker has no Prometheus endpoint to expose to. Recording rather than
 * discarding keeps the double honest — it must genuinely satisfy
 * `MetricsPort` — without standing up a registry in fifty short-lived
 * processes.
 */
const silentMetrics = recordingMetrics();

/** Real UUIDs: several processes write concurrently and must not collide. */
const ids: IdGeneratorPort = { newId: () => randomUUID() };

/**
 * Wraps the real queue and swallows only the DELETE.
 *
 * §13 scenario 5 kills a worker *after* the commit but *before* the ack.
 * Rather than simulating that window with a mock — which would prove nothing —
 * this lets the genuine consumer run the genuine transaction and then drops
 * exactly the ack a `kill -9` in that instant would have dropped. The message
 * is left on the queue, for the next consumer to redeliver.
 */
function queueThatNeverAcks(inner: MessageQueuePort): MessageQueuePort {
  return {
    send: (queueUrl: string, message: OutgoingMessage) =>
      inner.send(queueUrl, message),
    receive: (queueUrl: string, options: Parameters<MessageQueuePort['receive']>[1]) =>
      inner.receive(queueUrl, options),
    release: (queueUrl: string, receiptHandle: string) =>
      inner.release(queueUrl, receiptHandle),
    sendToDeadLetter: (queueUrl: string, dlqUrl: string, message: ReceivedMessage) =>
      inner.sendToDeadLetter(queueUrl, dlqUrl, message),
    delete: () => Promise.resolve(),
  };
}

interface Context {
  readonly orm: MikroORM;
  readonly submit: SubmitTransactionUseCase;
  readonly createWallet: CreateWalletUseCase;
  readonly publisher: OutboxPublisher;
  readonly consumer: TransactionConsumer;
  readonly references: ReferenceWorker;
}

async function buildContext(
  consumerAcks: boolean,
  visibilityTimeoutSeconds?: number,
): Promise<Context> {
  const { default: config } = await import(
    '../../src/database/mikro-orm.config.js'
  );
  const orm = await MikroORM.init({
    ...config,
    // At most two connections per worker, not the driver's default of ten.
    //
    // A worker performs exactly one job, so ten would be idle capacity that
    // still counts against PostgreSQL's `max_connections` (100) — the §13
    // scenarios spawn fifty processes at once, and the default would exhaust
    // the server (500 connections) before a single assertion ran.
    //
    // One is not enough either, and the reason is worth writing down: a raw
    // `getConnection().execute()` inside `em.transactional` does NOT join the
    // transaction. It checks out its own connection and runs in autocommit, so
    // at `max: 1` the transaction holds the only connection while the raw
    // statement waits for one that can never become free. The worker then
    // deadlocks right after `BEGIN` and never answers the handshake.
    //
    // Two is the honest ceiling: one for the transaction, one for the raw
    // statement. Only `publish-outbox` ever reaches for the second (the outbox
    // claim); every other op is entity-only and stays on one — so the fifty
    // submit processes still cost fifty connections.
    pool: { min: 0, max: 2 },
  });

  const uow = new MikroOrmUnitOfWork(orm.em);
  const clock = new SystemClock();
  const queue = new SqsMessageQueue(env.sqs);

  const submit = new SubmitTransactionUseCase(
    uow,
    new MikroOrmWalletRepository(),
    new MikroOrmWagerTransactionRepository(),
    new MikroOrmOutboxRepository(),
    clock,
    ids,
    quietLogger,
    silentMetrics,
  );

  const createWallet = new CreateWalletUseCase(
    uow,
    new MikroOrmWalletRepository(),
    new MikroOrmWagerTransactionRepository(),
    new MikroOrmOutboxRepository(),
    clock,
    ids,
  );

  const publisher = new OutboxPublisher(
    uow,
    new MikroOrmOutboxRepository(),
    queue,
    clock,
    quietLogger,
    silentMetrics,
    env.sqs.queueUrl,
  );

  const consumer = new TransactionConsumer(
    uow,
    new MikroOrmInboxRepository(),
    submit,
    consumerAcks ? queue : queueThatNeverAcks(queue),
    clock,
    quietLogger,
    silentMetrics,
    env.sqs.queueUrl,
    env.sqs.dlqUrl,
    {
      maxMessages: env.sqs.maxMessages,
      waitTimeSeconds: env.sqs.waitTimeSeconds,
      visibilityTimeoutSeconds:
        visibilityTimeoutSeconds ?? env.sqs.visibilityTimeoutSeconds,
    },
  );

  const references = new ReferenceWorker(
    uow,
    new MikroOrmWagerTransactionRepository(),
    new MikroOrmWalletRepository(),
    new MikroOrmOutboxRepository(),
    submit,
    clock,
    ids,
    quietLogger,
    silentMetrics,
  );

  return { orm, submit, createWallet, publisher, consumer, references };
}

/**
 * Signals readiness and blocks until the parent says go.
 *
 * This replaces sleeping until a guessed timestamp. Fifty processes boot in
 * wildly different times — the slowest might need a second longer than the
 * fastest — and a fixed lead time that is too short silently turns a "race"
 * into a queue, which would still pass the assertions while proving nothing.
 *
 * Handshaking makes the simultaneity real: every worker is confirmed booted
 * and connected before any of them fires. The ready line also doubles as proof
 * that the process got as far as a live database connection, so a boot failure
 * surfaces as a clear error instead of a mysteriously serialized test.
 */
async function waitForGo(): Promise<void> {
  process.stdout.write('{"phase":"ready"}\n');

  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer): void => {
      if (chunk.toString().includes('go')) {
        cleanup();
        resolve();
      }
    };

    const onEnd = (): void => {
      // The parent closing stdin without a `go` means it gave up waiting for
      // someone else. Exiting quietly is better than hanging forever holding
      // a database connection.
      cleanup();
      resolve();
    };

    const cleanup = (): void => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
    };

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
  });
}

async function run(ctx: Context, job: ConcJob): Promise<unknown> {
  switch (job.op) {
    case 'create-wallet': {
      const result = await ctx.createWallet.execute({
        playerId: job.playerId,
        currency: CurrencyCode.BRL,
        initialAmount: job.initialAmount,
      });

      return { outcome: result.outcome, walletId: result.wallet.id };
    }

    case 'submit': {
      const result: SubmitTransactionResult = await ctx.submit.execute(
        job.command,
      );

      return {
        transactionId: result.transactionId,
        status: result.status,
        balance: result.balance,
        idempotentReplay: result.idempotentReplay,
        failureCode: result.failureCode,
      };
    }

    case 'publish-outbox':
      return { published: await ctx.publisher.publishBatch() };

    case 'consume-once':
      return { consumed: await ctx.consumer.consumeOnce() };

    // One poll cycle, no timers: the caller decides when the backlog is
    // drained, so the scenario stays deterministic instead of racing a loop.
    case 'resolve-references':
      return { resolved: await ctx.references.runOnce() };

    case 'read-wallet': {
      const wallet = await new MikroOrmWalletRepository().findById(
        ctx.orm.em,
        job.walletId,
      );

      return wallet === null ? null : { balance: wallet.balance.props() };
    }
  }
}

async function main(): Promise<void> {
  const raw = process.argv[2];

  if (raw === undefined) {
    throw new Error('worker: expected a JSON request as argv[2]');
  }

  const request = JSON.parse(raw) as ConcRequest;
  const { job } = request;

  // The consumer acks for every job except the one modelling a crash between
  // commit and ack (§13 scenario 5) — and that one also shortens the visibility
  // timeout so the redelivery it provokes does not cost the suite half a minute.
  const ctx = await buildContext(
    job.op !== 'consume-once' || !job.skipAck,
    job.op === 'consume-once' ? job.visibilityTimeoutSeconds : undefined,
  );

  try {
    // The database connection is established here, so "ready" means the pool
    // really did connect — not merely that the process started.
    await waitForGo();
    const detail = await run(ctx, job);

    process.stdout.write(
      `${JSON.stringify({
        phase: 'done',
        op: job.op,
        ok: true,
        detail,
        pid: process.pid,
      } satisfies ConcResult)}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        phase: 'done',
        op: job.op,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        pid: process.pid,
      } satisfies ConcResult)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await ctx.orm.close(true);
  }
}

await main();
