import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CurrencyCode } from '../domain/index.js';
import { SystemClock } from '../ports/clock.port.js';
import type { IdGeneratorPort } from '../ports/id-generator.port.js';
import { MikroOrmUnitOfWork } from '../ports/unit-of-work.port.js';
import { MikroOrmOutboxRepository } from '../repositories/outbox.repository.js';
import { MikroOrmWagerTransactionRepository } from '../repositories/wager-transaction.repository.js';
import { MikroOrmWalletRepository } from '../repositories/wallet.repository.js';
import { CreateWalletUseCase } from './create-wallet.use-case.js';
import {
  closeTestOrm,
  db,
  dbRun,
  testOrm,
  truncateAllTables,
} from '../../test/setup/orm.js';

/**
 * CreateWallet against real PostgreSQL.
 *
 * The unit spec proves the logic; this file proves the parts that only exist
 * against a real database: the unique-violation race path, the atomicity of
 * the four writes, and the audit trail the ledger is supposed to leave behind.
 */

/** Ids must be real UUIDs — every id column in the schema is `uuid`. */
function sequentialIds(): IdGeneratorPort {
  let n = 0;
  return {
    newId: () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    },
  };
}

const EVENT_ID = '00000000-0000-4000-8000-000000000005'; // 5th id: the outbox event

async function buildUseCase(ids: IdGeneratorPort = sequentialIds()) {
  const { em } = await testOrm();

  return new CreateWalletUseCase(
    new MikroOrmUnitOfWork(em),
    new MikroOrmWalletRepository(),
    new MikroOrmWagerTransactionRepository(),
    new MikroOrmOutboxRepository(),
    new SystemClock(),
    ids,
  );
}

async function count(table: string): Promise<number> {
  const rows = await db<{ count: string }>(
    `select count(*)::text as count from "${table}"`,
  );

  return Number(rows[0].count);
}

describe('CreateWalletUseCase (integration)', () => {
  beforeAll(async () => {
    await testOrm();
  });

  afterAll(async () => {
    await closeTestOrm();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('creates a funded wallet and leaves a complete audit trail', async () => {
    const useCase = await buildUseCase();

    const result = await useCase.execute({
      playerId: 'player-1',
      currency: CurrencyCode.BRL,
      initialAmount: '100.00',
    });

    expect(result.outcome).toBe('CREATED');

    const wallets = await db<{ balance: string; version: number }>(
      `select balance::text as balance, version from "wallets"`,
    );
    expect(wallets).toEqual([
      // version 1: the wallet is BORN funded. §9 returns version 1 for a
      // wallet created with an initial balance, and §6.2 says the version
      // moves only when the balance changes afterwards.
      { balance: '100.00', version: 1 },
    ]);

    // One ledger entry per movement, with both sides of the movement recorded.
    const ledger = await db<{
      direction: string;
      amount: string;
      balance_before: string;
      balance_after: string;
    }>(
      `select direction, amount::text as amount,
              balance_before::text as balance_before,
              balance_after::text as balance_after
         from "wallet_ledger_entries"`,
    );
    expect(ledger).toEqual([
      {
        direction: 'CREDIT',
        amount: '100.00',
        balance_before: '0.00',
        balance_after: '100.00',
      },
    ]);

    // The ledger entry must point at a transaction that actually exists —
    // `wallet_ledger_entries.transaction_id` is a real foreign key, and the
    // transaction row is inserted before its entry because of it.
    const [opening] = await db<{
      kind: string;
      status: string;
      result_balance_amount: string | null;
      result_balance_currency: string | null;
      pending_attempts: number;
    }>(
      `select kind, status,
              result_balance_amount::text as result_balance_amount,
              result_balance_currency,
              pending_attempts
         from "wager_transactions"`,
    );
    expect(opening).toEqual({
      kind: 'OPENING',
      status: 'PROCESSED',
      // §7.7: a replay answers with the balance observed at that moment.
      result_balance_amount: '100.00',
      result_balance_currency: 'BRL',
      pending_attempts: 0,
    });

    const orphan = await db<{ id: string }>(
      `select e.id from "wallet_ledger_entries" e
         left join "wager_transactions" t on t.id = e.transaction_id
        where t.id is null`,
    );
    expect(orphan).toEqual([]);

    const outbox = await db<{ event_type: string }>(
      `select event_type from "outbox_messages"`,
    );
    expect(outbox).toEqual([{ event_type: 'WalletBalanceChanged' }]);
  });

  it('answers ALREADY_EXISTS without writing a second time', async () => {
    const useCase = await buildUseCase();
    const command = {
      playerId: 'player-1',
      currency: CurrencyCode.BRL,
      initialAmount: '100.00',
    };

    await useCase.execute(command);
    const second = await useCase.execute({
      ...command,
      initialAmount: '999.00', // a different amount must NOT create a new wallet
    });

    expect(second.outcome).toBe('ALREADY_EXISTS');
    expect(second.wallet.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });

    expect(await count('wallets')).toBe(1);
    expect(await count('wallet_ledger_entries')).toBe(1);
    expect(await count('wager_transactions')).toBe(1);
    expect(await count('outbox_messages')).toBe(1);
  });

  it('turns a lost insert race into ALREADY_EXISTS (real 23505 path)', async () => {
    const useCase = await buildUseCase();
    const command = {
      playerId: 'racer',
      currency: CurrencyCode.USD,
      initialAmount: '50.00',
    };

    // Both calls start before either has committed, so both pass the
    // read-then-insert check and the unique index is what actually decides.
    const results = await Promise.all([
      useCase.execute(command),
      useCase.execute(command),
    ]);

    expect(results.map((r) => r.outcome).sort()).toEqual([
      'ALREADY_EXISTS',
      'CREATED',
    ]);

    // The loser must have written nothing at all.
    expect(await count('wallets')).toBe(1);
    expect(await count('wallet_ledger_entries')).toBe(1);
    expect(await count('wager_transactions')).toBe(1);
    expect(await count('outbox_messages')).toBe(1);
    const [winner] = await db<{ balance: string }>(
      `select balance::text as balance from "wallets"`,
    );
    expect(winner.balance).toBe('50.00');
  });

  it('rolls back every write when the last one fails (atomicity)', async () => {
    // Ids are deterministic, so the test can predict the outbox event id and plant a
    // conflicting row that makes the LAST write blow up — after wallet, ledger
    // and transaction were already inserted.
    const useCase = await buildUseCase(sequentialIds());

    await dbRun(
      `insert into "outbox_messages"
         (id, aggregate_id, event_type, payload, occurred_at, attempts)
       values ('${EVENT_ID}', 'planted', 'Planted', '{}'::jsonb, now(), 0)`,
    );

    // The 23505 on the outbox row is caught, the read-back finds no wallet
    // (the transaction rolled back) and the use case fails loud instead of
    // pretending the wallet already existed.
    await expect(
      useCase.execute({
        playerId: 'atomic',
        currency: CurrencyCode.BRL,
        initialAmount: '10.00',
      }),
    ).rejects.toThrow(/unique violation/);

    expect(await count('wallets')).toBe(0);
    expect(await count('wallet_ledger_entries')).toBe(0);
    expect(await count('wager_transactions')).toBe(0);
    expect(await count('outbox_messages')).toBe(1); // only the planted row
  });
});
