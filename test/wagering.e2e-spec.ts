import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import {
  CurrencyCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../src/domain/index.js';
import { closeTestOrm, truncateAllTables } from './setup/orm.js';

/**
 * The HTTP contract, through the whole Nest stack.
 *
 * The integration suite calls use cases directly and proves the database is
 * right. This file proves the opposite half: that everything between a request
 * and a use case behaves — the `ValidationPipe`, the global exception filter,
 * the no-op auth guard, the presenters, and above all the §9 status mapping,
 * which exists so a provider never has to parse error text to decide whether
 * resending is safe.
 *
 * Real PostgreSQL via `AppModule`; nothing in the stack is replaced.
 */

let app: INestApplication<App>;

beforeAll(async () => {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleFixture.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
  await closeTestOrm();
});

beforeEach(async () => {
  await truncateAllTables();
});

// ---- helpers ----------------------------------------------------------------

function http() {
  return request(app.getHttpServer());
}

interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: { readonly amount: string; readonly currency: string };
  readonly version: number;
}

async function givenWallet(initialAmount = '100.00'): Promise<WalletView> {
  const response = await http()
    .post('/wallets')
    .send({
      playerId: randomUUID(),
      initialBalance: { amount: initialAmount, currency: CurrencyCode.BRL },
    })
    .expect(201);

  return response.body as WalletView;
}

/** §9's recommended default, so a test only overrides what it is about. */
function submission(wallet: WalletView, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: CurrencyCode.BRL },
    ...overrides,
  };
}

function errorCode(response: request.Response): unknown {
  return (response.body as { error: { code: string } }).error.code;
}

// ---- health and metrics -----------------------------------------------------

describe('Operational endpoints', () => {
  it('answers liveness without touching the network', async () => {
    const response = await http().get('/health/live').expect(200);

    expect(response.body).toMatchObject({ status: 'ok' });
  });

  it('reports readiness of every dependency', async () => {
    const response = await http().get('/health/ready').expect(200);

    expect(response.body).toMatchObject({ status: 'ok' });
    expect(
      (response.body as { dependencies: unknown[] }).dependencies.length,
    ).toBeGreaterThan(0);
  });

  it('exposes Prometheus in the format a scraper expects', async () => {
    // prom-client registers a series on its FIRST observation, so an empty
    // registry would say nothing about whether the metrics work.
    const wallet = await givenWallet();
    await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:for-metrics')
      .send(submission(wallet, { externalTransactionId: 'for-metrics' }))
      .expect(200);

    const response = await http()
      .get('/metrics')
      .expect(200)
      .expect('Content-Type', /text\/plain/);

    // §12's headline series, with the low-cardinality label.
    expect(response.text).toContain('transactions_total{status="PROCESSED"}');
    expect(response.text).toContain('wallet_lock_wait_seconds');
  });
});

// ---- wallets ----------------------------------------------------------------

describe('POST /wallets', () => {
  it('creates a wallet born funded, at version 1', async () => {
    const wallet = await givenWallet('1000.00');

    expect(wallet).toMatchObject({
      playerId: expect.any(String),
      balance: { amount: '1000.00', currency: 'BRL' },
      // §9 returns version 1 for a wallet created with an initial balance.
      version: 1,
    });
    expect(wallet.id).toEqual(expect.any(String));
  });

  it('answers a second wallet for the same player and currency as a conflict', async () => {
    const wallet = await givenWallet();

    const response = await http()
      .post('/wallets')
      .send({
        playerId: wallet.playerId,
        initialBalance: { amount: '1.00', currency: CurrencyCode.BRL },
      })
      .expect(409);

    expect(errorCode(response)).toBe('WALLET_ALREADY_EXISTS');
  });

  it('rejects an amount sent as a JSON number instead of a decimal string', async () => {
    // `25.10` arrives as `25.1` in binary floating point before validation sees it.
    const response = await http()
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: { amount: 100, currency: CurrencyCode.BRL },
      })
      .expect(400);

    expect(response.body).toHaveProperty('message');
  });

  it('rejects a body carrying fields the contract does not define', async () => {
    const response = await http()
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: { amount: '10.00', currency: CurrencyCode.BRL },
        nickname: 'cheating-ape',
      })
      .expect(400);

    expect(response.body).toHaveProperty('message');
  });
});

// ---- submitting a transaction ----------------------------------------------

