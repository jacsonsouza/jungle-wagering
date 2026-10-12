import type { EntityManager } from '@mikro-orm/core';
import type { MoneyProps } from '../domain/index.js';
import { Money, WalletNotFoundError } from '../domain/index.js';
import type { LoggerPort } from '../ports/logger.port.js';
import type { MetricsPort } from '../ports/metrics.port.js';
import type { UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import type { WalletRepositoryPort } from '../ports/wallet-repository.port.js';

export interface ReconcileWalletResult {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

/**
 * §9 reconciliation: recompute the balance from the ledger and compare it with
 * the one stored on the wallet.
 *
 * The wallet row is taken under the same pessimistic lock the submission path
 * uses. Without it, a bet committing between the stored read and the ledger
 * sum would report a phantom divergence — and a divergence report nobody can
 * trust is worse than no report at all.
 *
 * It NEVER corrects. A mismatch is evidence, and evidence that silently
 * repairs itself is evidence you no longer have: it is logged, counted, and
 * flagged in the response (§9).
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly wallets: WalletRepositoryPort,
    private readonly logger: LoggerPort,
    private readonly metrics: MetricsPort,
  ) {}

  async execute(walletId: string): Promise<ReconcileWalletResult> {
    return this.uow.transaction((tx) => this.run(tx, walletId));
  }

  private async run(
    tx: EntityManager,
    walletId: string,
  ): Promise<ReconcileWalletResult> {
    const wallet = await this.wallets.findByIdForUpdate(tx, walletId);

    if (!wallet)
      throw new WalletNotFoundError('wallet not found', { walletId });

    const stored = wallet.balance;

    const { creditTotal, debitTotal, entryCount } =
      await this.wallets.sumEntries(tx, walletId);

    const calculated = Money.from({
      amount: creditTotal,
      currency: stored.currency,
    }).subtract(Money.from({ amount: debitTotal, currency: stored.currency }));

    const difference = calculated.subtract(stored);
    const consistent = difference.isZero();

    if (!consistent) {
      this.logger.warn('wallet reconciliation diverged', {
        walletId,
        storedBalance: stored.toString(),
        calculatedBalance: calculated.toString(),
        difference: difference.toString(),
        checkedEntries: entryCount,
      });

      this.metrics.increment('wallet_reconciliation_divergences_total');
    }

    this.metrics.increment('wallet_reconciliations_total', {
      outcome: consistent ? 'CONSISTENT' : 'DIVERGED',
    });

    return {
      walletId,
      storedBalance: stored.props(),
      calculatedBalance: calculated.props(),
      difference: difference.props(),
      consistent,
      checkedEntries: entryCount,
    };
  }
}
