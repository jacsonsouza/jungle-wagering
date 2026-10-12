import type { EntityManager } from '@mikro-orm/core';
import type { WagerTransactionState } from '../domain/index.js';
import { TransactionNotFoundError } from '../domain/index.js';
import type { UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import type { WagerTransactionRepositoryPort } from '../ports/wager-transaction-repository.port.js';

/**
 * Both §9 lookup routes — by the transaction id, or by the provider's own id — resolve to
 * the same answer shape, so they share one use case instead of growing a
 * near-duplicate per route.
 */
export type TransactionLookup =
  | { readonly by: 'transactionId'; readonly transactionId: string }
  | {
      readonly by: 'providerExternal';
      readonly providerId: string;
      readonly externalTransactionId: string;
    };

export class GetTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly wagerTransactions: WagerTransactionRepositoryPort,
  ) {}

  async execute(lookup: TransactionLookup): Promise<WagerTransactionState> {
    return this.uow.read((tx) => this.run(tx, lookup));
  }

  private async run(
    tx: EntityManager,
    lookup: TransactionLookup,
  ): Promise<WagerTransactionState> {
    const transaction =
      lookup.by === 'transactionId'
        ? await this.wagerTransactions.findById(tx, lookup.transactionId)
        : await this.wagerTransactions.findByProviderExternal(
            tx,
            lookup.providerId,
            lookup.externalTransactionId,
          );

    if (!transaction) {
      const missing =
        lookup.by === 'transactionId'
          ? { transactionId: lookup.transactionId }
          : {
              providerId: lookup.providerId,
              externalTransactionId: lookup.externalTransactionId,
            };

      throw new TransactionNotFoundError('transaction not found', missing);
    }

    return transaction.state();
  }
}