describe('POST /wagering/transactions', () => {
  it('requires the Idempotency-Key header', async () => {
    const wallet = await givenWallet();

    const response = await http()
      .post('/wagering/transactions')
      .send(submission(wallet))
      .expect(400);

    expect(errorCode(response)).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('applies a bet and returns the resulting balance', async () => {
    const wallet = await givenWallet();

    const response = await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:bet-1')
      .send(submission(wallet, { externalTransactionId: 'bet-1' }))
      .expect(200);

    expect(response.body).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    // A processed transaction carries no failureCode, and the field is
    // omitted rather than sent as null.
    expect(response.body).not.toHaveProperty('failureCode');
  });

  it('replays the identical submission with the balance observed then', async () => {
    const wallet = await givenWallet();

    const first = await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:bet-2')
      .send(submission(wallet, { externalTransactionId: 'bet-2' }))
      .expect(200);

    const replay = await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:bet-2')
      .send(submission(wallet, { externalTransactionId: 'bet-2' }))
      .expect(200);

    expect(replay.body).toMatchObject({
      transactionId: (first.body as { transactionId: string }).transactionId,
      idempotentReplay: true,
      balance: { amount: '75.00', currency: 'BRL' },
    });
  });

  it('answers the same key with a divergent payload as a conflict, not a replay', async () => {
    const wallet = await givenWallet();

    await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:bet-3')
      .send(submission(wallet, { externalTransactionId: 'bet-3' }))
      .expect(200);

    const response = await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:bet-3')
      .send(
        submission(wallet, {
          externalTransactionId: 'bet-3',
          kind: WagerTransactionKind.Win,
        }),
      )
      .expect(409);

    expect(errorCode(response)).toBe('PAYLOAD_MISMATCH');
  });

  it('rejects an unaffordable bet with a failureCode the provider can act on', async () => {
    const wallet = await givenWallet('10.00');

    const response = await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:too-much')
      .send(
        submission(wallet, {
          externalTransactionId: 'too-much',
          money: { amount: '25.00', currency: CurrencyCode.BRL },
        }),
      )
      .expect(422);

    expect(response.body).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });

  it('accepts a refund whose reference has not arrived yet', async () => {
    const wallet = await givenWallet();

    const response = await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:refund-early')
      .send(
        submission(wallet, {
          externalTransactionId: 'refund-early',
          kind: WagerTransactionKind.Refund,
          money: { amount: '5.00', currency: CurrencyCode.BRL },
          referenceExternalTransactionId: 'a-bet-that-has-not-landed',
        }),
      )
      .expect(202);

    expect(response.body).toMatchObject({
      status: WagerTransactionStatus.PendingReference,
    });
  });

  it('hides a wallet that belongs to another player behind the same answer as a missing one', async () => {
    const mine = await givenWallet();
    const theirs = await givenWallet();

    // §8's anti-probing property: an id owned by someone else must be
    // indistinguishable from an id that does not exist. Both answer 404 with
    // the SAME code — a distinct "not yours" code would let an attacker walk
    // wallet ids and learn which ones are real.
    const foreign = await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:not-yours')
      .send(submission(mine, { walletId: theirs.id, playerId: mine.playerId }))
      .expect(404);

    const missing = await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:no-such-wallet')
      .send(
        submission(mine, {
          walletId: randomUUID(),
          playerId: mine.playerId,
        }),
      )
      .expect(404);

    expect(errorCode(foreign)).toBe('WALLET_SCOPE_MISMATCH');
    expect(errorCode(missing)).toBe('WALLET_SCOPE_MISMATCH');
  });
});

// ---- queries ----------------------------------------------------------------

describe('Queries', () => {
  it('reads a wallet and its ledger', async () => {
    const wallet = await givenWallet();

    await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:for-the-ledger')
      .send(submission(wallet, { externalTransactionId: 'for-the-ledger' }))
      .expect(200);

    const stored = await http().get(`/wallets/${wallet.id}`).expect(200);
    expect(stored.body).toMatchObject({ balance: { amount: '75.00' } });

    const ledger = await http().get(`/wallets/${wallet.id}/ledger`).expect(200);
    const body = ledger.body as { entries: unknown[]; nextCursor: string | null };

    // The opening credit plus the debit.
    expect(body.entries).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
  });

  it('refuses a cursor the endpoint did not mint instead of silently returning page one', async () => {
    const wallet = await givenWallet();

    const response = await http()
      .get(`/wallets/${wallet.id}/ledger?cursor=not-a-real-cursor`)
      .expect(400);

    expect(errorCode(response)).toBe('INVALID_CURSOR');
  });

  it('reads a transaction by id and by provider reference', async () => {
    const wallet = await givenWallet();

    const submitted = await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:findable')
      .send(submission(wallet, { externalTransactionId: 'findable' }))
      .expect(200);

    const { transactionId } = submitted.body as { transactionId: string };

    const byId = await http()
      .get(`/wagering/transactions/${transactionId}`)
      .expect(200);
    expect(byId.body).toMatchObject({
      transactionId,
      status: WagerTransactionStatus.Processed,
    });

    const byReference = await http()
      .get('/providers/provider-a/wagering/transactions/findable')
      .expect(200);
    expect(byReference.body).toMatchObject({ transactionId });
  });

  it('answers 404 for a transaction nobody created', async () => {
    await http().get(`/wagering/transactions/${randomUUID()}`).expect(404);
  });

  it('reports a wallet as consistent once the ledger matches it', async () => {
    const wallet = await givenWallet();

    await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:reconcile-me')
      .send(submission(wallet, { externalTransactionId: 'reconcile-me' }))
      .expect(200);

    const response = await http()
      .post(`/wallets/${wallet.id}/reconciliation`)
      .expect(200);

    expect(response.body).toMatchObject({
      walletId: wallet.id,
      storedBalance: { amount: '75.00' },
      calculatedBalance: { amount: '75.00' },
      difference: { amount: '0.00' },
      consistent: true,
      checkedEntries: 2,
    });
  });
});
