import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/core';
import {
  CurrencyCode,
  Money,
  Wallet,
  type WalletLedgerEntry,
  type OutboxMessage,
  type WagerTransaction,
} from '../domain/index.js';
import type { ClockPort } from '../ports/clock.port.js';
import type { IdGeneratorPort } from '../ports/id-generator.port.js';
import type { OutboxRepositoryPort } from '../ports/outbox-repository.port.js';
import type { UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import type { WalletRepositoryPort } from '../ports/wallet-repository.port.js';
import type {
  PendingReferenceDue,
  WagerTransactionRepositoryPort,
} from '../ports/wager-transaction-repository.port.js';
import { CreateWalletUseCase } from './create-wallet.use-case.js';

const AT = new Date('2026-10-10T12:00:00.000Z');

// Fakes: the transactional wrapper just runs the callback, and repositories
// are in-memory maps. No database, no mocks library — the ports ARE the seam.
class FakeUow implements UnitOfWorkPort {
  constructor(private readonly failWith?: Error) {}
  async transaction<T>(fn: (tx: EntityManager) => Promise<T>): Promise<T> {
    if (this.failWith) throw this.failWith;
    return fn({} as EntityManager);
  }
  async read<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    return fn({} as EntityManager);
  }
}

class FakeWalletRepo implements WalletRepositoryPort {
  readonly stored: Wallet[] = [];
  readonly entries: WalletLedgerEntry[] = [];
  async findByPlayer(): Promise<Wallet | null> {
    return this.stored[0] ?? null;
  }
  async findById(): Promise<Wallet | null> {
    return this.findByPlayer();
  }
  async findByIdForUpdate(): Promise<Wallet | null> {
    return this.findByPlayer();
  }
  async listEntries(): Promise<WalletLedgerEntry[]> {
    return this.entries;
  }
  async sumEntries(): Promise<{
    creditTotal: string;
    debitTotal: string;
    entryCount: number;
  }> {
    return {
      creditTotal: '0',
      debitTotal: '0',
      entryCount: this.entries.length,
    };
  }
  async insert(_tx: EntityManager, wallet: Wallet): Promise<void> {
    this.stored.push(wallet);
  }
  async update(): Promise<void> {}
  async insertEntry(
    _tx: EntityManager,
    entry: WalletLedgerEntry,
  ): Promise<void> {
    this.entries.push(entry);
  }
}

class NoopTxRepo implements WagerTransactionRepositoryPort {
  readonly inserted: WagerTransaction[] = [];
  async insert(
    _tx: EntityManager,
    transaction: WagerTransaction,
  ): Promise<void> {
    this.inserted.push(transaction);
  }
  async update(): Promise<void> {}
  async findByIdempotencyKey(): Promise<WagerTransaction | null> {
    return null;
  }
  async findById(): Promise<WagerTransaction | null> {
    return null;
  }
  async schedulePendingAttempt(): Promise<void> {}
  async findByProviderExternal(): Promise<WagerTransaction | null> {
    return null;
  }
  async findReversalForReference(): Promise<WagerTransaction | null> {
    return null;
  }
  async findDueForPendingReference(): Promise<readonly PendingReferenceDue[]> {
    return [];
  }
  async clearPendingSchedule(): Promise<void> {}
}
class NoopOutboxRepo implements OutboxRepositoryPort {
  readonly messages: OutboxMessage[] = [];
  async insert(_tx: EntityManager, message: OutboxMessage): Promise<void> {
    this.messages.push(message);
  }
  async claimDue(): Promise<readonly OutboxMessage[]> {
    return [];
  }
  async markPublished(): Promise<void> {}
  async scheduleRetry(): Promise<void> {}
}

const ids: IdGeneratorPort = {
  newId: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  })(),
};
const clock: ClockPort = { now: () => AT };

function buildUseCase(overrides?: {
  uow?: UnitOfWorkPort;
  wallets?: FakeWalletRepo;
}) {
  const wallets = overrides?.wallets ?? new FakeWalletRepo();
  const outbox = new NoopOutboxRepo();
  const wagerTransactions = new NoopTxRepo();
  const useCase = new CreateWalletUseCase(
    overrides?.uow ?? new FakeUow(),
    wallets,
    wagerTransactions,
    outbox,
    clock,
    ids,
  );
  return { useCase, wallets, wagerTransactions, outbox };
}

