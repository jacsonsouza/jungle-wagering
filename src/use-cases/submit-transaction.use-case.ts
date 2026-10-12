import type { EntityManager } from '@mikro-orm/core';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type {
  DomainError,
  MoneyProps,
  Wallet,
  WalletLedgerEntry,
  WagerTransactionKind,
} from '../domain/index.js';
import {
  AlreadyReversedError,
  assertReferenceIsValid,
  computeBackoff,
  CurrencyMismatchError,
  directionFor,
  FailureCode,
  InvalidAmountError,
  isDomainError,
  LedgerDirection,
  Money,
  OutboxMessage,
  PayloadMismatchError,
  ReferenceRequiredError,
  WalletBalanceChanged,
  WalletScopeMismatchError,
  wagerTransactionPayloadHash,
  WagerTransaction,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionStatus,
} from '../domain/index.js';
import { secondsBetween, type ClockPort } from '../ports/clock.port.js';
import type { IdGeneratorPort } from '../ports/id-generator.port.js';
import type { LoggerPort } from '../ports/logger.port.js';
import type { MetricsPort } from '../ports/metrics.port.js';
import type { OutboxRepositoryPort } from '../ports/outbox-repository.port.js';
import type { UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import type { WagerTransactionRepositoryPort } from '../ports/wager-transaction-repository.port.js';
import type { WalletRepositoryPort } from '../ports/wallet-repository.port.js';
import { isLockConflict } from '../observability/lock-conflict.js';

/**
 * §7.1: attempt #1 is the moment this submission discovers the reference is
 * missing. The worker owns every attempt after it — and after
 * `MAX_PENDING_ATTEMPTS`, the spec wants a REJECTED with a failureCode naming
 * the reference that never showed up.
 */
const FIRST_PENDING_ATTEMPT = 1;

export interface SubmitTransactionCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  /** The `Idempotency-Key` header — §9 makes it the source of truth. */
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
}

/** Mirrors the §9 response body one to one. */
export interface SubmitTransactionResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly balance: MoneyProps;
  readonly idempotentReplay: boolean;
  readonly failureCode?: FailureCode;
}

/**
 * Applies one wagering operation to a wallet, exactly once.
 *
 * The flow has three phases, and the boundary between them decides what gets
 * written when something says no:
 *
 * 1. **Payload** — money parsing, positivity. Nothing is locked, nothing is
 *    written; a broken payload is a 400 and leaves no trace.
 * 2. **Ownership and idempotency** — the wallet row is taken under a
 *    pessimistic lock (§8: `walletId` is the unit of concurrency, so every
 *    submission for one wallet queues here), then the stored answer for this
 *    operation is looked up. Refusals here are derivable from data that cannot
 *    change, so they throw and write nothing.
 * 3. **Business rules** — the reference is resolved, the movement applied.
 *    Every refusal here depends on rows outside the request's scope (a balance another bet
 *    may have moved, a reference that may not have arrived), so it is persisted
 *    as a REJECTED with its failureCode: §9 demands the same answer on replay
 *    even after the world has moved on.
 *
 * Money never enters this class as a `number` — `Money` parses the decimal
 * string and keeps it that way, so `0.1 + 0.2` can never reach a balance.
 */
