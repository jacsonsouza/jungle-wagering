import {
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../shared/enums.js';
import { payloadHash } from '../shared/payload-hash.js';
import { AT, LATER, money, wagerTransaction } from '../testing/factories.js';
import { ALLOWED_TRANSITIONS, canTransition } from './transaction-table.js';
import { WagerTransaction } from './wager-transaction.js';

const ALL = Object.values(WagerTransactionStatus);

const ALLOWED_PAIRS: ReadonlyArray<
  [WagerTransactionStatus, WagerTransactionStatus]
> = [
  ['PENDING', 'PROCESSED'],
  ['PENDING', 'REJECTED'],
  ['PENDING', 'FAILED'],
  ['PENDING', 'PENDING_REFERENCE'],
  ['PENDING_REFERENCE', 'PROCESSED'],
  ['PENDING_REFERENCE', 'REJECTED'],
  ['PENDING_REFERENCE', 'FAILED'],
];

describe('transition table', () => {
  it.each(ALLOWED_PAIRS)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('rejects every pair that is not in the allowed list', () => {
    const denied = ALL.flatMap((from) =>
      ALL.filter(
        (to) => !ALLOWED_PAIRS.some(([f, t]) => f === from && t === to),
      ).map((to) => [from, to] as const),
    );

    expect(denied).toHaveLength(25 - 7);

    for (const [from, to] of denied) {
      expect(canTransition(from, to), `${from} => ${to} must be denied`).toBe(
        false,
      );
    }
  });

  it.each([
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ])('%s is terminal', (status) => {
    expect(ALLOWED_TRANSITIONS[status]).toEqual([]);
  });
});

describe('WagerTransaction.create', () => {
  it('is born PENDING', () => {
    const transaction = wagerTransaction();

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.isTerminal()).toBe(false);
  });

  it('rejects the internal OPENING kind', () => {
    expect(() =>
      wagerTransaction({ kind: WagerTransactionKind.Opening }),
    ).toThrow('OPENING is internal and cannot be submitted');
  });

  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    '%s requires a referenceExternalTransactionId',
    (kind) => {
      expect(() => wagerTransaction({ kind })).toThrow(
        `${kind} requires a referenceExternalTransactionId`,
      );
    },
  );

  it('accepts BET and WIN without a reference', () => {
    expect(() =>
      wagerTransaction({ kind: WagerTransactionKind.Bet }),
    ).not.toThrow();
    expect(() =>
      wagerTransaction({ kind: WagerTransactionKind.Win }),
    ).not.toThrow();
  });
});

describe('WagerTransaction payload hashing', () => {
  it('signs only the business subset (no idempotencyKey, no transport metadata)', () => {
    const transaction = wagerTransaction();

    expect(
      transaction.matchesPayload(
        payloadHash({
          providerId: 'provider-a',
          externalTransactionId: 'ext-1',
          playerId: 'player-1',
          walletId: 'wallet-1',
          roundId: 'round-1',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        }),
      ),
    ).toBe(true);
  });

  it('diverges when the payload diverges (same key, different body = conflict, not replay)', () => {
    const transaction = wagerTransaction();

    expect(
      transaction.matchesPayload(payloadHash({ providerId: 'provider-a' })),
    ).toBe(false);
  });

  it('rehydrate keeps the signed hash instead of recomputing it', () => {
    const transaction = wagerTransaction();
    const state = {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: 'signed-at-creation',
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.props(),
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId,
      status: WagerTransactionStatus.Pending,
      createdAt: AT,
    };

    expect(WagerTransaction.rehydrate(state).payloadHash).toBe(
      'signed-at-creation',
    );
  });

  it('rehydrates the persisted transition timestamps', () => {
    const processed = wagerTransaction();
    processed.markProcessed('tx-ref', LATER);

    const rebuilt = WagerTransaction.rehydrate({
      id: processed.id,
      providerId: processed.providerId,
      externalTransactionId: processed.externalTransactionId,
      idempotencyKey: processed.idempotencyKey,
      payloadHash: processed.payloadHash,
      walletId: processed.walletId,
      playerId: processed.playerId,
      roundId: processed.roundId,
      gameId: processed.gameId,
      kind: processed.kind,
      money: processed.money.props(),
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: 'tx-ref',
      processedAt: LATER,
      createdAt: AT,
    });

    expect(rebuilt.processedAt?.toISOString()).toBe(LATER.toISOString());
    expect(rebuilt.referenceTransactionId).toBe('tx-ref');
  });
});

