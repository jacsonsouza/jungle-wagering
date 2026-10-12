import { randomUUID } from 'node:crypto';
import {
  CurrencyCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/index.js';
import {
  bootApp,
  closeApp,
  errorCode,
  givenWallet,
  http,
  resetDatabase,
  submission,
} from './harness.js';

beforeAll(bootApp);
afterAll(closeApp);
beforeEach(resetDatabase);

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
