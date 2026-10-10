import { MoneyProps } from '../money/money-props.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../shared/enums.js';
import { DomainError } from '../shared/domain-error.js';
import { FailureCode } from '../failures/failure-code.js';
import { WagerTransaction } from '../transaction/wager-transaction.js';
import {
  EventContext,
  EventData,
  IntegrationEvent,
  IntegrationEventEnvelope,
  IntegrationEventProps,
} from './integration-event.js';

/**
 * §7.8 / §11: fired when the reference does not exist yet — the transaction
 * moves to PENDING_REFERENCE and the worker reprocesses with exponential backoff.
 */
export type WagerTransactionPendingReferenceData = EventData & {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly kind: WagerTransactionKind;
  readonly status: WagerTransactionStatus;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly pendingSince: string; // ISO-8601
};

class InvalidTransactionStateError extends DomainError {
  readonly code = FailureCode.InvalidStateTransition;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  private static readonly EVENT_TYPE = 'WagerTransactionPendingReference';
  private static readonly EVENT_VERSION = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionPendingReferenceData>,
  ) {
    super(props);
  }

  get eventType(): string {
    return WagerTransactionPendingReference.EVENT_TYPE;
  }

  get version(): number {
    return WagerTransactionPendingReference.EVENT_VERSION;
  }

  static from(args: {
    readonly eventId: string;
    readonly transaction: WagerTransaction;
    readonly ctx: EventContext;
  }): WagerTransactionPendingReference {
    const tx = args.transaction;

    if (tx.status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        'pending reference events require a PENDING_REFERENCE transaction',
        { transactionId: tx.id, status: tx.status },
      );
    }

    const occurredAt = tx.processedAt ?? tx.createdAt;

    return new WagerTransactionPendingReference({
      eventId: args.eventId,
      aggregateId: tx.id,
      correlationId: args.ctx.correlationId,
      causationId: args.ctx.causationId,
      occurredAt,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        playerId: tx.playerId,
        walletId: tx.walletId,
        roundId: tx.roundId,
        kind: tx.kind,
        status: tx.status,
        money: tx.money.props(),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        pendingSince: occurredAt.toISOString(),
      },
    });
  }

  static fromEnvelope(
    envelope: IntegrationEventEnvelope,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: envelope.eventId,
      aggregateId: envelope.aggregateId,
      correlationId: envelope.correlationId,
      causationId: envelope.causationId,
      occurredAt: new Date(envelope.occurredAt),
      data: envelope.data as WagerTransactionPendingReferenceData,
    });
  }
}
