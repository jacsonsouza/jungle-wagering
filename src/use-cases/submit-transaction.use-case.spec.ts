import { DeadlockException, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/core';
import {
  CurrencyCode,
  LedgerDirection,
  Money,
  WagerTransaction,
  WagerTransactionKind,
  Wallet,
  type OutboxMessage,
  type WalletLedgerEntry,
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
import type { SubmitTransactionCommand } from './submit-transaction.use-case.js';
import { SubmitTransactionUseCase } from './submit-transaction.use-case.js';
import {
  recordingLogger,
  recordingMetrics,
} from '../../test/setup/observability.js';

const AT = new Date('2026-10-10T12:00:00.000Z');

// ---- fakes -----------------------------------------------------------------
// The ports ARE the seam: the transactional wrapper just runs the callback and
// the repositories are in-memory. No database, no mocks library.

class FakeUow implements UnitOfWorkPort {
  constructor(private readonly failWith?: Error) {}

  async transaction<T>(fn: (tx: EntityManager) => Promise<T>): Promise<T> {
    if (this.failWith) throw this.failWith;
    return fn({} as EntityManager);
  }

  async read<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    // Isolation between callers is the port's job (`clear: true` on the real
    // implementation), so the fake only has to hand over an EntityManager.
    return fn({} as EntityManager);
  }
}

class FakeWalletRepo implements WalletRepositoryPort {
  wallet: Wallet | null = walletAt('100.00');
  readonly entries: WalletLedgerEntry[] = [];

  async findByPlayer(): Promise<Wallet | null> {
    return this.wallet;
  }
  async findByIdForUpdate(): Promise<Wallet | null> {
    return this.wallet;
  }
  async findById(): Promise<Wallet | null> {
    return this.wallet;
  }
  async listEntries(): Promise<WalletLedgerEntry[]> {
    return [];
  }
  async sumEntries(): Promise<{
    creditTotal: string;
    debitTotal: string;
    entryCount: number;
  }> {
    return { creditTotal: '0', debitTotal: '0', entryCount: 0 };
  }
  async insert(_tx: EntityManager, wallet: Wallet): Promise<void> {
    this.wallet = wallet;
  }
  async update(): Promise<void> {}
  async insertEntry(
    _tx: EntityManager,
    entry: WalletLedgerEntry,
  ): Promise<void> {
    this.entries.push(entry);
  }
}

class FakeTxRepo implements WagerTransactionRepositoryPort {
  readonly rows: WagerTransaction[] = [];
  readonly schedules: Array<{
    transactionId: string;
    attempts: number;
    dueAt: Date;
  }> = [];

  /**
   * A row that commits in the exact window between the lookup and the insert.
   * Models the loser's view of a race: nothing exists on read, the winner
   * is there on write — and Postgres answers 23505.
   */
  commitWinnerOnInsert?: WagerTransaction;

  async insert(
    _tx: EntityManager,
    transaction: WagerTransaction,
  ): Promise<void> {
    const winner = this.commitWinnerOnInsert;

    if (winner) {
      this.commitWinnerOnInsert = undefined;
      this.rows.push(winner);
      throw new UniqueConstraintViolationException({} as never);
    }

    this.rows.push(transaction);
  }

  async update(): Promise<void> {}

  async findByIdempotencyKey(
    _tx: EntityManager,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    return (
      this.rows.find((row) => row.idempotencyKey === idempotencyKey) ?? null
    );
  }

  async findById(
    _tx: EntityManager,
    transactionId: string,
  ): Promise<WagerTransaction | null> {
    return this.rows.find((row) => row.id === transactionId) ?? null;
  }

  async findByProviderExternal(
    _tx: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return (
      this.rows.find(
        (row) =>
          row.providerId === providerId &&
          row.externalTransactionId === externalTransactionId,
      ) ?? null
    );
  }

  async findReversalForReference(
    _tx: EntityManager,
    referenceTransactionId: string,
  ): Promise<WagerTransaction | null> {
    // Only an APPLIED reversal carries a referenceTransactionId — a rejected
    // one deliberately does not, exactly like the partial unique index.
    return (
      this.rows.find(
        (row) =>
          row.referenceTransactionId === referenceTransactionId &&
          (row.kind === WagerTransactionKind.Refund ||
            row.kind === WagerTransactionKind.Rollback),
      ) ?? null
    );
  }

  async schedulePendingAttempt(
    _tx: EntityManager,
    transactionId: string,
    attempts: number,
    dueAt: Date,
  ): Promise<void> {
    this.schedules.push({ transactionId, attempts, dueAt });
  }

  async findDueForPendingReference(): Promise<
    readonly PendingReferenceDue[]
  > {
    return [];
  }

  async clearPendingSchedule(): Promise<void> {}
}

class FakeOutboxRepo implements OutboxRepositoryPort {
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

// ---- fixtures ---------------------------------------------------------------

function walletAt(
  balance: string,
  overrides?: { readonly playerId?: string },
): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: overrides?.playerId ?? 'player-1',
    initialBalance: Money.from({ amount: balance, currency: CurrencyCode.BRL }),
    openedAt: AT,
  });
}

