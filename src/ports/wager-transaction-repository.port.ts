import type { EntityManager } from '@mikro-orm/core';
import type { WagerTransaction } from '../domain/index.js';

export interface WagerTransactionRepositoryPort {
  /**
   * `walletId` is passed separately because the aggregate id lives on the
   * entity's foreign key, not on the domain object — keeping the domain free
   * of persistence concerns.
   */
  insert(
    tx: EntityManager,
    transaction: WagerTransaction,
    walletId: string,
  ): Promise<void>;

  update(tx: EntityManager, transaction: WagerTransaction): Promise<void>;

  /**
   * The idempotency lookup — §9 makes the `Idempotency-Key` header the source
   * of truth for a replay, so this is keyed on that column alone and backed by
   * the `uq_wager_tx_idempotency_key` unique index. In-memory dedupe is
   * explicitly forbidden by §5.2: only the database decides.
   */
  findByIdempotencyKey(
    tx: EntityManager,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null>;

  findById(
    tx: EntityManager,
    transactionId: string,
  ): Promise<WagerTransaction | null>;

  /**
   * Finds by (providerId, externalTransactionId) — the provider's own id for
   * the operation. Two jobs: it is an independent guard against resubmitting
   * under a fresh Idempotency-Key, and it resolves the reference a
   * REFUND/ROLLBACK points at.
   */
  findByProviderExternal(
    tx: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;

  /**
   * The one reversal a reference is allowed to have (§5.3). Reads the partial
   * unique index `uq_wager_tx_single_reversal`, so it answers from the same
   * guarantee the database enforces.
   */
  findReversalForReference(
    tx: EntityManager,
    referenceTransactionId: string,
  ): Promise<WagerTransaction | null>;

  /**
   * Arms the reference worker for a transaction that just became
   * PENDING_REFERENCE (§7.1) — without this, `pending_next_attempt_at` stays
   * NULL, the row never enters `idx_wager_tx_pending_due`, and the worker
   * never sees it.
   *
   * Deliberately a separate method instead of being folded into `update`:
   * `pendingAttempts`/`pendingNextAttemptAt` are worker state, not domain
   * state, and the mapper refuses to touch them so an ordinary state write can
   * never clobber a backoff the worker is already counting.
   */
  schedulePendingAttempt(
    tx: EntityManager,
    transactionId: string,
    attempts: number,
    dueAt: Date,
  ): Promise<void>;

  /**
   * The reference worker's work queue: every PENDING_REFERENCE row whose next
   * attempt is due.
   *
   * `FOR UPDATE SKIP LOCKED` so several workers can drain the same backlog
   * without contending — each takes a disjoint slice, exactly like the outbox
   * publisher. Ordered by due time so the oldest deferral is retried first.
   *
   * The attempt count rides along deliberately instead of living on the
   * aggregate: it is the WORKER's schedule, and keeping it out of the domain
   * is what stops a retry mechanism from leaking into business invariants.
   */
  findDueForPendingReference(
    tx: EntityManager,
    now: Date,
    limit: number,
  ): Promise<readonly PendingReferenceDue[]>;

  /**
   * Clears the worker's schedule once a deferred transaction finally resolves,
   * so the row stops matching `idx_wager_tx_pending_due`.
   */
  clearPendingSchedule(
    tx: EntityManager,
    transactionId: string,
  ): Promise<void>;
}

/** A PENDING_REFERENCE row that is due, with the worker's own bookkeeping. */
export interface PendingReferenceDue {
  readonly transaction: WagerTransaction;
  /** How many attempts have already been made (the submission armed #1). */
  readonly attempts: number;
}
