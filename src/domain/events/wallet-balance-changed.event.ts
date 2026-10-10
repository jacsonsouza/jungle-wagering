import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import { MoneyProps } from '../money/money-props.js';
import { LedgerDirection } from '../shared/enums.js';
import { Wallet } from '../wallet/wallet.js';
import {
  EventContext,
  EventData,
  IntegrationEvent,
  IntegrationEventEnvelope,
  IntegrationEventProps,
} from './integration-event.js';

export type WalletBalanceChangedData = EventData & {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
};

/** Only when the balance changes (§11): LOSS and REJECTED never emit it. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  private static readonly EVENT_TYPE = 'WalletBalanceChanged';
  private static readonly EVENT_VERSION = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  get eventType(): string {
    return WalletBalanceChanged.EVENT_TYPE;
  }

  get version(): number {
    return WalletBalanceChanged.EVENT_VERSION;
  }

  static from(args: {
    readonly eventId: string;
    readonly wallet: Wallet;
    readonly entry: WalletLedgerEntry;
    readonly ctx: EventContext;
  }): WalletBalanceChanged {
    const entry = args.entry.props();

    return new WalletBalanceChanged({
      eventId: args.eventId,
      aggregateId: args.wallet.id,
      correlationId: args.ctx.correlationId,
      causationId: args.ctx.causationId,
      occurredAt: entry.createdAt,
      data: {
        walletId: args.wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.props(), // Money → MoneyProps
        balanceBefore: entry.balanceBefore.props(),
        balanceAfter: entry.balanceAfter.props(),
        walletVersion: args.wallet.version,
      },
    });
  }

  static fromEnvelope(
    envelope: IntegrationEventEnvelope,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: envelope.eventId,
      aggregateId: envelope.aggregateId,
      correlationId: envelope.correlationId,
      causationId: envelope.causationId,
      occurredAt: new Date(envelope.occurredAt),
      data: envelope.data as WalletBalanceChangedData,
    });
  }
}