function command(
  overrides: Partial<SubmitTransactionCommand> = {},
): SubmitTransactionCommand {
  const externalTransactionId = overrides.externalTransactionId ?? 'ext-1';

  return {
    providerId: 'provider-a',
    externalTransactionId,
    // §9's recommended default, derived so that changing the operation always
    // changes the key — unless a test passes one explicitly.
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: CurrencyCode.BRL },
    ...overrides,
  };
}

function refundCommand(
  overrides: Partial<SubmitTransactionCommand> = {},
): SubmitTransactionCommand {
  return command({
    kind: WagerTransactionKind.Refund,
    externalTransactionId: 'ext-refund-1',
    referenceExternalTransactionId: 'ext-bet-1',
    ...overrides,
  });
}

/** A transaction that was already PROCESSED by an earlier submission. */
function seedProcessed(
  repo: FakeTxRepo,
  props: {
    readonly id: string;
    readonly kind: WagerTransactionKind;
    readonly externalTransactionId: string;
    readonly amount: string;
    readonly resultBalance: string;
    readonly playerId?: string;
    readonly walletId?: string;
    readonly roundId?: string;
    readonly referenceExternalTransactionId?: string;
    readonly referenceTransactionId?: string;
  },
): WagerTransaction {
  const transaction = WagerTransaction.create({
    id: props.id,
    idempotencyKey: `provider-a:${props.externalTransactionId}`,
    createdAt: AT,
    providerId: 'provider-a',
    externalTransactionId: props.externalTransactionId,
    playerId: props.playerId ?? 'player-1',
    walletId: props.walletId ?? 'wallet-1',
    roundId: props.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind: props.kind,
    money: Money.from({ amount: props.amount, currency: CurrencyCode.BRL }),
    referenceExternalTransactionId: props.referenceExternalTransactionId,
  });

  transaction.markProcessed(props.referenceTransactionId, AT);
  transaction.recordResultBalance(
    Money.from({ amount: props.resultBalance, currency: CurrencyCode.BRL }),
  );
  repo.rows.push(transaction);

  return transaction;
}

function build(overrides?: {
  readonly uow?: UnitOfWorkPort;
  readonly wallet?: Wallet | null;
  readonly txRepo?: FakeTxRepo;
}) {
  const wallets = new FakeWalletRepo();
  wallets.wallet =
    overrides?.wallet === undefined ? walletAt('100.00') : overrides.wallet;

  const wagerTransactions = overrides?.txRepo ?? new FakeTxRepo();
  const outbox = new FakeOutboxRepo();
  const metrics = recordingMetrics();
  const logger = recordingLogger();

  const useCase = new SubmitTransactionUseCase(
    overrides?.uow ?? new FakeUow(),
    wallets,
    wagerTransactions,
    outbox,
    clock,
    ids,
    logger,
    metrics,
  );

  return { useCase, wallets, wagerTransactions, outbox, metrics, logger };
}

function eventTypes(outbox: FakeOutboxRepo): string[] {
  return outbox.messages.map((message) => message.eventType);
}

// ---- tests ------------------------------------------------------------------

