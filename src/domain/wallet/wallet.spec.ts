import { LedgerDirection } from '../shared/enums.js';
import { FailureCode } from '../failures/failure-code.js';
import { AT, LATER, money, openWallet } from '../testing/factories.js';
import { Wallet } from './wallet.js';

describe('Wallet.open', () => {
  it('starts at version 1 with the initial balance', () => {
    const wallet = openWallet({ initialBalance: '100.00' });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.playerId).toBe('player-1');
  });

  it('takes the currency from the initial balance', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('10.00', 'USD'),
      openedAt: AT,
    });

    expect(wallet.currency).toBe('USD');
  });
});

describe('Wallet movements', () => {
  it('credits and returns a balanced ledger entry', () => {
    const wallet = openWallet({ initialBalance: '100.00' });

    const entry = wallet.credit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: money('25.00'),
      at: LATER,
    });

    expect(wallet.balance.toString()).toBe('125.00');
    expect(wallet.version).toBe(2);
    expect(entry.props().direction).toBe(LedgerDirection.Credit);
    expect(entry.props().balanceBefore.toString()).toBe('100.00');
    expect(entry.props().balanceAfter.toString()).toBe('125.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('debits and returns a balanced ledger entry', () => {
    const wallet = openWallet({ initialBalance: '100.00' });

    const entry = wallet.debit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: money('30.00'),
      at: LATER,
    });

    expect(wallet.balance.toString()).toBe('70.00');
    expect(entry.props().direction).toBe(LedgerDirection.Debit);
    expect(entry.props().balanceAfter.toString()).toBe('70.00');
  });

  it('allows debiting the exact balance (never negative)', () => {
    const wallet = openWallet({ initialBalance: '100.00' });

    wallet.debit({
      entryId: 'e1',
      transactionId: 'tx-1',
      money: money('100.00'),
      at: LATER,
    });

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.balance.isNegative()).toBe(false);
  });

  it('rejects an overdraft without mutating anything (regression)', () => {
    const wallet = openWallet({ initialBalance: '80.00' });

    expect(() =>
      wallet.debit({
        entryId: 'e1',
        transactionId: 'tx-1',
        money: money('100.00'),
        at: LATER,
      }),
    ).toThrow('wallet balance would become negative');

    expect(wallet.balance.toString()).toBe('80.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt.toISOString()).toBe(AT.toISOString());
  });

  it('reports INSUFFICIENT_FUNDS for bets and REVERSAL_INSUFFICIENT_FUNDS for reversals (§7.9)', () => {
    const wallet = openWallet({ initialBalance: '10.00' });

    try {
      wallet.debit({
        entryId: 'e1',
        transactionId: 'tx-1',
        money: money('50.00'),
        at: LATER,
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ code: FailureCode.InsufficientFunds });
    }

    try {
      wallet.debit({
        entryId: 'e2',
        transactionId: 'tx-2',
        money: money('50.00'),
        at: LATER,
        insufficientFundsCode: FailureCode.ReversalInsufficientFunds,
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({
        code: FailureCode.ReversalInsufficientFunds,
      });
    }
  });

  it('rejects a movement in a different currency', () => {
    const wallet = openWallet({ initialBalance: '100.00' });

    expect(() =>
      wallet.credit({
        entryId: 'e1',
        transactionId: 'tx-1',
        money: money('10.00', 'USD'),
        at: LATER,
      }),
    ).toThrow('movement currency differs from wallet currency');

    expect(wallet.version).toBe(1);
  });

  it('rejects a zero or negative amount', () => {
    const wallet = openWallet({ initialBalance: '100.00' });

    expect(() =>
      wallet.debit({
        entryId: 'e1',
        transactionId: 'tx-1',
        money: money('0.00'),
        at: LATER,
      }),
    ).toThrow('movement amount must be positive');
  });

  it('is deterministic: same inputs produce the same entry', () => {
    const props = {
      entryId: 'e1',
      transactionId: 'tx-1',
      money: money('10.00'),
      at: LATER,
    };

    const first = openWallet({ initialBalance: '50.00' }).debit({ ...props });
    const second = openWallet({ initialBalance: '50.00' }).debit({ ...props });

    expect(first.props().balanceAfter.toString()).toBe(
      second.props().balanceAfter.toString(),
    );
  });
});

describe('Wallet.rehydrate', () => {
  it('rebuilds the persisted state', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: { amount: '975.00', currency: 'BRL' },
      version: 7,
      createdAt: AT,
      updatedAt: LATER,
    });

    expect(wallet.balance.toString()).toBe('975.00');
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt.toISOString()).toBe(LATER.toISOString());
  });

  it('rejects a balance whose currency differs from the wallet', () => {
    expect(() =>
      Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: { amount: '10.00', currency: 'USD' },
        version: 1,
        createdAt: AT,
        updatedAt: AT,
      }),
    ).toThrow('persisted balance currency differs from wallet currency');
  });

  it.each([0, -1, 1.5])('rejects invalid persisted version %s', (version) => {
    expect(() =>
      Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: { amount: '10.00', currency: 'BRL' },
        version,
        createdAt: AT,
        updatedAt: AT,
      }),
    ).toThrow('persisted version must be an integer >= 1');
  });

  it('exposes a defensive copy of updatedAt', () => {
    const wallet = openWallet();
    wallet.updatedAt.setUTCFullYear(1999);

    expect(wallet.updatedAt.toISOString()).toBe(AT.toISOString());
  });
});
