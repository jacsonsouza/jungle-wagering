import { randomUUID } from 'node:crypto';
import { env } from '../../src/config/env.js';
import {
  CurrencyCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/index.js';
import { SystemClock } from '../../src/ports/clock.port.js';
import { MikroOrmUnitOfWork } from '../../src/ports/unit-of-work.port.js';
import { MikroOrmOutboxRepository } from '../../src/repositories/outbox.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../src/repositories/wager-transaction.repository.js';
import { MikroOrmWalletRepository } from '../../src/repositories/wallet.repository.js';
import { CreateWalletUseCase } from '../../src/use-cases/create-wallet.use-case.js';
import type { SubmitTransactionCommand } from '../../src/use-cases/submit-transaction.use-case.js';
import { db, dbRun, testOrm } from '../setup/orm.js';
import { bodyOf, buildQueue, freshDedupId } from '../setup/sqs.js';

/** One sequence per process, so id generation never collides across workers. */
const sharedIds = { newId: () => randomUUID() };

/**
 * Creates a funded wallet from the spec process.
 *
 * Setup, not the thing under contention, so it runs in-process: spawning a
 * worker to create a wallet would add boot time to every scenario without
 * making the assertion any stronger.
 */
export async function givenWallet(
  playerId: string,
  initialAmount: string,
): Promise<string> {
  const orm = await testOrm();

  const useCase = new CreateWalletUseCase(
    new MikroOrmUnitOfWork(orm.em),
    new MikroOrmWalletRepository(),
    new MikroOrmWagerTransactionRepository(),
    new MikroOrmOutboxRepository(),
    new SystemClock(),
    sharedIds,
  );

  const result = await useCase.execute({
    playerId,
    currency: CurrencyCode.BRL,
    initialAmount,
  });

  return result.wallet.id;
}

/**
 * A bet command. The owner is explicit: §8 makes `walletId` the unit of
 * concurrency, and the use case refuses a command whose `playerId` does not
 * own the wallet, so a hardcoded owner would fail every scenario but the first.
 */
export function bet(
  playerId: string,
  walletId: string,
  amount: string,
  overrides: Partial<SubmitTransactionCommand> = {},
): SubmitTransactionCommand {
  const externalTransactionId = `ext-${randomUUID()}`;

  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: CurrencyCode.BRL },
    ...overrides,
  };
}

/** The same command every time — the "50 copies of one bet" shape. */
export function pinnedBet(
  playerId: string,
  walletId: string,
  externalTransactionId: string,
  amount: string,
  overrides: Partial<SubmitTransactionCommand> = {},
): SubmitTransactionCommand {
  return bet(playerId, walletId, amount, {
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    ...overrides,
  });
}

/** Makes a PENDING_REFERENCE row due right now, without waiting out a backoff. */
export async function makeDue(transactionId: string): Promise<void> {
  await dbRun(
    `update "wager_transactions"
        set pending_next_attempt_at = now() - interval '1 second'
      where id = '${transactionId}'`,
  );
}

/** How many PENDING_REFERENCE rows are still waiting for their reference. */
export async function pendingReferenceCount(): Promise<number> {
  const rows = await db<{ count: string }>(
    `select count(*)::text as count from "wager_transactions"
      where status = '${WagerTransactionStatus.PendingReference}'`,
  );

  return Number(rows[0].count);
}

/** The stored balance of one wallet, as the database itself reports it. */
export async function balanceOf(walletId: string): Promise<string> {
  const [row] = await db<{ balance: string }>(
    `select balance::text as balance from "wallets" where id = '${walletId}'`,
  );

  return row.balance;
}

/** Sends a command to the queue exactly as a provider would. */
export async function sendToQueue(
  command: SubmitTransactionCommand,
): Promise<void> {
  const queue = buildQueue();

  await queue.send(env.sqs.queueUrl, {
    messageGroupId: command.walletId,
    deduplicationId: freshDedupId(),
    body: bodyOf(command),
  });
}

/** The shape every `submit` worker reports back. */
interface SubmitReport {
  readonly transactionId: string;
  readonly status: string;
  readonly idempotentReplay: boolean;
  readonly failureCode?: string;
}

export function reportOf(detail: unknown): SubmitReport {
  return detail as SubmitReport;
}
