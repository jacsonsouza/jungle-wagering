import type { EntityManager } from '@mikro-orm/core';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { CurrencyCode, WalletState } from '../domain/index.js';
import {
  InvalidWalletStateError,
  Money,
  OutboxMessage,
  payloadHash,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  Wallet,
  WalletBalanceChanged,
} from '../domain/index.js';
import type { ClockPort } from '../ports/clock.port.js';
import type { IdGeneratorPort } from '../ports/id-generator.port.js';
import type { OutboxRepositoryPort } from '../ports/outbox-repository.port.js';
import type { UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import type { WagerTransactionRepositoryPort } from '../ports/wager-transaction-repository.port.js';
import type { WalletRepositoryPort } from '../ports/wallet-repository.port.js';

const OPENING_PROVIDER_ID = 'internal';
const OPENING_GAME_ID = 'internal';

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly currency: CurrencyCode;
  readonly initialAmount: string;
}

export type CreateWalletResult =
  | { readonly outcome: 'CREATED'; readonly wallet: WalletState }
  | { readonly outcome: 'ALREADY_EXISTS'; readonly wallet: WalletState };

/**
 * Creates a wallet and funds it with an OPENING transaction.
 *
 * Funding is modelled as a real ledger credit rather than a starting balance,
 * so every cent in the system is traceable back to a transaction — including
 * the very first one.
 *
 * All four writes (wallet, ledger entry, opening transaction, outbox event)
 * happen in a single database transaction: either the wallet exists and is
 * funded, or nothing happened at all.
 *
 * Race handling: the (player, currency) unique index is the arbiter. If two
 * creates arrive together, one insert wins and the loser gets a 23505, which
 * converts into an honest ALREADY_EXISTS answer.
 */
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly wallets: WalletRepositoryPort,
    private readonly wagerTransactions: WagerTransactionRepositoryPort,
    private readonly outbox: OutboxRepositoryPort,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
  ) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    const initialAmount = Money.from({
      amount: command.initialAmount,
      currency: command.currency,
    });

    try {
      return await this.uow.transaction((tx) =>
        this.run(tx, command.playerId, initialAmount),
      );
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        return this.readExisting(command.playerId, initialAmount.currency);
      }

      throw error;
    }
  }

  private async run(
    tx: EntityManager,
    playerId: string,
    initialAmount: Money,
  ): Promise<CreateWalletResult> {
    const existing = await this.wallets.findByPlayer(
      tx,
      playerId,
      initialAmount.currency,
    );

    if (existing) {
      return { outcome: 'ALREADY_EXISTS', wallet: existing.state() };
    }

    const now = this.clock.now();
    const walletId = this.ids.newId();
    const roundId = this.ids.newId();

    // The wallet is born already funded at version 1 (§9): opening is the
    // state it starts in, not a change it undergoes afterwards.
    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: initialAmount,
      openedAt: now,
    });

    await this.wallets.insert(tx, wallet);

    // §9: only an initial balance greater than zero creates an OPENING
    // transaction. A wallet opened at zero simply exists, empty.
    const entry = wallet.openingEntry({
      entryId: this.ids.newId(),
      transactionId: this.ids.newId(),
      at: now,
    });

    if (!entry) {
      return { outcome: 'CREATED', wallet: wallet.state() };
    }

    const openingId = entry.props().transactionId;

    const opening = WagerTransaction.rehydrate({
      id: openingId,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: openingId,
      idempotencyKey: `opening:${walletId}`,
      payloadHash: payloadHash({
        providerId: OPENING_PROVIDER_ID,
        externalTransactionId: openingId,
        playerId,
        walletId,
        roundId,
        gameId: OPENING_GAME_ID,
        kind: WagerTransactionKind.Opening,
        money: initialAmount.props(),
      }),
      walletId,
      playerId,
      roundId,
      gameId: OPENING_GAME_ID,
      kind: WagerTransactionKind.Opening,
      money: initialAmount.props(),
      status: WagerTransactionStatus.Processed,
      processedAt: now,
      createdAt: now,
    });

    // A replay of the OPENING transaction has to return the balance it saw
    // (§7.7), exactly like any other answered transaction.
    opening.recordResultBalance(initialAmount);

    // Insert order matters: `wallet_ledger_entries.transaction_id` is a real
    // foreign key, so the transaction row has to exist before its entry.
    await this.wagerTransactions.insert(tx, opening, walletId);
    await this.wallets.insertEntry(tx, entry);

    const event = WalletBalanceChanged.from({
      eventId: this.ids.newId(),
      wallet,
      entry,
      ctx: { correlationId: walletId },
    });

    await this.outbox.insert(tx, OutboxMessage.enqueue(event));

    return { outcome: 'CREATED', wallet: wallet.state() };
  }

  private async readExisting(
    playerId: string,
    currency: CurrencyCode,
  ): Promise<CreateWalletResult> {
    const existing = await this.uow.read((em) =>
      this.wallets.findByPlayer(em, playerId, currency),
    );

    if (!existing) {
      // Fail loud: a unique violation means SOME row was committed for this
      // (player, currency) pair. If the row is not there, the data is broken —
      // and silently creating a second wallet would be far worse than an error.
      throw new InvalidWalletStateError(
        'wallet vanished right after a unique violation',
        { playerId, currency },
      );
    }

    return { outcome: 'ALREADY_EXISTS', wallet: existing.state() };
  }
}