describe('SubmitTransactionUseCase — payload phase', () => {
  it('refuses a non-positive amount before opening any transaction', async () => {
    const { useCase, wallets } = build({ wallet: walletAt('100.00') });

    await expect(
      useCase.execute(
        command({ money: { amount: '0.00', currency: CurrencyCode.BRL } }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });

    expect(wallets.entries).toHaveLength(0);
  });

  it('gives the same answer for a missing wallet and for a foreign one', async () => {
    const missing = build({ wallet: null });
    const foreign = build({
      wallet: walletAt('100.00', { playerId: 'someone-else' }),
    });

    // Categorized NOT_FOUND on purpose: a wallet that exists but is not yours
    // must be indistinguishable from one that does not, or the endpoint becomes
    // an oracle for wallet ids.
    await expect(missing.useCase.execute(command())).rejects.toMatchObject({
      code: 'WALLET_SCOPE_MISMATCH',
    });
    await expect(foreign.useCase.execute(command())).rejects.toMatchObject({
      code: 'WALLET_SCOPE_MISMATCH',
    });

    expect(missing.wallets.entries).toHaveLength(0);
    expect(foreign.wallets.entries).toHaveLength(0);
  });

  it('refuses money denominated in a currency the wallet does not hold', async () => {
    const { useCase, wallets } = build({ wallet: walletAt('100.00') });

    await expect(
      useCase.execute(
        command({ money: { amount: '25.00', currency: CurrencyCode.USD } }),
      ),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });

    expect(wallets.entries).toHaveLength(0);
  });
});

describe('SubmitTransactionUseCase — applying a transaction', () => {
  it('debits a BET, documents it in the ledger and emits both events', async () => {
    const wallet = walletAt('100.00');
    const { useCase, wallets, wagerTransactions, outbox } = build({ wallet });

    const result = await useCase.execute(command());

    expect(result).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: false,
      failureCode: undefined,
    });
    expect(result.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);

    expect(wallets.entries).toHaveLength(1);
    const entry = wallets.entries[0].props();
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.toString()).toBe('25.00');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');

    expect(wagerTransactions.rows).toHaveLength(1);
    expect(wagerTransactions.rows[0].resultBalance?.toString()).toBe('75.00');

    expect(eventTypes(outbox)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('rejects a BET the wallet cannot afford without moving anything', async () => {
    const wallet = walletAt('10.00');
    const { useCase, wallets, wagerTransactions, outbox } = build({ wallet });

    const result = await useCase.execute(command());

    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: false,
      balance: { amount: '10.00', currency: 'BRL' },
    });

    // §7.6: no balance change, no ledger entry — but the refusal is auditable.
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
    expect(wallets.entries).toHaveLength(0);
    expect(wagerTransactions.rows).toHaveLength(1);
    expect(wagerTransactions.rows[0].status).toBe('REJECTED');
    expect(eventTypes(outbox)).toEqual(['WagerTransactionRejected']);
  });

  it('records a LOSS without moving the balance or emitting a balance event', async () => {
    const wallet = walletAt('100.00');
    const { useCase, wallets, outbox } = build({ wallet });

    const result = await useCase.execute(
      command({ kind: WagerTransactionKind.Loss }),
    );

    expect(result).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallets.entries).toHaveLength(0);
    // §11: only a balance that changed announces itself.
    expect(eventTypes(outbox)).toEqual(['WagerTransactionProcessed']);
  });
});

describe('SubmitTransactionUseCase — idempotency', () => {
  it('replays with the balance observed then, not the balance today', async () => {
    const wallet = walletAt('100.00');
    const { useCase, wallets, outbox } = build({ wallet });

    const first = await useCase.execute(command());
    expect(first.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    // Another WIN lands while nobody is looking: the balance moved on.
    wallet.credit({
      entryId: 'entry-later',
      transactionId: 'tx-later',
      money: Money.from({ amount: '50.00', currency: CurrencyCode.BRL }),
      at: AT,
    });
    outbox.messages.length = 0;

    const replay = await useCase.execute(command());

    // §7.7: the original answer, down to the balance that was true then.
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(wallet.balance.toString()).toBe('125.00');
    expect(wallets.entries).toHaveLength(1); // no second debit
    expect(outbox.messages).toHaveLength(0); // no second announcement
  });

  it('blocks a duplicate submitted under a fresh Idempotency-Key', async () => {
    const wallet = walletAt('100.00');
    const { useCase, wallets } = build({ wallet });

    const first = await useCase.execute(command());
    const second = await useCase.execute(
      command({ idempotencyKey: 'a-brand-new-key' }),
    );

    expect(second.transactionId).toBe(first.transactionId);
    expect(second.idempotentReplay).toBe(true);
    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallets.entries).toHaveLength(1); // debited exactly once
  });

  it('answers a reused key with a divergent payload as a conflict, not a replay', async () => {
    const { useCase, wallets } = build({ wallet: walletAt('100.00') });

    await useCase.execute(command());

    await expect(
      useCase.execute(command({ kind: WagerTransactionKind.Win })),
    ).rejects.toMatchObject({ code: 'PAYLOAD_MISMATCH' });

    // The conflict must not have become a second row or a second movement.
    expect(wallets.entries).toHaveLength(1);
  });
});

