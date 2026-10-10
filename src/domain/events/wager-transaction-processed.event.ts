import { MoneyProps } from '../money/money-props.js';
import { WagerTransactionKind } from '../shared/enums.js';
import { WagerTransaction } from '../transaction/wager-transaction.js';
import {
  EventContext,
  EventData,
  IntegrationEvent,
  IntegrationEventEnvelope,
  IntegrationEventProps,
} from './integration-event.js';

/**
 * Emitted for EVERY applied transaction — including LOSS, which produces no
 * ledger entry (§11). That is why the factory takes only the transaction:
 * it must not require a WalletLedgerEntry.
 */
export type WagerTransactionProcessedData = EventData & {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly processedAt: string; // ISO-8601
};

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  private static readonly EVENT_TYPE = 'WagerTransactionProcessed';
  private static readonly EVENT_VERSION = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionProcessedData>,
  ) {
    super(props);
  }

  get eventType(): string {
    return WagerTransactionProcessed.EVENT_TYPE;
  }

  get version(): number {
    return WagerTransactionProcessed.EVENT_VERSION;
  }

  static from(args: {
    readonly eventId: string;
    readonly transaction: WagerTransaction;
    readonly ctx: EventContext;
  }): WagerTransactionProcessed {
    const tx = args.transaction;
    const occurredAt = tx.processedAt ?? tx.createdAt;

    return new WagerTransactionProcessed({
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
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.props(), // Money → MoneyProps
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        processedAt: occurredAt.toISOString(),
      },
    });
  }

  static fromEnvelope(
    envelope: IntegrationEventEnvelope,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: envelope.eventId,
      aggregateId: envelope.aggregateId,
      correlationId: envelope.correlationId,
      causationId: envelope.causationId,
      occurredAt: new Date(envelope.occurredAt),
      data: envelope.data as WagerTransactionProcessedData,
    });
  }
}
