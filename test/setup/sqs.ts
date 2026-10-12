import { randomUUID } from 'node:crypto';
import { env } from '../../src/config/env.js';
import { SqsMessageQueue } from '../../src/messaging/sqs-message-queue.js';
import type { SubmitTransactionCommand } from '../../src/use-cases/submit-transaction.use-case.js';

/**
 * Shared SQS (LocalStack) test infrastructure.
 *
 * Several integration suites need the same four things — a queue client, a way
 * to empty both queues between tests, a way to count what is actually
 * readable, and a way to build the payload the consumer parses. Duplicating
 * them would risk two suites drifting into different ideas of what "empty"
 * means, so they live here once.
 */

/**
 * SQS FIFO drops a message whose deduplication id it has seen in the last five
 * minutes — silently, with a successful send. Fixed ids would therefore make
 * the second run of a suite consume nothing at all, so every send gets a
 * fresh one.
 */
export function freshDedupId(): string {
  return `dedup-${randomUUID()}`;
}

/** The envelope shape the consumer parses: an event carrying the command. */
export function bodyOf(cmd: SubmitTransactionCommand): string {
  return JSON.stringify({ data: { ...cmd } });
}

/** A fresh client. Cheap: the SDK batches connections per configuration. */
export function buildQueue(): SqsMessageQueue {
  return new SqsMessageQueue(env.sqs);
}

/**
 * Empties both queues.
 *
 * Every test starts from silence, so a leftover from the previous scenario
 * cannot be mistaken for the one being asserted.
 *
 * The visibility timeout is a real one, not zero: receiving with 0 makes the
 * message immediately visible again, which rotates its receipt handle — and
 * the delete that follows then fails with "the receipt handle has expired".
 * A non-zero timeout keeps the handle valid until the delete lands.
 */
export async function drainQueues(): Promise<void> {
  const queue = buildQueue();

  for (const url of [env.sqs.queueUrl, env.sqs.dlqUrl]) {
    for (let i = 0; i < 20; i += 1) {
      const messages = await queue.receive(url, {
        maxMessages: 10,
        waitTimeSeconds: 0,
        visibilityTimeoutSeconds: 30,
      });

      if (messages.length === 0) break;

      for (const message of messages) {
        await queue.delete(url, message.receiptHandle);
      }
    }
  }
}

/**
 * How many messages are readable right now, and empties them.
 *
 * Deliberately implemented by actually receiving rather than by reading
 * `ApproximateNumberOfMessages`: that attribute is eventually consistent, so
 * on LocalStack it can still report a message that a receive will not return.
 * The tests assert "empty" vs "has one" — a count that lies about the empty
 * case would make every one of those assertions worthless.
 */
export async function queueDepth(url: string): Promise<number> {
  const queue = buildQueue();
  const messages = await queue.receive(url, {
    maxMessages: 10,
    waitTimeSeconds: 0,
    visibilityTimeoutSeconds: 30,
  });

  for (const message of messages) {
    await queue.delete(url, message.receiptHandle);
  }

  return messages.length;
}
