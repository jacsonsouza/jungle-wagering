import { randomUUID } from 'node:crypto';
import { CurrencyCode } from '../../src/domain/index.js';
import {
  bootApp,
  closeApp,
  errorCode,
  givenWallet,
  http,
  resetDatabase,
} from './harness.js';

beforeAll(bootApp);
afterAll(closeApp);
beforeEach(resetDatabase);

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
