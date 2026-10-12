import { EntityManager } from '@mikro-orm/core';
import { WalletRepositoryPort } from '../ports/wallet-repository.port.js';
import { WalletNotFoundError, WalletState } from '../domain/index.js';
import { UnitOfWorkPort } from '../ports/unit-of-work.port.js';

export class GetWalletUseCase {
  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly wallets: WalletRepositoryPort,
  ) {}

  async execute(walletId: string): Promise<WalletState> {
    return this.uow.read((tx) => this.run(tx, walletId));
  }

  private async run(tx: EntityManager, walletId: string): Promise<WalletState> {
    const wallet = await this.wallets.findById(tx, walletId);

    if (!wallet)
      throw new WalletNotFoundError('wallet not found', { walletId });

    return wallet.state();
  }
}
