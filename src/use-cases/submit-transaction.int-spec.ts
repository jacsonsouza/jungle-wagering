import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CurrencyCode, WagerTransactionKind } from '../domain/index.js';
import { SystemClock } from '../ports/clock.port.js';
import type { IdGeneratorPort } from '../ports/id-generator.port.js';
import { MikroOrmUnitOfWork } from '../ports/unit-of-work.port.js';
import { MikroOrmOutboxRepository } from '../repositories/outbox.repository.js';
import { MikroOrmWagerTransactionRepository } from '../repositories/wager-transaction.repository.js';
import { MikroOrmWalletRepository } from '../repositories/wallet.repository.js';
import { CreateWalletUseCase } from './create-wallet.use-case.js';
import type { SubmitTransactionCommand } from './submit-transaction.use-case.js';
import { SubmitTransactionUseCase } from './submit-transaction.use-case.js';
import type { MetricsPort } from '../ports/metrics.port.js';
import {
  closeTestOrm,
  db,
  dbRun,
  testOrm,
  truncateAllTables,
} from '../../test/setup/orm.js';
import {
  quietLogger,
  recordingMetrics,
} from '../../test/setup/observability.js';

/**
 * SubmitTransaction against real PostgreSQL.
 *
 * The unit spec proves the logic; this file proves the parts that only exist
 * against a real database: that the pessimistic lock really serialises two
 * bets racing for the same balance, that a duplicate really commits once, that
 * the ledger rebuilds to the stored balance, and that the last write failing
 * takes every earlier write down with it.
 */

/**
 * One sequence shared by every instance in the file: two use cases drawing ids
 * independently would generate the same UUIDs and collide on the primary key.
 * Each concurrent instance has to look like a separate process.
 */
let idNumber = 0;
const sharedIds: IdGeneratorPort = {
  newId: () =>
    `00000000-0000-4000-8000-${String(++idNumber).padStart(12, '0')}`,
};

/** An isolated sequence, so a test can predict the exact id a write will get. */
function sequentialIds(startAt: number): IdGeneratorPort {
  let n = startAt - 1;
  return {
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  };
}

/**
 * Builds one "instance" of the use case.
 *
 * Every one of them shares the single root EntityManager — deliberately. That
 * is what Nest injects in production, so two of these running at once is the
 * exact shape of two concurrent HTTP requests in one process. If the
 * `clear: true` isolation in `MikroOrmUnitOfWork` ever regressed, the
 * concurrency tests below are what would notice.
 */
async function buildUseCase(
  ids: IdGeneratorPort = sharedIds,
  metrics: MetricsPort = recordingMetrics(),
) {
  const orm = await testOrm();

  return new SubmitTransactionUseCase(
    new MikroOrmUnitOfWork(orm.em),
    new MikroOrmWalletRepository(),
    new MikroOrmWagerTransactionRepository(),
    new MikroOrmOutboxRepository(),
    new SystemClock(),
    ids,
    quietLogger,
    metrics,
  );
}

async function givenWallet(
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

function bet(
  walletId: string,
  externalTransactionId: string,
  amount = '25.00',
): SubmitTransactionCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: 'player-1',
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: CurrencyCode.BRL },
  };
}

function refund(
  walletId: string,
  externalTransactionId: string,
  referenceExternalTransactionId: string,
): SubmitTransactionCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: 'player-1',
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Refund,
    money: { amount: '25.00', currency: CurrencyCode.BRL },
    referenceExternalTransactionId,
  };
}

async function count(table: string): Promise<number> {
  const rows = await db<{ count: string }>(
    `select count(*)::text as count from "${table}"`,
  );

  return Number(rows[0].count);
}

/**
 * The invariant the whole system exists to preserve: the balance a wallet
 * claims is exactly the balance its own history adds up to.
 *
 * Checked after every scenario — if it ever fails, money was created out of
 * nothing or destroyed without a trace. That is the one bug there is no
 * coming back from.
 */
async function assertWalletMatchesLedger(walletId: string): Promise<void> {
  const [wallet] = await db<{ balance: string }>(
    `select balance::text as balance from "wallets" where id = '${walletId}'`,
  );

  const [ledger] = await db<{ rebuilt: string }>(
    `select coalesce(
              sum(case when direction = 'CREDIT' then amount else -amount end),
              0.00
            )::text as rebuilt
       from "wallet_ledger_entries"
      where wallet_id = '${walletId}'`,
  );

  expect({ stored: wallet.balance, rebuilt: ledger.rebuilt }).toEqual({
    stored: ledger.rebuilt,
    rebuilt: ledger.rebuilt,
  });
}