describe('SubmitTransactionUseCase — references', () => {
  it('defers a REFUND whose reference has not arrived and arms the worker', async () => {
    const wallet = walletAt('100.00');
    const { useCase, wallets, wagerTransactions, outbox } = build({ wallet });

    const result = await useCase.execute(
      refundCommand({ referenceExternalTransactionId: 'ext-bet-not-yet' }),
    );

    expect(result).toMatchObject({
      status: 'PENDING_REFERENCE',
      idempotentReplay: false,
      balance: { amount: '100.00', currency: 'BRL' },
    });

    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallets.entries).toHaveLength(0);
    expect(wagerTransactions.rows[0].status).toBe('PENDING_REFERENCE');
    // Without this the row never enters `idx_wager_tx_pending_due`.
    expect(wagerTransactions.schedules).toEqual([
      {
        transactionId: wagerTransactions.rows[0].id,
        attempts: 1,
        dueAt: new Date(AT.getTime() + 1_000),
      },
    ]);
    expect(eventTypes(outbox)).toEqual(['WagerTransactionPendingReference']);
  });

  it('answers an identical retry of an unresolved REFUND with the very same 202', async () => {
    const wallet = walletAt('100.00');
    const { useCase, outbox, wagerTransactions } = build({ wallet });
    const request = refundCommand({
      referenceExternalTransactionId: 'ext-bet-not-yet',
    });

    const first = await useCase.execute(request);
    outbox.messages.length = 0;

    const second = await useCase.execute(request);

    // §9: identical request, identical answer — only the replay flag differs,
    // because the first response was produced and the second one served.
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.status).toBe(first.status);
    expect(second.balance).toEqual(first.balance);
    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);

    expect(outbox.messages).toHaveLength(0); // no duplicate announcement
    // Re-arming would restart the backoff on every retry and postpone the
    // §7.1 attempt limit forever.
    expect(wagerTransactions.schedules).toHaveLength(1);
  });

  it('resolves an unresolved REFUND once the reference exists', async () => {
    const wallet = walletAt('75.00');
    const txRepo = new FakeTxRepo();
    const { useCase, outbox } = build({ wallet, txRepo });
    const request = refundCommand();

    const deferred = await useCase.execute(request);
    expect(deferred.status).toBe('PENDING_REFERENCE');

    seedProcessed(txRepo, {
      id: 'bet-1',
      kind: WagerTransactionKind.Bet,
      externalTransactionId: 'ext-bet-1',
      amount: '25.00',
      resultBalance: '75.00',
    });
    outbox.messages.length = 0;

    const resolved = await useCase.execute(request);

    // §7.7 only promises the original answer for transactions that were
    // PROCESSED — an unresolved one has no answer yet, so resolving it is NEW
    // work, not a replay.
    expect(resolved).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: false,
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(wallet.balance.toString()).toBe('100.00');
    expect(eventTypes(outbox)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('persists ALREADY_REVERSED instead of reversing the same reference twice', async () => {
    const wallet = walletAt('100.00');
    const txRepo = new FakeTxRepo();
    const { useCase, wallets } = build({ wallet, txRepo });

    seedProcessed(txRepo, {
      id: 'bet-1',
      kind: WagerTransactionKind.Bet,
      externalTransactionId: 'ext-bet-1',
      amount: '25.00',
      resultBalance: '75.00',
    });
    seedProcessed(txRepo, {
      id: 'refund-1',
      kind: WagerTransactionKind.Refund,
      externalTransactionId: 'ext-refund-1',
      amount: '25.00',
      resultBalance: '100.00',
      referenceExternalTransactionId: 'ext-bet-1',
      referenceTransactionId: 'bet-1',
    });

    const result = await useCase.execute(
      refundCommand({ externalTransactionId: 'ext-refund-2' }),
    );

    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'ALREADY_REVERSED',
    });
    expect(wallets.entries).toHaveLength(0);
    expect(wallet.balance.toString()).toBe('100.00');

    // A rejected reversal keeps no resolved reference, so the partial unique
    // index never sees it — and the refusal stays queryable (§7.9).
    const second = txRepo.rows.find(
      (row) => row.externalTransactionId === 'ext-refund-2',
    );
    expect(second?.status).toBe('REJECTED');
    expect(second?.referenceTransactionId).toBeUndefined();
  });

  it('distinguishes a reversal that cannot be honoured from an unaffordable bet', async () => {
    // ROLLBACK of a REFUND inverts a CREDIT into a DEBIT — money taken back
    // from a wallet that no longer has it. §7.9 demands its own failureCode:
    // operationally a different event from a bet the player cannot afford.
    const wallet = walletAt('10.00');
    const txRepo = new FakeTxRepo();
    const { useCase, wallets } = build({ wallet, txRepo });

    seedProcessed(txRepo, {
      id: 'refund-1',
      kind: WagerTransactionKind.Refund,
      externalTransactionId: 'ext-refund-1',
      amount: '25.00',
      resultBalance: '10.00',
      referenceExternalTransactionId: 'ext-bet-1',
      referenceTransactionId: 'bet-1',
    });

    const result = await useCase.execute(
      command({
        kind: WagerTransactionKind.Rollback,
        externalTransactionId: 'ext-rollback-1',
        referenceExternalTransactionId: 'ext-refund-1',
      }),
    );

    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
    });
    expect(wallets.entries).toHaveLength(0);
    expect(wallet.balance.toString()).toBe('10.00');
  });

  it('persists a reference that fails the scope rule instead of throwing', async () => {
    const wallet = walletAt('100.00');
    const txRepo = new FakeTxRepo();
    const { useCase, wagerTransactions, wallets } = build({ wallet, txRepo });

    seedProcessed(txRepo, {
      id: 'bet-1',
      kind: WagerTransactionKind.Bet,
      externalTransactionId: 'ext-bet-1',
      amount: '25.00',
      resultBalance: '75.00',
      roundId: 'another-round', // §7 rule 2: the reference must share the round
    });

    const result = await useCase.execute(refundCommand());

    // The answer depends on a row outside the request's scope, so §9 requires it to be
    // recorded: a later retry must get the same refusal.
    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_SCOPE_MISMATCH',
    });
    const rejected = wagerTransactions.rows.find(
      (row) => row.externalTransactionId === 'ext-refund-1',
    );
    expect(rejected?.status).toBe('REJECTED');
    expect(rejected?.failureCode).toBe('REFERENCE_SCOPE_MISMATCH');
    expect(wallets.entries).toHaveLength(0);
  });
});

