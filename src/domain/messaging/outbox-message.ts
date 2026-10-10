import type { IntegrationEvent } from '../events/integration-event.js';
import { FailureCode } from '../failures/failure-code.js';
import { DomainError } from '../shared/domain-error.js';
import { computeBackoff } from './backoff.js';

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date;
  readonly publishedAt?: Date;
}

class InvalidMessageStateError extends DomainError {
  readonly code = FailureCode.InvalidMessageState;
}

export class OutboxMessage {
  private _attempts: number;
  private _nextAttemptAt?: Date;
  private _publishedAt?: Date;

  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    attempts: number,
    nextAttemptAt?: Date,
    publishedAt?: Date,
  ) {
    this._attempts = attempts;
    this._nextAttemptAt = nextAttemptAt;
    this._publishedAt = publishedAt;
  }

  /** The factory derives everything from the envelope — call sites never hand-build payloads. */
  static enqueue(
    event: IntegrationEvent<Record<string, unknown>>,
  ): OutboxMessage {
    const envelope = event.toJSON();

    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze({ ...envelope }),
      new Date(event.occurredAt.getTime()),
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      Object.freeze({ ...state.payload }),
      new Date(state.occurredAt.getTime()),
      state.attempts,
      state.nextAttemptAt ? new Date(state.nextAttemptAt.getTime()) : undefined,
      state.publishedAt ? new Date(state.publishedAt.getTime()) : undefined,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt
      ? new Date(this._nextAttemptAt.getTime())
      : undefined;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt
      ? new Date(this._publishedAt.getTime())
      : undefined;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt <= now)
    );
  }

  /** Idempotent: publishing twice never rewrites history. */
  markPublished(at: Date): void {
    if (!this.isPending()) return;

    this._publishedAt = new Date(at.getTime());
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(
        'published messages cannot be retried',
        { id: this.id },
      );
    }

    this._attempts += 1;
    this._nextAttemptAt = new Date(
      now.getTime() + computeBackoff(this.attempts),
    );
  }
}
