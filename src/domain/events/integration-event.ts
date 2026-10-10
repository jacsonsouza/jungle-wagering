import { MoneyProps } from '../money/money-props.js';

export type EventData = Record<string, unknown>;
export type EventMoney = MoneyProps;

export interface EventContext {
  readonly correlationId: string;
  /** Optional (§11): present when the event was caused by another event. */
  readonly causationId?: string;
}

export interface IntegrationEventProps<TData extends EventData> {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: TData;
}

export interface IntegrationEventEnvelope {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string; // ISO-8601
  readonly version: number;
  readonly data: EventData;
}

export abstract class IntegrationEvent<TData extends EventData> {
  // eventType/version are getters (not readonly fields) because the base
  // constructor freezes `this` before subclass fields initialize — a
  // `readonly eventType = 'X'` would throw a TypeError in strict mode.
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<TData>;

  protected constructor(props: IntegrationEventProps<TData>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt.getTime());
    this.data = Object.freeze({ ...props.data });
    Object.freeze(this);
  }

  toJSON(): IntegrationEventEnvelope {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
