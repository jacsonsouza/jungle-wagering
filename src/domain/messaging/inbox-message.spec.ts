import { AT, LATER } from '../testing/factories.js';
import { InboxMessage } from './inbox-message.js';

describe('InboxMessage', () => {
  it('is NOT processed right after being received (regression)', () => {
    const message = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash-1',
      receivedAt: AT,
    });

    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  it('marks processed with the given timestamp', () => {
    const message = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash-1',
      receivedAt: AT,
    });

    message.markProcessed(LATER);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt?.toISOString()).toBe(LATER.toISOString());
  });

  it('is idempotent on markProcessed', () => {
    const message = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash-1',
      receivedAt: AT,
    });

    message.markProcessed(LATER);
    message.markProcessed(new Date('2026-01-01T13:00:00.000Z'));

    expect(message.processedAt?.toISOString()).toBe(LATER.toISOString());
  });

  it('copies receivedAt so external mutation cannot corrupt the record', () => {
    const receivedAt = new Date(AT);
    const message = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash-1',
      receivedAt,
    });

    receivedAt.setUTCFullYear(1999);

    expect(message.receivedAt.toISOString()).toBe(AT.toISOString());
  });

  it('rehydrates the persisted state', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash-1',
      receivedAt: AT,
      processedAt: LATER,
    });

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt?.toISOString()).toBe(LATER.toISOString());
  });

  it('rehydrates a message that was never processed', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash-1',
      receivedAt: AT,
    });

    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });
});
