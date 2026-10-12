import type { CurrencyCode } from '../domain/index.js';
import { Wallet } from '../domain/index.js';
import type { WalletEntity } from '../entities/wallet.entity.js';

/**
 * Translation between the domain `Wallet` and the `wallets` table.
 *
 * `toDomain` rehydrates through `Wallet.rehydrate`, so persisted garbage
 * (bad currency, version < 1) fails loudly at the boundary instead of
 * becoming a plausible-looking wallet.
 */
export class WalletMapper {
  static toDomain(entity: WalletEntity): Wallet {
    // `Money.from` validates the currency, so the cast below is only a
    // type-level bridge — an unknown currency still throws on rehydrate.
    const currency = entity.currency as CurrencyCode;

    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency,
      balance: { amount: entity.balance, currency },
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  static toPersistence(wallet: Wallet, entity: WalletEntity): WalletEntity {
    const state = wallet.state();

    entity.id = state.id;
    entity.playerId = state.playerId;
    entity.currency = state.currency;
    entity.balance = state.balance.amount;
    entity.version = state.version;
    entity.createdAt = state.createdAt;
    entity.updatedAt = state.updatedAt;

    return entity;
  }
}
