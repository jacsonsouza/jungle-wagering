import type { EntityManager } from '@mikro-orm/core';
import type { OutboxMessage } from '../domain/index.js';
import { OutboxMessage as Outbox } from '../domain/index.js';
import type { OutboxRepositoryPort } from '../ports/outbox-repository.port.js';
import { OutboxMessageEntity } from '../entities/outbox-message.entity.js';
import { OutboxMapper } from '../mappers/outbox.mapper.js';

/** How long a claimed row stays invisible before another publisher may take it. */
export const OUTBOX_LEASE_MS = 30_000;

/**
 * Column names as PostgreSQL returns them from `returning o.*`.
 *
 * The timestamps are typed as `Date | string` on purpose. MikroORM's raw
 * `execute` does not hydrate `timestamptz` — the driver hands back whatever
 * the wire gave it, which is a string. Claiming `Date` here would typecheck
 * and then throw at runtime on `getTime`, which is exactly what happened.
 */
interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string | null;
  published_at: Date | string | null;
}

/** Normalises a raw driver value into a Date. A Date passes through untouched. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export class MikroOrmOutboxRepository implements OutboxRepositoryPort {
  async insert(tx: EntityManager, message: OutboxMessage): Promise<void> {
    const entity = new OutboxMessageEntity();

    OutboxMapper.toPersistence(message, entity);

    await tx.persist(entity).flush();
  }

  async claimDue(
    em: EntityManager,
    options: {
      readonly limit: number;
      readonly now: Date;
      readonly leaseMs: number;
    },
  ): Promise<readonly OutboxMessage[]> {
    const leaseUntil = new Date(options.now.getTime() + options.leaseMs);

    // The lease is taken as `next_attempt_at` pushed into the future, inside
    // the same statement that selects the rows. `FOR UPDATE SKIP LOCKED` is
    // what makes concurrent publishers safe (§11): each one walks away with a
    // disjoint slice, and none of them ever blocks on — or steals from — a
    // publisher that is mid-flight.
    //
    // A publisher that dies here simply leaves the lease to expire, so the row
    // returns to the due set on its own. Nothing is lost, and at worst the
    // event is published twice — which §11 declares safe.
    // `returning o.*` hands back COLUMN names, so the row is typed as the
    // columns — not as `EntityDTO`, whose camelCase shape would silently fail
    // to line up and leave every field `undefined`.
    // `execute` is typed `QueryResult<T> | any | any[]`, so the union with
    // `any` swallows the generic. The annotation on `rows` is what actually
    // carries the shape through — without it every field below is `any`.
    const rows: OutboxRow[] = await em.getConnection().execute(
      `with due as (
         select id
         from outbox_messages
         where published_at is null
           and (next_attempt_at is null or next_attempt_at <= ?)
         order by next_attempt_at nulls first
         limit ?
         for update skip locked
       )
       update outbox_messages o
       set next_attempt_at = ?
       from due
       where o.id = due.id
       returning o.*`,
      [options.now, options.limit, leaseUntil],
      'all',
    );

    return rows.map((row) =>
      Outbox.rehydrate({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        // The driver hands back strings; the domain contract is Dates. This is
        // the one place the two shapes meet, so it is the one place that
        // converts — leaving it to `rehydrate` would just move the lie.
        occurredAt: toDate(row.occurred_at),
        attempts: row.attempts,
        nextAttemptAt:
          row.next_attempt_at === null ? undefined : toDate(row.next_attempt_at),
        publishedAt:
          row.published_at === null ? undefined : toDate(row.published_at),
      }),
    );
  }

  async markPublished(em: EntityManager, id: string, at: Date): Promise<void> {
    await em.nativeUpdate(
      OutboxMessageEntity,
      { id, publishedAt: null },
      { publishedAt: at, nextAttemptAt: null },
    );
  }

  async scheduleRetry(
    em: EntityManager,
    id: string,
    now: Date,
    attempts: number,
  ): Promise<void> {
    await em.nativeUpdate(
      OutboxMessageEntity,
      { id, publishedAt: null },
      { attempts, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)) },
    );
  }
}

/**
 * Publish backoff: 1s, 2s, 4s … capped at 5 minutes.
 *
 * Deliberately the same shape as the reference-worker backoff rather than a
 * second policy — one exponential curve to reason about, and no jitter here
 * because publishers coordinate through the lease, not through timing.
 */
function backoffMs(attempt: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}
