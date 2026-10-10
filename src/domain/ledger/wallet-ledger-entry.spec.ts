import { LedgerDirection } from '../shared/enums.js';
import { money, AT, ledgerEntry } from '../testing/factories.js';
import { WalletLedgerEntry } from './wallet-ledger-entry.js';

describe('WalletLedgerEntry.create', () => {
  it('accepts a balanced CREDIT', () => {
    const entry = ledgerEntry({
      direction: LedgerDirection.Credit,
      amount: '25.00',
      balanceBefore: '100.00',
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.props().balanceAfter.toString()).toBe('125.00');
  });

  it('accepts a balanced DEBIT', () => {
    const entry = ledgerEntry({
      direction: LedgerDirection.Debit,
      amount: '25.00',
      balanceBefore: '100.00',
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.props().balanceAfter.toString()).toBe('75.00');
  });

  it('rejects an entry off by one cent', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: money('25.00'),
        balanceBefore: money('100.00'),
        balanceAfter: money('74.99'),
        createdAt: AT,
      }),
    ).toThrow('balanceBefore ± money must equal balanceAfter');
  });

  it('rejects a zero amount', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Credit,
        money: money('0.00'),
        balanceBefore: money('100.00'),
        balanceAfter: money('100.00'),
        createdAt: AT,
      }),
    ).toThrow('ledger amount must be positive');
  });

  it('rejects mismatched currencies (fail-loud, not silent)', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Credit,
        money: money('25.00', 'USD'),
        balanceBefore: money('100.00', 'BRL'),
        balanceAfter: money('125.00', 'BRL'),
        createdAt: AT,
      }),
    ).toThrow('money operations require the same currency');
  });

  it('carries a machine-readable failure code', () => {
    try {
      WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Credit,
        money: money('0.00'),
        balanceBefore: money('100.00'),
        balanceAfter: money('100.00'),
        createdAt: AT,
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_LEDGER_ENTRY' });
    }
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  it('validates the same invariant on persisted data', () => {
    expect(() =>
      WalletLedgerEntry.rehydrate({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: money('25.00'),
        balanceBefore: money('100.00'),
        balanceAfter: money('100.00'), // corrupted
        createdAt: AT,
      }),
    ).toThrow('balanceBefore ± money must equal balanceAfter');
  });

  it('rebuilds a valid entry', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Credit,
      money: money('25.00'),
      balanceBefore: money('100.00'),
      balanceAfter: money('125.00'),
      createdAt: AT,
    });

    expect(entry.props().transactionId).toBe('tx-1');
  });
});

describe('WalletLedgerEntry immutability', () => {
  it('is frozen and copies the timestamp', () => {
    const createdAt = new Date(AT);
    const entry = ledgerEntry({ createdAt });

    expect(Object.isFrozen(entry)).toBe(true);

    createdAt.setUTCFullYear(1999);
    expect(entry.props().createdAt.toISOString()).toBe(AT.toISOString());
  });
});
