import type {
  CurrencyCode,
  FailureCode,
  MoneyProps,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/index.js';
import { WagerTransaction } from '../domain/index.js';
import type { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';

export class WagerTransactionMapper {
  static toPersistence(
    transaction: WagerTransaction,
    entity: WagerTransactionEntity,
  ): WagerTransactionEntity {
    entity.id = transaction.id;
    entity.providerId = transaction.providerId;
    entity.externalTransactionId = transaction.externalTransactionId;
    entity.idempotencyKey = transaction.idempotencyKey;
    entity.payloadHash = transaction.payloadHash;
    entity.playerId = transaction.playerId;
    entity.roundId = transaction.roundId;
    entity.gameId = transaction.gameId;
    entity.kind = transaction.kind;
    entity.amount = transaction.money.toString();
    entity.currency = transaction.money.currency;
    entity.referenceExternalTransactionId =
      transaction.referenceExternalTransactionId;
    entity.status = transaction.status;
    entity.referenceTransactionId = transaction.referenceTransactionId;
    entity.failureCode = transaction.failureCode;
    entity.processedAt = transaction.processedAt;

    // Written as raw strings, never through a float: numeric(20,2) must not
    // round-trip through Number or a cent can silently appear or vanish.
    const resultBalance = transaction.resultBalance;
    entity.resultBalanceAmount = resultBalance?.toString();
    entity.resultBalanceCurrency = resultBalance?.currency;

    entity.createdAt = transaction.createdAt;

    return entity;
  }

  /**
   * `pendingAttempts` / `pendingNextAttemptAt` are deliberately NOT mapped.
   * They describe the reference worker's schedule (§7.1), not the transaction
   * — letting the domain touch them would drag worker mechanics into the
   * aggregate and risk the mapper clobbering a backoff the worker just wrote.
   */
  static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    // Each cast is only a type-level bridge: `WagerTransaction.rehydrate`
    // validates kind, status and failureCode, so a corrupt column throws at
    // this boundary instead of becoming a plausible-looking transaction.
    //
    // `?? undefined` is not cosmetic. MikroORM reads SQL NULL as JS `null`,
    // while the domain spells "absent" as `T | undefined`; `rehydrate` guards
    // with `!== undefined`, so a `null` straight from a nullable column would
    // sail past it and land inside the aggregate as a failureCode nobody can
    // name. The domain must never have to know that both spellings exist.
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.wallet.id,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind as WagerTransactionKind,
      money: {
        amount: entity.amount,
        currency: entity.currency as CurrencyCode,
      },
      referenceExternalTransactionId:
        entity.referenceExternalTransactionId ?? undefined,
      status: entity.status as WagerTransactionStatus,
      referenceTransactionId: entity.referenceTransactionId ?? undefined,
      // `rehydrate` validates this against the taxonomy, so the cast is the
      // same type-level bridge as `kind` and `status` above.
      failureCode: (entity.failureCode ?? undefined) as FailureCode | undefined,
      processedAt: entity.processedAt ?? undefined,
      resultBalance: resultBalanceOf(entity),
      createdAt: entity.createdAt,
    });
  }
}

/**
 * Reads the (amount, currency) pair back as a single MoneyProps, or undefined
 * when the transaction has not been answered yet.
 *
 * The database CHECK keeps the pair all-or-nothing, so exactly one of them
 * being null means the row was corrupted outside the application. Guessing a
 * currency here would turn that corruption into a plausible-looking wrong
 * balance on a replay — which is worse than refusing to answer.
 */
function resultBalanceOf(
  entity: WagerTransactionEntity,
): MoneyProps | undefined {
  // MikroORM reads SQL NULL as JS null; an unanswered transaction that was
  // never hydrated may still read as undefined. Both mean "not answered".
  if (entity.resultBalanceAmount == null) {
    return undefined;
  }

  if (entity.resultBalanceCurrency == null) {
    throw new Error(
      `wager transaction ${entity.id} has a result balance amount without a currency`,
    );
  }

  return {
    amount: entity.resultBalanceAmount,
    // `Money.rehydrate` inside `WagerTransaction.rehydrate` validates the
    // currency, so this cast is type-level only.
    currency: entity.resultBalanceCurrency as CurrencyCode,
  };
}
