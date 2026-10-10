import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../shared/enums.js';
import type { IntegrationEventEnvelope } from './integration-event.js';
import { WagerTransaction } from '../transaction/wager-transaction.js';
import {
  AT,
  CTX,
  LATER,
  ledgerEntry,
  money,
  openWallet,
  wagerTransaction,
} from '../testing/factories.js';
import { WalletBalanceChanged } from './wallet-balance-changed.event.js';
import { WagerTransactionProcessed } from './wager-transaction-processed.event.js';
import { WagerTransactionRejected } from './wager-transaction-rejected.event.js';
import { WagerTransactionPendingReference } from './wager-transaction-pending-reference.event.js';
import {
  clearIntegrationEventRegistry,
  registerIntegrationEvent,
  resolveIntegrationEvent,
} from './event-registry.js';

function buildWalletBalanceChanged() {
  return WalletBalanceChanged.from({
    eventId: 'event-1',
    wallet: openWallet({ initialBalance: '100.00' }),
    entry: ledgerEntry({ balanceBefore: '100.00' }),
    ctx: CTX,
  });
}

function buildProcessed() {
  const transaction = wagerTransaction({ kind: WagerTransactionKind.Loss });
  transaction.markProcessed(undefined, LATER);
  return WagerTransactionProcessed.from({
    eventId: 'event-1',
    transaction,
    ctx: CTX,
  });
}

function buildRejected() {
  const transaction = wagerTransaction();
  transaction.reject('INSUFFICIENT_FUNDS', LATER);
  return WagerTransactionRejected.from({
    eventId: 'event-1',
    transaction,
    ctx: CTX,
  });
}

function buildPendingReference() {
  const transaction = wagerTransaction({
    kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: 'ext-9',
  });
  transaction.markPendingReference(LATER);
  return WagerTransactionPendingReference.from({
    eventId: 'event-1',
    transaction,
    ctx: CTX,
  });
}

describe('event contracts', () => {
  it.each([
    ['WalletBalanceChanged', 1, buildWalletBalanceChanged],
    ['WagerTransactionProcessed', 1, buildProcessed],
    ['WagerTransactionRejected', 1, buildRejected],
    ['WagerTransactionPendingReference', 1, buildPendingReference],
  ] as const)(
    '%s keeps a stable eventType and version',
    (eventType, version, build) => {
      const event = build();

      expect(event.eventType).toBe(eventType);
      expect(event.version).toBe(version);
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.data)).toBe(true);
    },
  );

  it('serializes the envelope with ISO-8601 occurredAt', () => {
    const wallet = openWallet({ initialBalance: '100.00' });
    const entry = wallet.credit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: money('25.00'),
      at: LATER,
    });

    expect(
      WalletBalanceChanged.from({
        eventId: 'event-1',
        wallet,
        entry,
        ctx: CTX,
      }).toJSON(),
    ).toEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      occurredAt: LATER.toISOString(),
      version: 1,
      data: expect.objectContaining({
        walletId: 'wallet-1',
        walletVersion: 2, // credit already applied to the wallet
        balanceAfter: { amount: '125.00', currency: 'BRL' },
      }),
    });
  });

  it('makes causationId optional', () => {
    const event = WalletBalanceChanged.from({
      eventId: 'event-1',
      wallet: openWallet({ initialBalance: '100.00' }),
      entry: ledgerEntry(),
      ctx: { correlationId: 'corr-1' },
    });

    expect(event.toJSON().causationId).toBeUndefined();
  });
});

describe('WalletBalanceChanged', () => {
  it('converts Money instances into MoneyProps', () => {
    const data = JSON.parse(
      JSON.stringify(buildWalletBalanceChanged().toJSON().data),
    );

    expect(data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(data.balanceBefore).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(data.balanceAfter).toEqual({ amount: '125.00', currency: 'BRL' });
  });
});

describe('WagerTransactionProcessed', () => {
  it('carries the full business payload — even for LOSS, which has no ledger entry', () => {
    const event = buildProcessed();

    expect(event.aggregateId).toBe('tx-1');
    expect(event.occurredAt.toISOString()).toBe(LATER.toISOString());
    expect(event.data).toMatchObject({
      transactionId: 'tx-1',
      kind: 'LOSS',
      walletId: 'wallet-1',
      processedAt: LATER.toISOString(),
    });
  });
});

describe('WagerTransactionRejected', () => {
  it('carries the failure code', () => {
    expect(buildRejected().data).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS',
      rejectedAt: LATER.toISOString(),
    });
  });

  it('refuses to build from a transaction that is not REJECTED', () => {
    expect(() =>
      WagerTransactionRejected.from({
        eventId: 'event-1',
        transaction: wagerTransaction(),
        ctx: CTX,
      }),
    ).toThrow('rejected events require a REJECTED transaction');
  });
});

describe('WagerTransactionPendingReference', () => {
  it('is built only from a PENDING_REFERENCE transaction', () => {
    expect(buildPendingReference().data).toMatchObject({
      status: WagerTransactionStatus.PendingReference,
      referenceExternalTransactionId: 'ext-9',
      pendingSince: LATER.toISOString(),
    });
  });

  it('throws when the transaction is still PENDING', () => {
    expect(() =>
      WagerTransactionPendingReference.from({
        eventId: 'event-1',
        transaction: wagerTransaction({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'ext-9',
        }),
        ctx: CTX,
      }),
    ).toThrow(
      'pending reference events require a PENDING_REFERENCE transaction',
    );
  });
});

