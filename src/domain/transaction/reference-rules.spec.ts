import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../shared/enums.js';
import { assertReferenceIsValid } from './reference-rules.js';

const scope = {
  providerId: 'provider-a',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  amount: '25.00',
  currency: 'BRL',
};

const incoming = {
  ...scope,
  kind: WagerTransactionKind.Refund,
};

const reference = {
  ...scope,
  kind: WagerTransactionKind.Bet,
  status: WagerTransactionStatus.Processed,
};

describe('assertReferenceIsValid', () => {
  it('accepts a REFUND over a PROCESSED BET of the same scope and value', () => {
    expect(() => assertReferenceIsValid({ incoming, reference })).not.toThrow();
  });

  it('accepts a ROLLBACK over BET, WIN and REFUND', () => {
    for (const kind of [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
    ]) {
      expect(() =>
        assertReferenceIsValid({
          incoming: { ...incoming, kind: WagerTransactionKind.Rollback },
          reference: { ...reference, kind },
        }),
      ).not.toThrow();
    }
  });

  it.each(['providerId', 'playerId', 'walletId', 'roundId'] as const)(
    'rejects a reference from a different %s',
    (field) => {
      expect(() =>
        assertReferenceIsValid({
          incoming,
          reference: { ...reference, [field]: 'other' },
        }),
      ).toThrow('reference must belong to the same scope');
    },
  );

  it('rejects a different currency', () => {
    expect(() =>
      assertReferenceIsValid({
        incoming,
        reference: { ...reference, currency: 'USD' },
      }),
    ).toThrow('reference must share the same currency');
  });

  it.each([
    WagerTransactionStatus.Pending,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ])('rejects a reference that is %s', (status) => {
    expect(() =>
      assertReferenceIsValid({ incoming, reference: { ...reference, status } }),
    ).toThrow('only PROCESSED transactions can be referenced');
  });

  it('rejects REFUND over WIN (only BET is refundable)', () => {
    expect(() =>
      assertReferenceIsValid({
        incoming,
        reference: { ...reference, kind: WagerTransactionKind.Win },
      }),
    ).toThrow('reference kind is not allowed for this operation');
  });

  it('rejects ROLLBACK over LOSS', () => {
    expect(() =>
      assertReferenceIsValid({
        incoming: { ...incoming, kind: WagerTransactionKind.Rollback },
        reference: { ...reference, kind: WagerTransactionKind.Loss },
      }),
    ).toThrow('reference kind is not allowed for this operation');
  });

  it('rejects a reversal whose value differs from the reference (§7.5)', () => {
    expect(() =>
      assertReferenceIsValid({
        incoming: { ...incoming, amount: '10.00' },
        reference,
      }),
    ).toThrow('reversal value must equal the referenced value');
  });

  it('exposes machine-readable failure codes', () => {
    try {
      assertReferenceIsValid({
        incoming: { ...incoming, amount: '10.00' },
        reference,
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ code: 'REFERENCE_VALUE_MISMATCH' });
    }
  });
});
