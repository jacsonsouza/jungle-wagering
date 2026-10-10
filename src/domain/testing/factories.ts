import { Money } from '../money/money.js';
import { LedgerDirection, WagerTransactionKind } from '../shared/enums.js';
import { CurrencyCode } from '../shared/currency.js';
import { Wallet } from '../wallet/wallet.js';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import { WagerTransaction } from '../transaction/wager-transaction.js';
import type { EventContext } from '../events/integration-event.js';

/**
 * Shared fixtures for the domain tests. Fully deterministic:
 * fixed ids and timestamps, no Date.now()/Math.random().
 */
export const AT = new Date('2026-01-01T12:00:00.000Z');
export const LATER = new Date('2026-01-01T12:01:00.000Z');

export const CTX: EventContext = {
  correlationId: 'corr-1',
  causationId: 'cause-1',
};

export function money(amount: string, currency: CurrencyCode = 'BRL'): Money {
  return Money.from({ amount, currency });
}

export function openWallet(props?: {
  id?: string;
  playerId?: string;
  initialBalance?: string;
  openedAt?: Date;
}): Wallet {
  return Wallet.open({
    id: props?.id ?? 'wallet-1',
    playerId: props?.playerId ?? 'player-1',
    initialBalance: money(props?.initialBalance ?? '100.00'),
    openedAt: props?.openedAt ?? AT,
  });
}

export function ledgerEntry(props?: {
  id?: string;
  walletId?: string;
  transactionId?: string;
  direction?: LedgerDirection;
  amount?: string;
  balanceBefore?: string;
  createdAt?: Date;
}): WalletLedgerEntry {
  const direction = props?.direction ?? LedgerDirection.Credit;
  const before = money(props?.balanceBefore ?? '0.00');
  const amount = money(props?.amount ?? '25.00');
  const after =
    direction === LedgerDirection.Debit
      ? before.subtract(amount)
      : before.add(amount);

  return WalletLedgerEntry.create({
    id: props?.id ?? 'entry-1',
    walletId: props?.walletId ?? 'wallet-1',
    transactionId: props?.transactionId ?? 'tx-1',
    direction,
    money: amount,
    balanceBefore: before,
    balanceAfter: after,
    createdAt: props?.createdAt ?? AT,
  });
}

export function wagerTransaction(props?: {
  id?: string;
  kind?: WagerTransactionKind;
  amount?: string;
  referenceExternalTransactionId?: string;
  roundId?: string;
  providerId?: string;
  playerId?: string;
  walletId?: string;
}): WagerTransaction {
  return WagerTransaction.create({
    id: props?.id ?? 'tx-1',
    providerId: props?.providerId ?? 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    playerId: props?.playerId ?? 'player-1',
    walletId: props?.walletId ?? 'wallet-1',
    roundId: props?.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind: props?.kind ?? WagerTransactionKind.Bet,
    money: money(props?.amount ?? '25.00'),
    referenceExternalTransactionId: props?.referenceExternalTransactionId,
    createdAt: AT,
  });
}
