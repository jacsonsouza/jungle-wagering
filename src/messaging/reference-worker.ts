import type { EntityManager } from '@mikro-orm/core';
import {
  computeBackoff,
  FailureCode,
  OutboxMessage,
  WagerTransactionRejected,
  WagerTransactionStatus,
} from '../domain/index.js';
import type { WagerTransaction } from '../domain/index.js';
import type { ClockPort } from '../ports/clock.port.js';
import type { IdGeneratorPort } from '../ports/id-generator.port.js';
import type { LoggerPort } from '../ports/logger.port.js';
import type { MetricsPort } from '../ports/metrics.port.js';
import type { OutboxRepositoryPort } from '../ports/outbox-repository.port.js';
import type { UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import type { WalletRepositoryPort } from '../ports/wallet-repository.port.js';
import type { WagerTransactionRepositoryPort } from '../ports/wager-transaction-repository.port.js';
import type { SubmitTransactionUseCase } from '../use-cases/submit-transaction.use-case.js';

/**
 * §7.1: how many times a missing reference is retried before the transaction
 * is answered with `REFERENCE_NOT_FOUND`. The first attempt is armed by the
 * submission itself, so this is the TOTAL budget, not an extra one.
 */
export const MAX_PENDING_ATTEMPTS = 10;

/** Rows drained per poll. Small: each one is a full submission. */
const CLAIM_BATCH_SIZE = 20;

/** Idle poll interval. The backlog is normally empty, so this is the hot path. */
const IDLE_POLL_MS = 1_000;

/**
 * Resolves the references that were missing when a transaction was submitted.
 *
 * A reversal that arrives before its bet is not an error — it is expected
 * ordering from a provider that does not wait (§7.1). The submission answers
 * 202 and parks the row as PENDING_REFERENCE; this worker retries it on a
 * backoff until the reference shows up or the budget runs out.
 *
 * The retry is the SUBMISSION, re-run verbatim. Rebuilding the command from
 * the stored row and handing it back to `SubmitTransactionUseCase` is what
 * keeps one definition of "correct": a retry cannot drift from the original,
 * because it is literally the same code path — same scope checks, same ledger
 * writes, same events.
 *
 * `defer()` deliberately does not re-arm a row that is already
 * PENDING_REFERENCE, so the schedule is owned here, not by the use case.
 */
export class ReferenceWorker {
  private running = false;
  private idle?: Promise<void>;

  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly wagerTransactions: WagerTransactionRepositoryPort,
    private readonly wallets: WalletRepositoryPort,
    private readonly outbox: OutboxRepositoryPort,
    private readonly submit: SubmitTransactionUseCase,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    private readonly logger: LoggerPort,
    private readonly metrics: MetricsPort,
    private readonly options: {
      readonly batchSize?: number;
      readonly idlePollMs?: number;
    } = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.idle = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.idle;
  }

  /** One poll cycle, public so tests can drive it without timers. */
  async runOnce(): Promise<number> {
    const now = this.clock.now();

    // Pessimistic partial write = FOR UPDATE SKIP LOCKED, so several workers
    // may drain the same backlog and each takes a disjoint slice. A row is
    // therefore never retried by two workers at once, and neither blocks.
    const due = await this.uow.transaction((em) =>
      this.wagerTransactions.findDueForPendingReference(
        em,
        now,
        this.options.batchSize ?? CLAIM_BATCH_SIZE,
      ),
    );

    for (const item of due) {
      await this.retry(item.transaction, item.attempts);
    }

    return due.length;
  }

  private async loop(): Promise<void> {
    const idlePollMs = this.options.idlePollMs ?? IDLE_POLL_MS;

    while (this.running) {
      try {
        const processed = await this.runOnce();

        if (processed > 0) continue;
      } catch (error) {
        // Infrastructure only: the rows stay due and are picked up next poll.
        this.logger.error('reference worker cycle failed', {}, error);
        this.metrics.increment('reference_worker_failures_total');
      }

      await new Promise((resolve) => setTimeout(resolve, idlePollMs));
    }
  }

  /**
   * Re-runs one deferred transaction.
   *
   * Three outcomes, and the row's own status decides which:
   *  - the reference showed up → the submission processes it normally;
   *  - still missing, budget left → schedule the next attempt;
   *  - still missing, budget spent → REJECTED with REFERENCE_NOT_FOUND.
   */
  private async retry(
    transaction: WagerTransaction,
    attempts: number,
  ): Promise<void> {
    try {
      const result = await this.uow.transaction((em) =>
        this.resolve(em, transaction),
      );

      if (result.status !== WagerTransactionStatus.PendingReference) {
        await this.uow.transaction((em) =>
          this.wagerTransactions.clearPendingSchedule(em, transaction.id),
        );

        this.metrics.increment('reference_resolved_total', {
          status: result.status,
        });

        this.logger.info('pending reference resolved', {
          transactionId: transaction.id,
          status: result.status,
          attempts,
        });

        return;
      }

      // Still waiting for the reference. Without this branch the row keeps its
      // original schedule and is retried forever — the very opposite of the
      // bounded retries §7.1 asks for.
      if (attempts >= MAX_PENDING_ATTEMPTS) {
        await this.exhaust(transaction, attempts);
        return;
      }

      const nextAttempt = attempts + 1;

      await this.uow.transaction((em) =>
        this.wagerTransactions.schedulePendingAttempt(
          em,
          transaction.id,
          nextAttempt,
          new Date(this.clock.now().getTime() + computeBackoff(nextAttempt)),
        ),
      );

      this.metrics.increment('reference_deferred_total');
    } catch (error) {
      // A retry that fails on infrastructure is not an answer: the row stays
      // due and comes back next poll. Only a definitive exhaustion ends it.
      this.logger.warn('reference retry failed', {
        transactionId: transaction.id,
        attempts,
        reason: error instanceof Error ? error.message : String(error),
      });

      this.metrics.increment('reference_retry_failures_total');
    }
  }

  /**
   * Replays the submission inside the caller's transaction.
   *
   * The command is rebuilt from the stored row rather than from the original
   * payload, so the retry is exactly the operation that was accepted — a
   * provider cannot smuggle a different amount in on the second attempt.
   */
  private async resolve(em: EntityManager, transaction: WagerTransaction) {
    const state = transaction.state();

    return this.submit.executeIn(em, {
      providerId: state.providerId,
      externalTransactionId: state.externalTransactionId,
      idempotencyKey: state.idempotencyKey,
      playerId: state.playerId,
      walletId: state.walletId,
      roundId: state.roundId,
      gameId: state.gameId,
      kind: state.kind,
      money: state.money,
      referenceExternalTransactionId: state.referenceExternalTransactionId,
    });
  }

  /**
   * §7.1: the reference never arrived. The transaction is answered as
   * REJECTED, so the provider gets a terminal status instead of a 202 that
   * never resolves — and the reversal that started this stays auditable as the
   * reason.
   *
   * No money moves, so the wallet is read without a lock: there is nothing to
   * serialise against, and taking the lock here would contend with live
   * submissions for no benefit.
   */
  private async exhaust(
    transaction: WagerTransaction,
    attempts: number,
  ): Promise<void> {
    await this.uow.transaction(async (em) => {
      const wallet = await this.wallets.findById(em, transaction.walletId);

      if (wallet === null) {
        // The wallet is gone; there is nothing to record a balance against.
        // The transaction is left PENDING_REFERENCE rather than fabricated.
        this.logger.error('reference exhausted but wallet is missing', {
          transactionId: transaction.id,
          walletId: transaction.walletId,
        });
        return;
      }

      const now = this.clock.now();

      transaction.reject(FailureCode.ReferenceNotFound, now);
      transaction.recordResultBalance(wallet.balance);

      await this.wagerTransactions.update(em, transaction);

      await this.outbox.insert(
        em,
        OutboxMessage.enqueue(
          WagerTransactionRejected.from({
            eventId: this.ids.newId(),
            transaction,
            // The retry is caused by the original submission, so the original
            // transaction id is the causation — an operator can walk from the
            // rejection back to the call that created it.
            ctx: { correlationId: transaction.id, causationId: transaction.id },
          }),
        ),
      );
    });

    this.metrics.increment('reference_exhausted_total');

    this.logger.warn('pending reference exhausted', {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      attempts,
    });
  }
}
