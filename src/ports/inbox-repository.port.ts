import type { EntityManager } from '@mikro-orm/core';
import type { InboxMessage } from '../domain/index.js';

/**
 * Persistent dedupe for messages that arrive from a queue (§10).
 *
 * The unique index on (consumer_name, message_id) IS the mechanism: the
 * consumer inserts the inbox row inside the same transaction as the effects,
 * so "already handled" is answered by the database rather than by memory —
 * which is the only way dedupe survives a crash and a redelivery.
 */
export interface InboxRepositoryPort {
  /**
   * Records the receipt. Throws a `UniqueConstraintViolationException` when
   * this (consumerName, messageId) pair was already recorded — the caller
   * treats that as "already handled" and acks without doing the work twice.
   */
  insert(tx: EntityManager, message: InboxMessage): Promise<void>;
}