describe('WagerTransaction transitions', () => {
  it('processes from PENDING and stores the reference', () => {
    const transaction = wagerTransaction();
    transaction.markProcessed('tx-ref', LATER);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe('tx-ref');
    expect(transaction.processedAt?.toISOString()).toBe(LATER.toISOString());
    expect(transaction.isTerminal()).toBe(true);
  });

  it('processes from PENDING_REFERENCE (out-of-order resolution)', () => {
    const transaction = wagerTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-9',
    });
    transaction.markPendingReference(AT);
    transaction.markProcessed('tx-ref', LATER);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  });

  it('records the failure code on reject and fail (regression)', () => {
    const rejected = wagerTransaction();
    rejected.reject('INSUFFICIENT_FUNDS', LATER);
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');

    const failed = wagerTransaction();
    failed.fail('MAX_RETRIES_EXCEEDED', LATER);
    expect(failed.failureCode).toBe('MAX_RETRIES_EXCEEDED');
  });

  it('throws with from/to details on an invalid transition', () => {
    const transaction = wagerTransaction();
    transaction.markProcessed(undefined, LATER);

    expect(() => transaction.markProcessed(undefined, LATER)).toThrow(
      'transaction status cannot move to the target status',
    );

    try {
      transaction.reject('INSUFFICIENT_FUNDS', LATER);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        details: { from: 'PROCESSED', to: 'REJECTED' },
      });
    }
  });

  it('never transitions out of a terminal state', () => {
    for (const finish of ['REJECTED', 'FAILED'] as const) {
      const transaction = wagerTransaction();
      if (finish === 'REJECTED')
        transaction.reject('INSUFFICIENT_FUNDS', LATER);
      else transaction.fail('MAX_RETRIES_EXCEEDED', LATER);

      expect(() => transaction.markProcessed(undefined, LATER)).toThrow(
        'transaction status cannot move to the target status',
      );
    }
  });
});

describe('WagerTransaction domain queries', () => {
  it('affects balance only when processed and not LOSS', () => {
    const bet = wagerTransaction();
    expect(bet.affectsBalance()).toBe(false); // still PENDING

    bet.markProcessed(undefined, LATER);
    expect(bet.affectsBalance()).toBe(true);

    const loss = wagerTransaction({ kind: WagerTransactionKind.Loss });
    loss.markProcessed(undefined, LATER);
    expect(loss.affectsBalance()).toBe(false);

    const rejected = wagerTransaction();
    rejected.reject('INSUFFICIENT_FUNDS', LATER);
    expect(rejected.affectsBalance()).toBe(false);
  });

  it('requires a reference only for reversals', () => {
    expect(
      wagerTransaction({ kind: WagerTransactionKind.Bet }).requiresReference(),
    ).toBe(false);
    expect(
      wagerTransaction({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-9',
      }).requiresReference(),
    ).toBe(true);
    expect(
      wagerTransaction({
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'ext-9',
      }).requiresReference(),
    ).toBe(true);
  });

  it('derives the ledger direction per kind and status', () => {
    const cases: ReadonlyArray<[WagerTransactionKind, LedgerDirection | null]> =
      [
        [WagerTransactionKind.Bet, LedgerDirection.Debit],
        [WagerTransactionKind.Win, LedgerDirection.Credit],
        [WagerTransactionKind.Refund, LedgerDirection.Credit],
        [WagerTransactionKind.Loss, null],
      ];

    for (const [kind, direction] of cases) {
      const transaction = wagerTransaction({
        kind,
        ...(kind === WagerTransactionKind.Refund
          ? { referenceExternalTransactionId: 'ext-9' }
          : {}),
      });
      expect(transaction.ledgerDirectionFor()).toBeNull(); // PENDING
      transaction.markProcessed(undefined, LATER);
      expect(transaction.ledgerDirectionFor()).toBe(direction);
    }
  });

  it('inverts the reference direction for ROLLBACK', () => {
    const rollback = wagerTransaction({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-9',
    });
    rollback.markProcessed(undefined, LATER);

    expect(
      rollback.ledgerDirectionFor({
        kind: WagerTransactionKind.Bet,
        status: WagerTransactionStatus.Processed,
      }),
    ).toBe(LedgerDirection.Credit);
    expect(
      rollback.ledgerDirectionFor({
        kind: WagerTransactionKind.Win,
        status: WagerTransactionStatus.Processed,
      }),
    ).toBe(LedgerDirection.Debit);
  });
});

describe('determinism', () => {
  it('produces the same payloadHash for identical inputs', () => {
    expect(wagerTransaction().payloadHash).toBe(wagerTransaction().payloadHash);
    expect(wagerTransaction({ amount: '26.00' }).payloadHash).not.toBe(
      wagerTransaction().payloadHash,
    );
  });

  it('copies createdAt so external mutation cannot corrupt the record', () => {
    const createdAt = new Date(AT);
    const transaction = WagerTransaction.create({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'provider-a:ext-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: money('25.00'),
      createdAt,
    });

    createdAt.setUTCFullYear(1999);

    expect(transaction.createdAt.toISOString()).toBe(AT.toISOString());
  });
});