describe('SubmitTransactionUseCase — lost races', () => {
  it('answers with the winner when the insert loses the idempotency race', async () => {
    const txRepo = new FakeTxRepo();
    const { useCase } = build({ wallet: walletAt('100.00'), txRepo });

    txRepo.commitWinnerOnInsert = (() => {
      const winner = WagerTransaction.create({
        id: 'winner',
        idempotencyKey: 'provider-a:ext-1',
        createdAt: AT,
        providerId: 'provider-a',
        externalTransactionId: 'ext-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '25.00', currency: CurrencyCode.BRL }),
      });
      winner.markProcessed(undefined, AT);
      winner.recordResultBalance(
        Money.from({ amount: '75.00', currency: CurrencyCode.BRL }),
      );
      return winner;
    })();

    const result = await useCase.execute(command());

    expect(result).toMatchObject({
      transactionId: 'winner',
      idempotentReplay: true,
      balance: { amount: '75.00', currency: 'BRL' },
    });
  });

  it('turns a lost reversal race into ALREADY_REVERSED', async () => {
    const wallet = walletAt('100.00');
    const txRepo = new FakeTxRepo();
    const { useCase, wallets } = build({ wallet, txRepo });

    seedProcessed(txRepo, {
      id: 'bet-1',
      kind: WagerTransactionKind.Bet,
      externalTransactionId: 'ext-bet-1',
      amount: '25.00',
      resultBalance: '75.00',
    });

    // Both requests pass the pre-check, then one commits first.
    txRepo.commitWinnerOnInsert = (() => {
      const winner = WagerTransaction.create({
        id: 'winner-refund',
        idempotencyKey: 'provider-a:ext-refund-winner',
        createdAt: AT,
        providerId: 'provider-a',
        externalTransactionId: 'ext-refund-winner',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Refund,
        money: Money.from({ amount: '25.00', currency: CurrencyCode.BRL }),
        referenceExternalTransactionId: 'ext-bet-1',
      });
      winner.markProcessed('bet-1', AT);
      winner.recordResultBalance(
        Money.from({ amount: '100.00', currency: CurrencyCode.BRL }),
      );
      return winner;
    })();

    await expect(
      useCase.execute(refundCommand({ externalTransactionId: 'ext-refund-2' })),
    ).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });

    // The losing request recorded nothing: no ledger entry, no announcement.
    expect(wallets.entries).toHaveLength(0);
  });

  it('fails loud when a unique violation has no visible winner', async () => {
    const { useCase } = build({
      wallet: walletAt('100.00'),
      uow: new FakeUow(new UniqueConstraintViolationException({} as never)),
    });

    // Nothing committed, so there is no winner to answer with — inventing a
    // response here would hide a real integrity problem.
    await expect(useCase.execute(command())).rejects.toThrow(
      'has no committed winner',
    );
  });
});

