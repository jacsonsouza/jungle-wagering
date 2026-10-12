import type { EntityManager } from '@mikro-orm/core';
import type { OutboxMessage } from '../domain/index.js';

/**
 * The outbox row is written inside the SAME transaction as the state change it
 * describes. That is the whole point: either both are committed, or neither is
 * — so an event can never describe a balance change that was rolled back.
 */
export interface OutboxRepositoryPort {
  insert(tx: EntityManager, message: OutboxMessage): Promise<void>;

  /**
   * Claims up to `limit` due rows for THIS publisher and returns them.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes many publishers safe on one outbox
   * (§11): each one takes a disjoint slice, and a second publisher never
   * blocks on — or steals — the first one's rows.
   *
   * The claim is a lease, not a lock: `next_attempt_at` is pushed forward by
   * `leaseMs` and the row is released. A publisher that dies mid-flight
   * therefore leaves the row to expire back into the due set instead of
   * holding a lock on a dead connection — and a duplicate publish is safe,
   * because the consumer dedupes.
   */
  claimDue(
    em: EntityManager,
    options: {
      readonly limit: number;
      readonly now: Date;
      readonly leaseMs: number;
    },
  ): Promise<readonly OutboxMessage[]>;

  /** Marks a claimed row published. Idempotent: a second call changes nothing. */
  markPublished(em: EntityManager, id: string, at: Date): Promise<void>;

  /**
   * Reschedules a failed publish with exponential backoff, or gives up when
   * the attempt budget is spent — the row stays unpublished so an operator can
   * see it, and the metric records the loss.
   */
  scheduleRetry(
    em: EntityManager,
    id: string,
    now: Date,
    attempts: number,
  ): Promise<void>;
}
