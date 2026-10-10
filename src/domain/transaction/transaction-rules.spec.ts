import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../shared/enums.js';
import {
  AFFECTS_BALANCE,
  BASE_DIRECTION,
  directionFor,
  isInternalKind,
  ROLLBACKABLE_KINDS,
  REFUNDABLE_KINDS,
  requiresReferenceFor,
} from './transaction-rules.js';

describe('transaction rules', () => {
  it('flags internal kinds', () => {
    expect(isInternalKind(WagerTransactionKind.Opening)).toBe(true);
    expect(isInternalKind(WagerTransactionKind.Bet)).toBe(false);
  });

  it('requires a reference only for reversals', () => {
    expect(requiresReferenceFor(WagerTransactionKind.Refund)).toBe(true);
    expect(requiresReferenceFor(WagerTransactionKind.Rollback)).toBe(true);
    expect(requiresReferenceFor(WagerTransactionKind.Bet)).toBe(false);
    expect(requiresReferenceFor(WagerTransactionKind.Win)).toBe(false);
    expect(requiresReferenceFor(WagerTransactionKind.Loss)).toBe(false);
  });

  it('keeps LOSS as the only kind without balance effect', () => {
    expect(AFFECTS_BALANCE[WagerTransactionKind.Loss]).toBe(false);
    expect(
      Object.entries(AFFECTS_BALANCE)
        .filter(([, affects]) => affects)
        .map(([kind]) => kind)
        .sort(),
    ).toEqual(['BET', 'OPENING', 'REFUND', 'ROLLBACK', 'WIN']);
  });

  it('allows REFUND only over BET and ROLLBACK over BET/WIN/REFUND', () => {
    expect(REFUNDABLE_KINDS).toEqual([WagerTransactionKind.Bet]);
    expect(ROLLBACKABLE_KINDS).toEqual([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
    ]);
  });
});

describe('directionFor', () => {
  it('returns null while the transaction is not PROCESSED', () => {
    expect(
      directionFor(WagerTransactionKind.Bet, WagerTransactionStatus.Pending),
    ).toBeNull();
    expect(
      directionFor(WagerTransactionKind.Bet, WagerTransactionStatus.Rejected),
    ).toBeNull();
    expect(
      directionFor(WagerTransactionKind.Bet, WagerTransactionStatus.Failed),
    ).toBeNull();
  });

  it('returns null for LOSS even when processed', () => {
    expect(
      directionFor(WagerTransactionKind.Loss, WagerTransactionStatus.Processed),
    ).toBeNull();
  });

  it.each([
    [WagerTransactionKind.Opening, 'CREDIT'],
    [WagerTransactionKind.Bet, 'DEBIT'],
    [WagerTransactionKind.Win, 'CREDIT'],
    [WagerTransactionKind.Refund, 'CREDIT'],
  ] as const)('%s maps to %s', (kind, expected) => {
    expect(directionFor(kind, WagerTransactionStatus.Processed)).toBe(expected);
    expect(BASE_DIRECTION[kind]).toBe(expected);
  });

  it('inverts the reference direction for ROLLBACK', () => {
    const processed = WagerTransactionStatus.Processed;

    expect(
      directionFor(WagerTransactionKind.Rollback, processed, {
        kind: WagerTransactionKind.Bet,
        status: processed,
      }),
    ).toBe('CREDIT'); // inverts the BET's DEBIT

    expect(
      directionFor(WagerTransactionKind.Rollback, processed, {
        kind: WagerTransactionKind.Win,
        status: processed,
      }),
    ).toBe('DEBIT'); // inverts the WIN's CREDIT

    expect(
      directionFor(WagerTransactionKind.Rollback, processed, {
        kind: WagerTransactionKind.Refund,
        status: processed,
      }),
    ).toBe('DEBIT'); // inverts the REFUND's CREDIT
  });

  it('throws when ROLLBACK has no reference to invert', () => {
    expect(() =>
      directionFor(
        WagerTransactionKind.Rollback,
        WagerTransactionStatus.Processed,
      ),
    ).toThrow('ROLLBACK direction requires a resolved reference');
  });

  it('throws when the reference has no direction (e.g. LOSS)', () => {
    expect(() =>
      directionFor(
        WagerTransactionKind.Rollback,
        WagerTransactionStatus.Processed,
        {
          kind: WagerTransactionKind.Loss,
          status: WagerTransactionStatus.Processed,
        },
      ),
    ).toThrow('ROLLBACK reference has no ledger direction to invert');
  });
});