describe('SubmitTransactionUseCase — observability (§12)', () => {
  it('counts a settled submission by status, and times it', async () => {
    const { useCase, metrics } = build({ wallet: walletAt('100.00') });

    await useCase.execute(command());

    const counted = metrics.seen.find((m) => m.name === 'transactions_total');
    expect(metrics.count('transactions_total')).toBe(1);
    expect(counted?.labels).toEqual({ status: 'PROCESSED' });

    const timed = metrics.seen.find(
      (m) => m.name === 'transaction_processing_seconds',
    );
    expect(timed?.labels).toEqual({ status: 'PROCESSED' });
    expect(timed?.seconds).toBeGreaterThanOrEqual(0);

    // §8's contention point, timed on the way to the wallet row.
    expect(metrics.count('wallet_lock_wait_seconds')).toBe(1);
  });

  it('counts a refusal under its own status', async () => {
    const { useCase, metrics } = build({ wallet: walletAt('10.00') });

    await useCase.execute(command()); // a 25.00 bet the wallet cannot afford

    const counted = metrics.seen.find((m) => m.name === 'transactions_total');
    expect(counted?.labels).toEqual({ status: 'REJECTED' });
    expect(metrics.count('idempotent_replays_total')).toBe(0);
  });

  it('counts a duplicate separately instead of only folding it into the status', async () => {
    const { useCase, metrics } = build({ wallet: walletAt('100.00') });

    await useCase.execute(command());
    await useCase.execute(command());

    // Two ANSWERS, both PROCESSED, one of them a replay: the status count
    // says 2 and the duplicate count says 1, and neither is a restatement of
    // the other.
    expect(metrics.count('transactions_total')).toBe(2);
    expect(metrics.count('idempotent_replays_total')).toBe(1);
  });

  it('counts a lock PostgreSQL refused instead of merely rethrowing it', async () => {
    const { useCase, metrics } = build({
      wallet: walletAt('100.00'),
      uow: new FakeUow(new DeadlockException(new Error('deadlock detected'))),
    });

    await expect(useCase.execute(command())).rejects.toBeDefined();

    expect(metrics.count('lock_conflicts_total')).toBe(1);
    // Never answered, so it must not appear in the status count.
    expect(metrics.count('transactions_total')).toBe(0);
  });

  it('logs the identifiers §12 names, and keeps money out of the line', async () => {
    const { useCase, logger } = build({ wallet: walletAt('100.00') });

    const settled = await useCase.execute(command());

    const line = logger.lines.find((entry) => entry.message === 'transaction settled');
    expect(line?.fields).toMatchObject({
      transactionId: settled.transactionId,
      walletId: 'wallet-1',
      providerId: 'provider-a',
      status: 'PROCESSED',
      idempotentReplay: false,
    });

    // The ledger is where amounts belong; §12 forbids financial payloads in
    // logs, and a log line is not an audit trail.
    const serialized = JSON.stringify(line?.fields);
    expect(serialized).not.toContain('25.00');
    expect(serialized).not.toContain('75.00');
  });
});
