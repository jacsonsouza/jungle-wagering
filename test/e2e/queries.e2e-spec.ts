import { randomUUID } from 'node:crypto';
import { WagerTransactionStatus } from '../../src/domain/index.js';
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
    const body = ledger.body as {
      entries: unknown[];
      nextCursor: string | null;
    };

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