describe('CreateWalletUseCase', () => {
  it('funds the wallet through an OPENING credit and emits one balance event', async () => {
    const { useCase, wallets, wagerTransactions, outbox } = buildUseCase();

    const result = await useCase.execute({
      playerId: 'player-1',
      currency: CurrencyCode.BRL,
      initialAmount: '100.00',
    });

    expect(result.outcome).toBe('CREATED');
    if (result.outcome !== 'CREATED') return;
    expect(result.wallet.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    // version 1: the wallet is BORN funded (§9). Opening is the state it
    // starts in, not a change it undergoes — so the version does not move.
    expect(result.wallet.version).toBe(1);
    expect(wallets.stored).toHaveLength(1);

    // The opening balance is still fully documented: one OPENING transaction
    // and one CREDIT ledger entry running 0.00 → 100.00.
    expect(wallets.entries).toHaveLength(1);
    expect(wallets.entries[0].props()).toMatchObject({
      transactionId: wagerTransactions.inserted[0].id,
    });
    expect(wagerTransactions.inserted[0].kind).toBe('OPENING');
    expect(wagerTransactions.inserted[0].resultBalance?.toString()).toBe(
      '100.00',
    );

    expect(outbox.messages).toHaveLength(1);
    expect(outbox.messages[0].eventType).toBe('WalletBalanceChanged');
  });

  it('opens an empty wallet without an OPENING transaction or ledger entry', async () => {
    const { useCase, wallets, wagerTransactions, outbox } = buildUseCase();

    const result = await useCase.execute({
      playerId: 'player-1',
      currency: CurrencyCode.BRL,
      initialAmount: '0.00',
    });

    expect(result.outcome).toBe('CREATED');
    if (result.outcome !== 'CREATED') return;
    expect(result.wallet.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.wallet.version).toBe(1);

    // Nothing moved, so nothing to document — and nothing to emit an event for.
    expect(wallets.entries).toHaveLength(0);
    expect(wagerTransactions.inserted).toHaveLength(0);
    expect(outbox.messages).toHaveLength(0);
  });

  it('returns the existing wallet when the (player, currency) pair is taken', async () => {
    const { wallets } = buildUseCase();
    const build = () =>
      new CreateWalletUseCase(
        new FakeUow(),
        wallets,
        new NoopTxRepo(),
        new NoopOutboxRepo(),
        clock,
        ids,
      );

    const first = await build().execute({
      playerId: 'p1',
      currency: CurrencyCode.BRL,
      initialAmount: '10.00',
    });
    expect(first.outcome).toBe('CREATED');

    const second = await build().execute({
      playerId: 'p1',
      currency: CurrencyCode.BRL,
      initialAmount: '99.00',
    });

    expect(second.outcome).toBe('ALREADY_EXISTS');
    expect(second.wallet.balance).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  it('rejects invalid amounts before touching any repository', async () => {
    const { useCase, wallets } = buildUseCase();

    await expect(
      useCase.execute({
        playerId: 'p1',
        currency: CurrencyCode.BRL,
        initialAmount: '-5.00',
      }),
    ).rejects.toThrow('negative amounts are not allowed');

    expect(wallets.stored).toHaveLength(0); // nothing persisted
  });

  it('converts a lost insert race into ALREADY_EXISTS (23505 path)', async () => {
    const { useCase, wallets } = buildUseCase({
      uow: new FakeUow(new UniqueConstraintViolationException({} as never)),
    });
    // After the failed transaction, the read path finds the winner's wallet:
    wallets.stored.push(
      Wallet.open({
        id: 'winner',
        playerId: 'p1',
        initialBalance: Money.from({
          amount: '42.00',
          currency: CurrencyCode.BRL,
        }),
        openedAt: AT,
      }),
    );

    const result = await useCase.execute({
      playerId: 'p1',
      currency: CurrencyCode.BRL,
      initialAmount: '42.00',
    });

    expect(result.outcome).toBe('ALREADY_EXISTS');
  });
});
