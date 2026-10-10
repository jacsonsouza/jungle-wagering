import { WalletBalanceChanged } from '../events/wallet-balance-changed.event.js';
import {
  AT,
  CTX,
  LATER,
  ledgerEntry,
  openWallet,
} from '../testing/factories.js';
import { OutboxMessage } from './outbox-message.js';

function sampleEvent() {
  return WalletBalanceChanged.from({
    eventId: 'event-1',
    wallet: openWallet({ initialBalance: '100.00' }),
    entry: ledgerEntry({ balanceBefore: '100.00' }),
    ctx: CTX,
  });
}

describe('OutboxMessage.enqueue', () => {
  it('derives id, aggregate and payload from the event envelope', () => {
    const message = OutboxMessage.enqueue(sampleEvent());

    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.payload).toMatchObject({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      version: 1,
      occurredAt: AT.toISOString(),
    });
  });

  it('stores MoneyProps (strings), never Money instances', () => {
    const payload = OutboxMessage.enqueue(sampleEvent()).payload;
    const data = (payload as { data: { money: unknown } }).data;

    expect(JSON.parse(JSON.stringify(data)).money).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });
});

describe('OutboxMessage publishing and retry', () => {
  it('is due as soon as it has no scheduled retry', () => {
    const message = OutboxMessage.enqueue(sampleEvent());
    expect(message.isDue(LATER)).toBe(true);
  });

  it('schedules the next attempt with backoff and stops being due', () => {
    const message = OutboxMessage.enqueue(sampleEvent());

    message.scheduleRetry(AT);

    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt?.toISOString()).toBe(
      '2026-01-01T12:00:01.000Z',
    ); // +1s
    expect(message.isDue(AT)).toBe(false);
    expect(message.isDue(new Date('2026-01-01T12:00:01.000Z'))).toBe(true);
  });

  it('doubles the delay on consecutive retries', () => {
    const message = OutboxMessage.enqueue(sampleEvent());

    message.scheduleRetry(AT);
    expect(message.nextAttemptAt?.getTime()).toBe(AT.getTime() + 1_000);

    message.scheduleRetry(AT);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt?.getTime()).toBe(AT.getTime() + 2_000);
  });

  it('marks published idempotently and clears the retry schedule', () => {
    const message = OutboxMessage.enqueue(sampleEvent());
    message.scheduleRetry(AT);

    message.markPublished(LATER);
    message.markPublished(new Date('2026-02-01T00:00:00.000Z'));

    expect(message.isPending()).toBe(false);
    expect(message.publishedAt?.toISOString()).toBe(LATER.toISOString());
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.isDue(LATER)).toBe(false);
  });

  it('rejects retrying a published message', () => {
    const message = OutboxMessage.enqueue(sampleEvent());
    message.markPublished(LATER);

    expect(() => message.scheduleRetry(LATER)).toThrow(
      'published messages cannot be retried',
    );
  });

  it('rehydrates pending and published states', () => {
    const pending = OutboxMessage.rehydrate({
      id: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload: { a: 1 },
      occurredAt: AT,
      attempts: 3,
      nextAttemptAt: LATER,
    });
    expect(pending.attempts).toBe(3);
    expect(pending.isDue(AT)).toBe(false);
    expect(pending.publishedAt).toBeUndefined();
    expect(pending.nextAttemptAt?.toISOString()).toBe(LATER.toISOString());

    const published = OutboxMessage.rehydrate({
      id: 'event-2',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload: { a: 1 },
      occurredAt: AT,
      attempts: 1,
      publishedAt: LATER,
    });
    expect(published.isPending()).toBe(false);
  });
});
