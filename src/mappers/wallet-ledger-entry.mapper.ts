import { Money, WalletLedgerEntry } from '../domain/index.js';
import type { CurrencyCode } from '../domain/index.js';
import type { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';

export class WalletLedgerEntryMapper {
  static toPersistence(
    entry: WalletLedgerEntry,
    entity: WalletLedgerEntryEntity,
  ): WalletLedgerEntryEntity {
    const props = entry.props();

    entity.id = props.id;
    entity.transactionId = props.transactionId;
    entity.direction = props.direction;
    entity.amount = props.money.toString();
    entity.currency = props.money.currency;
    entity.balanceBefore = props.balanceBefore.toString();
    entity.balanceAfter = props.balanceAfter.toString();
    entity.createdAt = props.createdAt;

    return entity;
  }

  /**
   * Every column on `wallet_ledger_entries` is NOT NULL and non-optional, so
   * there is no `?? undefined` translation to get wrong here — unlike
   * `WagerTransactionMapper`, where a SQL NULL read back as `null` broke
   * `rehydrate`.
   *
   * Rehydration re-runs the balance invariant, so a corrupted row fails
   * loudly instead of being served as audit history.
   */
  static toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    // `Money.from` validates the currency, so the cast is only a type-level
    // bridge — an unknown currency still throws on rehydrate.
    const currency = entity.currency as CurrencyCode;

    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.wallet.id,
      transactionId: entity.transactionId,
      direction: entity.direction,
      money: Money.from({ amount: entity.amount, currency }),
      balanceBefore: Money.from({ amount: entity.balanceBefore, currency }),
      balanceAfter: Money.from({ amount: entity.balanceAfter, currency }),
      createdAt: entity.createdAt,
    });
  }
}