describe('SubmitTransactionUseCase (integration)', () => {
  beforeAll(async () => {
    await testOrm();
  });

  afterAll(async () => {
    await closeTestOrm();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('applies a BET and leaves a ledger that rebuilds to the stored balance', async () => {
    const walletId = await givenWallet('player-1', '100.00');
    const useCase = await buildUseCase();

    const result = await useCase.execute(bet(walletId, 'ext-1'));

    expect(result).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: false,
      balance: { amount: '75.00', currency: 'BRL' },
    });

    const [transaction] = await db<{
      kind: string;
      status: string;
      result_balance_amount: string;
      pending_attempts: number;
      pending_next_attempt_at: string | null;
    }>(
      `select kind, status,
              result_balance_amount::text as result_balance_amount,
              pending_attempts, pending_next_attempt_at
         from "wager_transactions"
        where id = '${result.transactionId}'`,
    );
    expect(transaction).toEqual({
      kind: 'BET',
      status: 'PROCESSED',
      result_balance_amount: '75.00',
      pending_attempts: 0,
      // Never armed: this transaction never waited for anything.
      pending_next_attempt_at: null,
    });

    // Every event sits in the outbox inside the SAME transaction that moved
    // the money — nothing can be published for a balance that never changed.
    // Scoped to this BET: funding the wallet announced itself too.
    const outbox = await db<{ event_type: string }>(
      `select event_type from "outbox_messages"
        where payload->'data'->>'transactionId' = '${result.transactionId}'
        order by event_type`,
    );
    expect(outbox.map((row) => row.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    await assertWalletMatchesLedger(walletId);
  });

  it('replays with the balance observed then, after the balance moved on', async () => {
    const walletId = await givenWallet('player-1', '100.00');
    const useCase = await buildUseCase();

    const bet1 = bet(walletId, 'ext-1');
    const first = await useCase.execute(bet1);

    // The player later wins 50 — the balance this transaction answered with is
    // no longer the balance in the wallet.
    await useCase.execute({
      ...bet(walletId, 'ext-win-1', '50.00'),
      kind: WagerTransactionKind.Win,
    });

    const replay = await useCase.execute(bet1);

    // §7.7: the original answer, not today's balance.
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.status).toBe('PROCESSED');
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    expect(await count('wallet_ledger_entries')).toBe(3); // opening + bet + win
    expect(await count('wager_transactions')).toBe(3);

    await assertWalletMatchesLedger(walletId);
  });

  it('commits a duplicate submission exactly once when both arrive together', async () => {
    const walletId = await givenWallet('player-1', '100.00');
    const command = bet(walletId, 'ext-dup');
    const [first, second] = await Promise.all([
      (await buildUseCase()).execute(command),
      (await buildUseCase()).execute(command),
    ]);

    expect(first.transactionId).toBe(second.transactionId);

    // One row, one ledger entry, one debit — regardless of which instance won.
    expect(await count('wager_transactions')).toBe(2); // opening + one bet
    expect(await count('wallet_ledger_entries')).toBe(2);

    const [wallet] = await db<{ balance: string }>(
      `select balance::text as balance from "wallets" where id = '${walletId}'`,
    );
    expect(wallet.balance).toBe('75.00');

    await assertWalletMatchesLedger(walletId);
  });

  it('never lets two bets race past the same balance', async () => {
    // 30.00 cannot cover two bets of 25.00: without the wallet lock both would
    // read 30.00, both would pass, and the wallet would end up at -20.00.
    const walletId = await givenWallet('player-1', '30.00');
    const [first, second] = await Promise.all([
      (await buildUseCase()).execute(bet(walletId, 'ext-a')),
      (await buildUseCase()).execute(bet(walletId, 'ext-b')),
    ]);

    expect([first.status, second.status].sort()).toEqual([
      'PROCESSED',
      'REJECTED',
    ]);

    const [wallet] = await db<{ balance: string }>(
      `select balance::text as balance from "wallets" where id = '${walletId}'`,
    );
    expect(wallet.balance).toBe('5.00');
    expect(Number(wallet.balance)).toBeGreaterThanOrEqual(0);

    await assertWalletMatchesLedger(walletId);
  });

  it('arms the reference worker when a REFUND finds no reference', async () => {
    const walletId = await givenWallet('player-1', '100.00');
    const useCase = await buildUseCase();

    const result = await useCase.execute(
      refund(walletId, 'ext-refund-1', 'ext-bet-not-here'),
    );

    expect(result).toMatchObject({
      status: 'PENDING_REFERENCE',
      idempotentReplay: false,
      balance: { amount: '100.00', currency: 'BRL' },
    });

    const [pending] = await db<{
      status: string;
      pending_attempts: number;
      due_in: number;
    }>(
      `select status, pending_attempts,
              extract(epoch from (pending_next_attempt_at - now()))::int as due_in
         from "wager_transactions"
        where id = '${result.transactionId}'`,
    );
    expect(pending.status).toBe('PENDING_REFERENCE');
    expect(pending.pending_attempts).toBe(1);
    // §7.1 backoff starts at 1s; allow the round trip to eat into it.
    expect(pending.due_in).toBeLessThanOrEqual(1);
    expect(pending.due_in).toBeGreaterThan(-5);

    // The exact query the worker will run — if the row were not visible here
    // it would wait forever, because `idx_wager_tx_pending_due` is partial.
    const due = await db<{ id: string }>(
      `select id from "wager_transactions"
        where status = 'PENDING_REFERENCE'
          and pending_next_attempt_at <= now() + interval '1 second'`,
    );
    expect(due.map((row) => row.id)).toContain(result.transactionId);

    // Nothing moved while waiting for the reference.
    expect(await count('wallet_ledger_entries')).toBe(1); // the opening only
    await assertWalletMatchesLedger(walletId);
  });

  it('rolls back every write when the last one fails (atomicity)', async () => {
    const walletId = await givenWallet('player-1', '100.00');

    // A fresh sequence makes the ids this submission will draw predictable:
    // #1000 the transaction, #1001 the ledger entry, #1002 the processed event
    // and #1003 the balance-changed event — the LAST write. Planting a
    // conflicting row at #1003 makes it blow up after the wallet, the ledger
    // and the transaction were already written.
    const eventIds = sequentialIds(1_000);
    const useCase = await buildUseCase(eventIds);

    await dbRun(
      `insert into "outbox_messages"
         (id, aggregate_id, event_type, payload, occurred_at, attempts)
       values ('00000000-0000-4000-8000-000000001003', 'planted', 'Planted',
               '{}'::jsonb, now(), 0)`,
    );

    await expect(useCase.execute(bet(walletId, 'ext-atomic'))).rejects.toThrow(
      /unique violation/,
    );

    // The debit happened inside the transaction and the transaction is gone:
    // not one cent moved, not one row survived.
    const [wallet] = await db<{ balance: string }>(
      `select balance::text as balance from "wallets" where id = '${walletId}'`,
    );
    expect(wallet.balance).toBe('100.00');
    expect(await count('wager_transactions')).toBe(1); // the opening only
    expect(await count('wallet_ledger_entries')).toBe(1);
    expect(await count('outbox_messages')).toBe(2); // opening + the planted row

    await assertWalletMatchesLedger(walletId);
  });

  it('keeps a second reversal out at the database level, bypassing the application', async () => {
    const walletId = await givenWallet('player-1', '100.00');
    const useCase = await buildUseCase();

    const bet1 = bet(walletId, 'ext-bet-1');
    const placed = await useCase.execute(bet1);
    const reversed = await useCase.execute(
      refund(walletId, 'ext-refund-1', 'ext-bet-1'),
    );
    expect(reversed.status).toBe('PROCESSED');

    // §5.9: the application's pre-check is a courtesy, not the guarantee.
    // This INSERT never goes through application code, so only the partial
    // unique index stands between it and a double refund.
    await expect(
      dbRun(
        `insert into "wager_transactions"
           (id, provider_id, external_transaction_id, idempotency_key,
            payload_hash, wallet_id, player_id, round_id, game_id, kind,
            amount, currency, status, reference_transaction_id, created_at)
         values
           ('00000000-0000-4000-8000-000000009999', 'provider-a',
            'ext-refund-2', 'provider-a:ext-refund-2', repeat('a', 64),
            '${walletId}', 'player-1', 'round-1', 'fortune-chimp', 'REFUND',
            25.00, 'BRL', 'PROCESSED', '${placed.transactionId}', now())`,
      ),
    ).rejects.toThrow(/duplicate key|unique constraint/i);

    // The application's own answer is the same, and the wallet never moved
    // twice: 100 → 75 → 100, exactly one entry each way.
    expect(await count('wallet_ledger_entries')).toBe(3); // opening, bet, refund
    await assertWalletMatchesLedger(walletId);
  });
});
