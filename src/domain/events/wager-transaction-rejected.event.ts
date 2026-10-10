import { FailureCode } from '../failures/failure-code.js';
import { MoneyProps } from '../money/money-props.js';
import { DomainError } from '../shared/domain-error.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../shared/enums.js';
import { WagerTransaction } from '../transaction/wager-transaction.js';
import {
  EventContext,
  EventData,
  IntegrationEvent,
  IntegrationEventEnvelope,
  IntegrationEventProps,
} from './integration-event.js';

/** §7.2: every rejection carries a stable, machine-readable failureCode. */
export type WagerTransactionRejectedData = EventData & {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly kind: WagerTransactionKind;
  readonly status: WagerTransactionStatus;
  readonly money: MoneyProps;
  readonly failureCode: FailureCode;
  readonly rejectedAt: string; // ISO-8601
};

class MissingFailureCodeError extends DomainError {
  readonly code = FailureCode.InvalidStateTransition;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  private static readonly EVENT_TYPE = 'WagerTransactionRejected';
  private static readonly EVENT_VERSION = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionRejectedData>,
  ) {
    super(props);
  }

  get eventType(): string {
    return WagerTransactionRejected.EVENT_TYPE;
  }

  get version(): number {
    return WagerTransactionRejected.EVENT_VERSION;
  }

  static from(args: {
    readonly eventId: string;
    readonly transaction: WagerTransaction;
    readonly ctx: EventContext;
  }): WagerTransactionRejected {
    const tx = args.transaction;

    if (tx.status !== WagerTransactionStatus.Rejected) {
      throw new MissingFailureCodeError(
        'rejected events require a REJECTED transaction',
        {
          transactionId: tx.id,
          status: tx.status,
        },
      );
    }

    if (tx.failureCode === undefined) {
      throw new MissingFailureCodeError(
        'rejected transactions must carry a failureCode',
        {
          transactionId: tx.id,
        },
      );
    }

    const occurredAt = tx.processedAt ?? tx.createdAt;

    return new WagerTransactionRejected({
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
        kind: tx.kind,
        status: tx.status,
        money: tx.money.props(),
        failureCode: tx.failureCode,
        rejectedAt: occurredAt.toISOString(),
      },
    });
  }

  static fromEnvelope(
    envelope: IntegrationEventEnvelope,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId: envelope.eventId,
      aggregateId: envelope.aggregateId,
      correlationId: envelope.correlationId,
      causationId: envelope.causationId,
      occurredAt: new Date(envelope.occurredAt),
      data: envelope.data as WagerTransactionRejectedData,
    });
  }
}
