import { EntityManager } from '@mikro-orm/core';
import { UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import { WalletRepositoryPort } from '../ports/wallet-repository.port.js';
import { WalletNotFoundError, LedgerCursor } from '../domain/index.js';
import { encodeCursor } from '../domain/ledger/ledger-cursor.js';

export const DEFAULT_LEDGER_PAGE_SIZE = 50;
export const MAX_LEDGER_PAGE_SIZE = 100;

export interface ListWalletLedgerQuery {
  readonly walletId: string;
  readonly after?: LedgerCursor;
  readonly limit?: number;
}

export interface ListWalletLedgerPage {
  readonly walletId: string;
  readonly entries: readonly {
    readonly id: string;
    readonly transactionId: string;
    readonly direction: string;
    readonly amount: string;
    readonly currency: string;
    readonly balanceBefore: string;
    readonly balanceAfter: string;
    readonly createdAt: Date;
  }[];
  readonly nextCursor: string | null;
}

export class ListWalletLedgerUseCase {
  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly wallets: WalletRepositoryPort,
  ) {}

  async execute(query: ListWalletLedgerQuery): Promise<ListWalletLedgerPage> {
    const limit = Math.min(
      query.limit ?? DEFAULT_LEDGER_PAGE_SIZE,
      MAX_LEDGER_PAGE_SIZE,
    );

    return this.uow.read((tx) =>
      this.run(tx, query.walletId, query.after, limit),
    );
  }

  private async run(
    tx: EntityManager,
    walletId: string,
    after: LedgerCursor | undefined,
    limit: number,
  ): Promise<ListWalletLedgerPage> {
    const wallet = await this.wallets.findById(tx, walletId);

    if (!wallet)
      throw new WalletNotFoundError('wallet not found', { walletId });

    const rows = await this.wallets.listEntries(tx, walletId, {
      after,
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;
    const last = entries.at(-1);

    return {
      walletId,
      entries: entries.map((entry) => {
        const props = entry.props();
        return {
          id: props.id,
          transactionId: props.transactionId,
          direction: props.direction,
          amount: props.money.toString(),
          currency: props.money.currency,
          balanceBefore: props.balanceBefore.toString(),
          balanceAfter: props.balanceAfter.toString(),
          createdAt: props.createdAt,
        };
      }),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              createdAt: last.props().createdAt,
              id: last.props().id,
            })
          : null,
    };
  }
}