export class SubmitTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly wallets: WalletRepositoryPort,
    private readonly wagerTransactions: WagerTransactionRepositoryPort,
    private readonly outbox: OutboxRepositoryPort,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    private readonly logger: LoggerPort,
    private readonly metrics: MetricsPort,
  ) {}

  /**
   * The HTTP entry point: settle the command, then record what happened.
   *
   * The recording lives HERE rather than in `run()`, because `run()` also
   * serves the queue (§10) and the consumer keeps its own counts. One funnel
   * per entry point means the two series describe disjoint traffic instead of
   * silently double-counting every message.
   */
  async execute(
    command: SubmitTransactionCommand,
  ): Promise<SubmitTransactionResult> {
    const startedAt = this.clock.now();
    const result = await this.settle(command);

    this.record(result, command, startedAt);

    return result;
  }

  /** The submission proper: payload, transaction, and the 23505 recovery. */
  private async settle(
    command: SubmitTransactionCommand,
  ): Promise<SubmitTransactionResult> {
    const money = this.parseMoney(command);

    try {
      return await this.uow.transaction((tx) => this.run(tx, command, money));
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        return this.answerAfterRace(command, money);
      }

      // §12 asks for lock conflicts as a metric. A contended wallet normally
      // just blocks — invisible from outside — so this only ever fires when
      // waiting stopped working: a deadlock, or a wait past the timeout.
      if (isLockConflict(error)) {
        this.metrics.increment('lock_conflicts_total');
      }

      throw error;
    }
  }

  /**
   * §12: one structured line, and the HTTP-path series, per answered
   * submission.
   *
   * The log carries the identifiers §12 names — `transactionId`, `walletId`,
   * `providerId` — and deliberately no money. The ledger is the audit trail
   * for amounts; a log line is not the place for a financial payload, even a
   * partial one.
   */
  private record(
    result: SubmitTransactionResult,
    command: SubmitTransactionCommand,
    startedAt: Date,
  ): void {
    this.metrics.increment('transactions_total', { status: result.status });
    this.metrics.observe(
      'transaction_processing_seconds',
      secondsBetween(startedAt, this.clock.now()),
      { status: result.status },
    );

    // A replay is counted above too: that series describes what callers were
    // TOLD, and a replay is an answered request like any other. "How many
    // requests were duplicates" is a different question, so it gets a series
    // of its own rather than being folded into the status count.
    if (result.idempotentReplay) {
      this.metrics.increment('idempotent_replays_total');
    }

    this.logger.info('transaction settled', {
      transactionId: result.transactionId,
      walletId: command.walletId,
      providerId: command.providerId,
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
    });
  }

  /**
   * The same submission, inside a transaction the CALLER owns.
   *
   * §11 requires the inbox record and the effects to commit together, so the
   * SQS consumer needs one transaction spanning both. Offering this instead of
   * opening a second transaction keeps that guarantee structural: the consumer
   * cannot accidentally split them, because there is only ever one transaction.
   *
   * The 23505 recovery deliberately does NOT live here — it re-reads in a
   * fresh transaction, which would escape the caller's. The consumer treats a
   * unique violation as "another worker won", rolls back its own work and
   * acks.
   */
  async executeIn(
    tx: EntityManager,
    command: SubmitTransactionCommand,
  ): Promise<SubmitTransactionResult> {
    return this.run(tx, command, this.parseMoney(command));
  }

  /** Phase 1, extracted so both entry points enforce the exact same rule. */
  private parseMoney(command: SubmitTransactionCommand): Money {
    const money = Money.from(command.money);

    if (!money.isPositive()) {
      throw new InvalidAmountError('transaction amount must be positive', {
        amount: command.money.amount,
      });
    }

    return money;
  }

  private async run(
    tx: EntityManager,
    command: SubmitTransactionCommand,
    money: Money,
  ): Promise<SubmitTransactionResult> {
    const wallet = await this.requireOwnedWallet(tx, command, money);

    const incomingHash = this.incomingHash(command, money);

    // §9: the Idempotency-Key header is the source of truth. The provider's own
    // (providerId, externalTransactionId) pair is an independent second guard,
    // so resubmitting the same operation under a FRESH key still cannot debit
    // twice. Both lookups describe one row — the pair is unique — so the first
    // hit is the whole answer.
    const existing =
      (await this.wagerTransactions.findByIdempotencyKey(
        tx,
        command.idempotencyKey,
      )) ??
      (await this.wagerTransactions.findByProviderExternal(
        tx,
        command.providerId,
        command.externalTransactionId,
      ));

    if (existing) {
      if (!existing.matchesPayload(incomingHash)) {
        // §9: same key with a divergent payload is a CONFLICT, never a replay.
        throw new PayloadMismatchError(
          'idempotency key was already used with a different payload',
          {
            idempotencyKey: command.idempotencyKey,
            transactionId: existing.id,
          },
        );
      }

      if (existing.isTerminal()) {
        // §7.7: the ORIGINAL answer, balance observed at that moment included.
        return this.result(existing, true);
      }

      // Only an unresolved row reaches the code below. §7.7 promises the
      // original answer for transactions that were PROCESSED — a transaction
      // still waiting for its reference has no answer yet, so it is retried
      // instead of replaying 202 forever.
    }

    const now = this.clock.now();
    const rowExists = existing !== null;

    const transaction =
      existing ??
      WagerTransaction.create({
        id: this.ids.newId(),
        idempotencyKey: command.idempotencyKey,
        createdAt: now,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        playerId: command.playerId,
        walletId: command.walletId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
      });

    let reference: WagerTransaction | null = null;

    if (transaction.requiresReference()) {
      const referenceExternalId = transaction.referenceExternalTransactionId;

      if (referenceExternalId === undefined) {
        // `create` refuses a reversal without one, so this only guards a row
        // persisted before that rule existed. Fail loud: deferring it would
        // schedule work that can never resolve.
        throw new ReferenceRequiredError(
          `${transaction.kind} requires a referenceExternalTransactionId`,
          { kind: transaction.kind },
        );
      }

      reference = await this.wagerTransactions.findByProviderExternal(
        tx,
        command.providerId,
        referenceExternalId,
      );

      if (!reference) {
        // §7.8: not a failure — the reference simply has not arrived yet.
        return this.defer(tx, transaction, wallet, now, rowExists);
      }
    }

    // Phase 3: from here to the first INSERT a refusal is possible, and every
    // one of them is persisted rather than thrown (see the class doc).
    let entry: WalletLedgerEntry | null = null;

    try {
      if (reference) {
        this.assertReversalIsAllowed(transaction, reference);

        const reversal = await this.wagerTransactions.findReversalForReference(
          tx,
          reference.id,
        );

        if (reversal) {
          throw new AlreadyReversedError('reference was already reversed', {
            referenceTransactionId: reference.id,
            reversalTransactionId: reversal.id,
          });
        }
      }

      // Read-only: asks what the ledger WOULD do before anything is touched.
      // LOSS answers null — it records a result and moves nothing (§7).
      const direction = directionFor(
        transaction.kind,
        WagerTransactionStatus.Processed,
        reference
          ? { kind: reference.kind, status: reference.status }
          : undefined,
      );

      if (direction !== null) {
        entry = this.move(wallet, transaction, direction, money, now);
      }

      // Cannot throw: a non-terminal transaction is PENDING or
      // PENDING_REFERENCE, and the transition table maps both onto PROCESSED;
      // `recordResultBalance` then sees a status that is no longer PENDING.
      transaction.markProcessed(reference?.id, now);
      transaction.recordResultBalance(wallet.balance);
    } catch (error) {
      if (!isDomainError(error)) {
        throw error;
      }

      return this.persistRejection(tx, transaction, wallet, error, now, rowExists);
    }

    // No DomainError is converted from here on: failing to build an event or
    // to write a row means the data itself is broken, so the whole transaction
    // rolls back instead of answering with something that is not understood.
    await this.saveTransaction(tx, transaction, wallet.id, rowExists);

    if (entry) {
      // Insert order matters: wallet_ledger_entries.transaction_id is a real
      // foreign key, so the transaction row has to exist before its entry.
      await this.wallets.insertEntry(tx, entry);
      await this.wallets.update(tx, wallet);
    }

    await this.announce(
      tx,
      WagerTransactionProcessed.from({
        eventId: this.ids.newId(),
        transaction,
        ctx: { correlationId: transaction.id },
      }),
    );

    if (entry) {
      // §11: only a balance that actually changed announces itself — LOSS
      // emits WagerTransactionProcessed and nothing else.
      await this.announce(
        tx,
        WalletBalanceChanged.from({
          eventId: this.ids.newId(),
          wallet,
          entry,
          ctx: { correlationId: transaction.id },
        }),
      );
    }

    return this.result(transaction, false);
  }

  /**
   * The wallet lock and the scope check, in one place.
   *
   * The SAME answer whether the wallet is missing or belongs to someone else:
   * categorizing this as NOT_FOUND keeps the endpoint from becoming an oracle
   * that confirms which wallet ids exist.
   */
  private async requireOwnedWallet(
    tx: EntityManager,
    command: SubmitTransactionCommand,
    money: Money,
  ): Promise<Wallet> {
    // §8's contention point: the one place a submission waits on another.
    // Timing it turns the lock into something observable — a BLOCKING lock is
    // silent by design, so without this there is no way to see wallets
    // getting contended until submissions start failing outright.
    //
    // The reading includes the index lookup, which is sub-millisecond; a
    // rising tail is therefore contention, not query cost.
    const lockRequestedAt = this.clock.now();
    const wallet = await this.wallets.findByIdForUpdate(tx, command.walletId);
    this.metrics.observe(
      'wallet_lock_wait_seconds',
      secondsBetween(lockRequestedAt, this.clock.now()),
    );

    if (!wallet || wallet.playerId !== command.playerId) {
      throw new WalletScopeMismatchError(
        'wallet does not belong to this player',
        { walletId: command.walletId, playerId: command.playerId },
      );
    }

    if (money.currency !== wallet.currency) {
      throw new CurrencyMismatchError(
        'transaction currency differs from wallet currency',
        { wallet: wallet.currency, transaction: money.currency },
      );
    }

    return wallet;
  }

  /**
   * §7.8: the reference has not arrived. The transaction is persisted as
   * PENDING_REFERENCE with the worker armed, so the caller gets an honest
   * "accepted, still waiting" instead of a silent loss.
   */
  private async defer(
    tx: EntityManager,
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
    rowExists: boolean,
  ): Promise<SubmitTransactionResult> {
    if (transaction.status === WagerTransactionStatus.PendingReference) {
      // Already deferred by an earlier call: the row, its schedule and its
      // WagerTransactionPendingReference event are all in place. Re-arming
      // would restart the backoff at attempt #1 on every retry and postpone
      // the §7.1 attempt limit forever — so this returns the very same 202.
      return this.result(transaction, true);
    }

    transaction.markPendingReference(now);
    // The balance never moved, but recording it here is what makes this 202
    // identical to every later retry of it (§9).
    transaction.recordResultBalance(wallet.balance);

    await this.saveTransaction(tx, transaction, wallet.id, rowExists);
    await this.wagerTransactions.schedulePendingAttempt(
      tx,
      transaction.id,
      FIRST_PENDING_ATTEMPT,
      new Date(now.getTime() + computeBackoff(FIRST_PENDING_ATTEMPT)),
    );
    await this.announce(
      tx,
      WagerTransactionPendingReference.from({
        eventId: this.ids.newId(),
        transaction,
        ctx: { correlationId: transaction.id },
      }),
    );

    return this.result(transaction, false);
  }

  /**
   * §7.4 and §7 rule 2–5: scope, status, kind and value of the reference, then
   * the single reversal it is entitled to.
   */
  private assertReversalIsAllowed(
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): void {
    assertReferenceIsValid({
      incoming: {
        providerId: transaction.providerId,
        playerId: transaction.playerId,
        walletId: transaction.walletId,
        roundId: transaction.roundId,
        kind: transaction.kind,
        amount: transaction.money.toString(),
        currency: transaction.money.currency,
      },
      reference: {
        providerId: reference.providerId,
        playerId: reference.playerId,
        walletId: reference.walletId,
        roundId: reference.roundId,
        kind: reference.kind,
        status: reference.status,
        amount: reference.money.toString(),
        currency: reference.money.currency,
      },
    });
  }

  /**
   * One movement, with the failure code the provider needs to tell the two
   * apart (§7.9): a reversal that cannot be honoured is operationally a
   * different event from a bet the player simply cannot afford.
   *
   * `Wallet.move` refuses BEFORE mutating, so a rejection here leaves the
   * balance untouched — which is what makes converting it into a persisted
   * REJECTED safe.
   */
  private move(
    wallet: Wallet,
    transaction: WagerTransaction,
    direction: LedgerDirection,
    money: Money,
    at: Date,
  ): WalletLedgerEntry {
    const movement = {
      entryId: this.ids.newId(),
      transactionId: transaction.id,
      money,
      at,
      insufficientFundsCode: transaction.requiresReference()
        ? FailureCode.ReversalInsufficientFunds
        : FailureCode.InsufficientFunds,
    };

    return direction === LedgerDirection.Debit
      ? wallet.debit(movement)
      : wallet.credit(movement);
  }

  /**
   * §7.6/§7.9: no balance change and no ledger entry — but the row and its
   * failureCode are written, so the refusal is auditable and replays exactly
   * even after the balance that caused it has moved on.
   */
  private async persistRejection(
    tx: EntityManager,
    transaction: WagerTransaction,
    wallet: Wallet,
    error: DomainError,
    now: Date,
    rowExists: boolean,
  ): Promise<SubmitTransactionResult> {
    transaction.reject(error.code, now);
    transaction.recordResultBalance(wallet.balance);

    await this.saveTransaction(tx, transaction, wallet.id, rowExists);
    await this.announce(
      tx,
      WagerTransactionRejected.from({
        eventId: this.ids.newId(),
        transaction,
        ctx: { correlationId: transaction.id },
      }),
    );

    return this.result(transaction, false);
  }

  /**
   * The row is inserted when this call created it and updated when it
   * predated it — one rule instead of three copies of the same branch.
   */
  private async saveTransaction(
    tx: EntityManager,
    transaction: WagerTransaction,
    walletId: string,
    rowExists: boolean,
  ): Promise<void> {
    if (rowExists) {
      await this.wagerTransactions.update(tx, transaction);
      return;
    }

    await this.wagerTransactions.insert(tx, transaction, walletId);
  }

  private async announce(
    tx: EntityManager,
    event: Parameters<typeof OutboxMessage.enqueue>[0],
  ): Promise<void> {
    await this.outbox.insert(tx, OutboxMessage.enqueue(event));
  }

  /**
   * The payload of the incoming request, signed with the very function
   * `WagerTransaction.create` uses — two implementations here would be two
   * definitions of "identical", which is the bug idempotency exists to stop.
   */
  private incomingHash(
    command: SubmitTransactionCommand,
    money: Money,
  ): string {
    return wagerTransactionPayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });
  }

  /**
   * Two requests submitted the same operation at the same moment and the
   * database let exactly one of them through.
   *
   * Postgres reports the violation without naming the index, and parsing
   * `sqlMessage` would tie correctness to an error string. So the recovery
   * asks the database what actually won: an insert only fails once the conflicting row
   * is committed — it waits while the other transaction is in flight — so by
   * the time execution reaches here a fresh read is guaranteed to see the winner.
   */
  private async answerAfterRace(
    command: SubmitTransactionCommand,
    money: Money,
  ): Promise<SubmitTransactionResult> {
    const incomingHash = this.incomingHash(command, money);

    return this.uow.read(async (em) => {
      const byKey = await this.wagerTransactions.findByIdempotencyKey(
        em,
        command.idempotencyKey,
      );

      if (byKey) {
        return this.answerRacedRow(byKey, incomingHash, command);
      }

      const byExternal = await this.wagerTransactions.findByProviderExternal(
        em,
        command.providerId,
        command.externalTransactionId,
      );

      if (byExternal) {
        return this.answerRacedRow(byExternal, incomingHash, command);
      }

      // Neither of the submission's own indexes explains the violation, so it
      // has to be the reversal index — another request reversed this reference
      // first (§7.4), and both requests lost the same race.
      const referenceExternalId = command.referenceExternalTransactionId;

      if (referenceExternalId !== undefined) {
        const reference = await this.wagerTransactions.findByProviderExternal(
          em,
          command.providerId,
          referenceExternalId,
        );

        if (reference) {
          const reversal =
            await this.wagerTransactions.findReversalForReference(
              em,
              reference.id,
            );

          if (reversal) {
            throw new AlreadyReversedError('reference was already reversed', {
              referenceTransactionId: reference.id,
              reversalTransactionId: reversal.id,
            });
          }
        }
      }

      // Fail loud: a unique violation with no visible winner means the data
      // does not add up. Answering anyway would hide a real integrity problem.
      throw new Error(
        `unique violation for idempotency key "${command.idempotencyKey}" has no committed winner`,
      );
    });
  }

  private answerRacedRow(
    row: WagerTransaction,
    incomingHash: string,
    command: SubmitTransactionCommand,
  ): SubmitTransactionResult {
    if (!row.matchesPayload(incomingHash)) {
      throw new PayloadMismatchError(
        'idempotency key was already used with a different payload',
        { idempotencyKey: command.idempotencyKey, transactionId: row.id },
      );
    }

    // The winner did the work; this caller is a duplicate and gets its answer.
    return this.result(row, true);
  }

  private result(
    transaction: WagerTransaction,
    idempotentReplay: boolean,
  ): SubmitTransactionResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: recordedBalanceOf(transaction).props(),
      idempotentReplay,
      failureCode: transaction.failureCode,
    };
  }
}

/**
 * §7.7: the balance recorded when this transaction was answered — never the
 * wallet's balance today, which other bets may have moved since.
 *
 * Fails loud when a terminal transaction carries none: answering with the
 * current balance would hand the provider a number that was never true for
 * this transaction.
 */
function recordedBalanceOf(transaction: WagerTransaction): Money {
  const balance = transaction.resultBalance;

  if (!balance) {
    throw new Error(
      `transaction ${transaction.id} is ${transaction.status} without a recorded result balance`,
    );
  }

  return balance;
}