describe('event registry', () => {
  afterEach(() => clearIntegrationEventRegistry());

  it('resolves a registered factory and throws for unknown types', () => {
    registerIntegrationEvent(
      'WalletBalanceChanged',
      1,
      (envelope: IntegrationEventEnvelope) =>
        WalletBalanceChanged.fromEnvelope(envelope),
    );

    const envelope: IntegrationEventEnvelope =
      buildWalletBalanceChanged().toJSON();
    const rebuilt = resolveIntegrationEvent(
      'WalletBalanceChanged',
      1,
    )(envelope);

    expect(rebuilt.eventType).toBe('WalletBalanceChanged');
    expect(rebuilt.toJSON()).toEqual(envelope);
    expect(() => resolveIntegrationEvent('Unknown', 1)).toThrow(
      'no registered event for type and version',
    );
  });

  it('round-trips every concrete event through fromEnvelope', () => {
    const cases = [
      [
        buildWalletBalanceChanged(),
        (e: IntegrationEventEnvelope) => WalletBalanceChanged.fromEnvelope(e),
      ],
      [
        buildProcessed(),
        (e: IntegrationEventEnvelope) =>
          WagerTransactionProcessed.fromEnvelope(e),
      ],
      [
        buildRejected(),
        (e: IntegrationEventEnvelope) =>
          WagerTransactionRejected.fromEnvelope(e),
      ],
      [
        buildPendingReference(),
        (e: IntegrationEventEnvelope) =>
          WagerTransactionPendingReference.fromEnvelope(e),
      ],
    ] as const;

    for (const [event, fromEnvelope] of cases) {
      const rebuilt = fromEnvelope(event.toJSON());

      expect(rebuilt.eventType).toBe(event.eventType);
      expect(rebuilt.toJSON()).toEqual(event.toJSON());
    }
  });

  it('falls back to createdAt when the persisted transaction has no processedAt', () => {
    const transaction = wagerTransaction();
    transaction.markProcessed(undefined, LATER);

    const persistedWithoutTimestamp = WagerTransaction.rehydrate({
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.props(),
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId,
      status: WagerTransactionStatus.Processed,
      createdAt: AT,
    });

    expect(persistedWithoutTimestamp.processedAt).toBeUndefined();

    const event = WagerTransactionProcessed.from({
      eventId: 'event-1',
      transaction: persistedWithoutTimestamp,
      ctx: CTX,
    });

    expect(event.occurredAt.toISOString()).toBe(AT.toISOString());
    expect(event.data.processedAt).toBe(AT.toISOString());
  });

  it('refuses a rejected event whose persisted transaction lost the failureCode', () => {
    const rejected = wagerTransaction();
    rejected.reject('INSUFFICIENT_FUNDS', LATER);

    const corrupted = WagerTransaction.rehydrate({
      id: rejected.id,
      providerId: rejected.providerId,
      externalTransactionId: rejected.externalTransactionId,
      idempotencyKey: rejected.idempotencyKey,
      payloadHash: rejected.payloadHash,
      walletId: rejected.walletId,
      playerId: rejected.playerId,
      roundId: rejected.roundId,
      gameId: rejected.gameId,
      kind: rejected.kind,
      money: rejected.money.props(),
      status: WagerTransactionStatus.Rejected,
      createdAt: AT,
    });

    expect(() =>
      WagerTransactionRejected.from({
        eventId: 'event-1',
        transaction: corrupted,
        ctx: CTX,
      }),
    ).toThrow('rejected transactions must carry a failureCode');
  });

  it('falls back to createdAt for rejected and pending reference events too', () => {
    const rejected = wagerTransaction();
    rejected.reject('INSUFFICIENT_FUNDS', LATER);

    const persistedRejected = WagerTransaction.rehydrate({
      id: rejected.id,
      providerId: rejected.providerId,
      externalTransactionId: rejected.externalTransactionId,
      idempotencyKey: rejected.idempotencyKey,
      payloadHash: rejected.payloadHash,
      walletId: rejected.walletId,
      playerId: rejected.playerId,
      roundId: rejected.roundId,
      gameId: rejected.gameId,
      kind: rejected.kind,
      money: rejected.money.props(),
      status: WagerTransactionStatus.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS',
      createdAt: AT,
    });

    expect(
      WagerTransactionRejected.from({
        eventId: 'event-1',
        transaction: persistedRejected,
        ctx: CTX,
      }).occurredAt.toISOString(),
    ).toBe(AT.toISOString());

    const pendingRef = wagerTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-9',
    });
    pendingRef.markPendingReference(LATER);

    const persistedPendingRef = WagerTransaction.rehydrate({
      id: pendingRef.id,
      providerId: pendingRef.providerId,
      externalTransactionId: pendingRef.externalTransactionId,
      idempotencyKey: pendingRef.idempotencyKey,
      payloadHash: pendingRef.payloadHash,
      walletId: pendingRef.walletId,
      playerId: pendingRef.playerId,
      roundId: pendingRef.roundId,
      gameId: pendingRef.gameId,
      kind: pendingRef.kind,
      money: pendingRef.money.props(),
      referenceExternalTransactionId: pendingRef.referenceExternalTransactionId,
      status: WagerTransactionStatus.PendingReference,
      createdAt: AT,
    });

    expect(
      WagerTransactionPendingReference.from({
        eventId: 'event-1',
        transaction: persistedPendingRef,
        ctx: CTX,
      }).occurredAt.toISOString(),
    ).toBe(AT.toISOString());
  });
});
