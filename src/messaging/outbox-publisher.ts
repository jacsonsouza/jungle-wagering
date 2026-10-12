import type { EntityManager } from '@mikro-orm/core';
import type { OutboxMessage } from '../domain/index.js';
import type { ClockPort } from '../ports/clock.port.js';
import type { LoggerPort } from '../ports/logger.port.js';
import type { MessageQueuePort } from '../ports/message-queue.port.js';
import type { MetricsPort } from '../ports/metrics.port.js';
import type { OutboxRepositoryPort } from '../ports/outbox-repository.port.js';
import type { UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import { OUTBOX_LEASE_MS } from '../repositories/outbox.repository.js';

/** How long one claim keeps rows away from other publishers. */
export const DEFAULT_LEASE_MS = OUTBOX_LEASE_MS;

/** Rows claimed per poll. Small on purpose: a publisher must not hoard work. */
const CLAIM_BATCH_SIZE = 50;

/** How long to wait between polls when the outbox was empty. */
const IDLE_POLL_MS = 1_000;

export interface OutboxPublisherOptions {
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly idlePollMs?: number;
  readonly maxAttempts?: number;
}

/**
 * Drains the outbox onto the queue (§11).
 *
 * The dangerous window is between "PostgreSQL committed" and "SQS accepted".
 * This class makes that window survivable rather than impossible:
 *
 *  1. A claim leases rows by pushing `next_attempt_at` forward, under
 *     `FOR UPDATE SKIP LOCKED`. Concurrent publishers therefore take disjoint
 *     slices and never block on each other.
 *  2. The publish happens OUTSIDE any database transaction. Holding a row lock
 *     across a network call would tie up a connection for as long as SQS takes
 *     to answer — and a slow broker would then stall every other publisher.
 *  3. Success is recorded afterwards, in its own short transaction.
 *
 * A crash between 2 and 3 leaves the lease to expire, so another publisher
 * picks the row up and sends it again. That duplicate is deliberate and safe:
 * §11 requires the consumer to be idempotent, and the inbox makes it so.
 */
export class OutboxPublisher {
  private running = false;
  private drain?: Promise<void>;

  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly outbox: OutboxRepositoryPort,
    private readonly queue: MessageQueuePort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly metrics: MetricsPort,
    private readonly queueUrl: string,
    private readonly options: OutboxPublisherOptions = {},
  ) {}

  /**
   * Starts draining. Resolves immediately; the loop runs until `stop()`.
   *
   * Returning a promise the caller can await on shutdown is what makes
   * `SIGTERM` graceful: in-flight publishes finish instead of being cut off
   * between "sent" and "recorded".
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.drain = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.drain;
  }

  /** One poll cycle. Public so tests can drive it without timers. */
  async publishBatch(): Promise<number> {
    // A WRITE transaction, not `read()`: the claim pushes `next_attempt_at`
    // forward, and PostgreSQL refuses an UPDATE inside a read-only
    // transaction. `SKIP LOCKED` still does its job here — concurrent
    // publishers take disjoint rows rather than queueing.
    const claimed = await this.uow.transaction((em) =>
      this.claimDue(em, this.clock.now()),
    );

    if (claimed.length === 0) return 0;

    let published = 0;

    for (const message of claimed) {
      const ok = await this.deliver(message);

      if (ok) published += 1;
    }

    return published;
  }

  private async loop(): Promise<void> {
    const idlePollMs = this.options.idlePollMs ?? IDLE_POLL_MS;

    while (this.running) {
      try {
        const published = await this.publishBatch();

        // Anything was waiting: come straight back for the next slice.
        if (published > 0) continue;
      } catch (error) {
        // A failure here is infrastructure, not data: the rows stay leased
        // and return to the due set on their own. Never let it kill the loop.
        this.logger.error('outbox publisher cycle failed', {}, error);
        this.metrics.increment('outbox_publish_failures_total');
      }

      await this.sleep(idlePollMs);
    }
  }

  private async claimDue(
    em: EntityManager,
    now: Date,
  ): Promise<readonly OutboxMessage[]> {
    const messages = await this.outbox.claimDue(em, {
      limit: this.options.batchSize ?? CLAIM_BATCH_SIZE,
      now,
      leaseMs: this.options.leaseMs ?? DEFAULT_LEASE_MS,
    });

    if (messages.length > 0) {
      this.metrics.observe(
        'outbox_lag_seconds',
        (now.getTime() - messages[0].occurredAt.getTime()) / 1000,
      );
    }

    return messages;
  }

  /**
   * Sends one event and records the outcome.
   *
   * Returns false when the event was given up on, so the caller can report an
   * honest batch count instead of pretending every claimed row was delivered.
   */
  private async deliver(message: OutboxMessage): Promise<boolean> {
    const startedAt = performance.now();

    try {
      await this.queue.send(this.queueUrl, {
        // The aggregate is the ordering key: events for one aggregate arrive
        // in order inside a group, while unrelated groups run in parallel.
        messageGroupId: message.aggregateId,
        // SQS dedupes on this id for five minutes, which collapses the
        // at-least-once window into effectively-once at the transport layer.
        // The inbox still guards everything beyond that window.
        deduplicationId: message.id,
        body: JSON.stringify(message.payload),
      });
    } catch (error) {
      await this.recordFailure(message, error);
      return false;
    }

    await this.recordSuccess(message, startedAt);

    return true;
  }

  private async recordSuccess(
    message: OutboxMessage,
    startedAt: number,
  ): Promise<void> {
    message.markPublished(this.clock.now());

    await this.uow.transaction((em) =>
      this.outbox.markPublished(em, message.id, this.clock.now()),
    );

    this.metrics.increment('outbox_published_total', {
      eventType: message.eventType,
    });
    this.metrics.observe(
      'outbox_publish_duration_seconds',
      (performance.now() - startedAt) / 1000,
      { eventType: message.eventType },
    );

    this.logger.debug('outbox event published', {
      outboxId: message.id,
      eventType: message.eventType,
      aggregateId: message.aggregateId,
    });
  }

  /**
   * Retries with backoff until the attempt budget is spent.
   *
   * The row is never deleted. An event that could not be delivered is money that
   * happened but was not announced, so it stays visible for an operator —
   * silently dropping it would trade a loud problem for a quiet one.
   */
  private async recordFailure(
    message: OutboxMessage,
    error: unknown,
  ): Promise<void> {
    const attempts = message.attempts + 1;
    const maxAttempts = this.options.maxAttempts ?? MAX_PUBLISH_ATTEMPTS;

    await this.uow.transaction((em) =>
      this.outbox.scheduleRetry(em, message.id, this.clock.now(), attempts),
    );

    this.metrics.increment('outbox_publish_failures_total', {
      eventType: message.eventType,
    });

    if (attempts >= maxAttempts) {
      this.logger.error(
        'outbox event exhausted its publish attempts',
        {
          outboxId: message.id,
          eventType: message.eventType,
          aggregateId: message.aggregateId,
          attempts,
        },
        error,
      );
      this.metrics.increment('outbox_events_abandoned_total', {
        eventType: message.eventType,
      });
      return;
    }

    this.logger.warn('outbox publish failed, will retry', {
      outboxId: message.id,
      eventType: message.eventType,
      attempts,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * After this many failed publishes an event is abandoned and flagged loudly.
 *
 * The backoff already spans ~8 minutes by then, so this is a genuine "the
 * broker is not coming back" signal rather than a transient blip.
 */
export const MAX_PUBLISH_ATTEMPTS = 10;
