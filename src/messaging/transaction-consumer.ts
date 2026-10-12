import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/core';
import {
  CurrencyCode,
  InboxMessage,
  isDomainError,
  WagerTransactionKind,
} from '../domain/index.js';
import { isLockConflict } from '../observability/lock-conflict.js';
import { secondsBetween, type ClockPort } from '../ports/clock.port.js';
import type { InboxRepositoryPort } from '../ports/inbox-repository.port.js';
import type { LoggerPort } from '../ports/logger.port.js';
import type { MessageQueuePort, ReceivedMessage } from '../ports/message-queue.port.js';
import type { MetricsPort } from '../ports/metrics.port.js';
import type { UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import type {
  SubmitTransactionCommand,
  SubmitTransactionResult,
} from '../use-cases/submit-transaction.use-case.js';
import { SubmitTransactionUseCase } from '../use-cases/submit-transaction.use-case.js';

/** §10: the consumer name is half of the dedupe key. */
export const CONSUMER_NAME = 'wager-transactions-consumer';

/** Receipt handles SQS cannot outlive; the worker simply releases them. */
const MAX_MESSAGE_LENGTH = 256 * 1024;

export interface ConsumerOptions {
  readonly maxMessages: number;
  readonly waitTimeSeconds: number;
  readonly visibilityTimeoutSeconds: number;
}

/**
 * The SQS side of the wagering entry point (§10).
 *
 * It is deliberately thin: the same `SubmitTransactionUseCase` that serves
 * HTTP handles the business rules, so an operation behaves identically whether
 * it arrived as a REST call or a message. What the consumer adds is the three
 * guarantees a queue demands:
 *
 *  1. **Dedupe survives a crash.** The inbox row is written inside the same
 *     transaction as the effects, so "already handled" is answered by a
 *     database constraint rather than by memory. Redelivery is therefore free.
 *
 *  2. **Ack only after commit.** The message is deleted once — and only once —
 *     the transaction holding the effects has committed. Deleting earlier
 *     turns a crash between ack and commit into silent data loss.
 *
 *  3. **Failures are classified, not swallowed.** A business refusal is
 *     terminal and acked; a transport or infrastructure failure is redelivered;
 *     a payload nobody will ever be able to parse goes to the DLQ instead of
 *     looping forever.
 */
export class TransactionConsumer {
  private running = false;
  private inFlight = 0;
  private idle?: Promise<void>;

  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly inbox: InboxRepositoryPort,
    private readonly submit: SubmitTransactionUseCase,
    private readonly queue: MessageQueuePort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly metrics: MetricsPort,
    private readonly queueUrl: string,
    private readonly dlqUrl: string,
    private readonly options: ConsumerOptions,
  ) {}

  /**
   * Starts the polling loop. Returns immediately; `stop()` drains it.
   *
   * Draining on shutdown is not cosmetic: a message cut off mid-transaction
   * would be redelivered, and while that is safe it doubles work for exactly
   * the deployments that restart the most.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.idle = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.idle;

    // Anything still in flight has either committed and been acked, or rolled
    // back and been released. Waiting is what makes the shutdown honest.
    while (this.inFlight > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** One poll cycle, exposed so tests can drive it without timers. */
  async consumeOnce(): Promise<number> {
    const messages = await this.queue.receive(this.queueUrl, {
      maxMessages: this.options.maxMessages,
      waitTimeSeconds: this.options.waitTimeSeconds,
      visibilityTimeoutSeconds: this.options.visibilityTimeoutSeconds,
    });

    for (const message of messages) {
      await this.handle(message);
    }

    return messages.length;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const received = await this.consumeOnce();

        // Something was waiting: come straight back for the next batch.
        if (received > 0) continue;
      } catch (error) {
        this.logger.error('consumer poll failed', {}, error);
        this.metrics.increment('consumer_poll_failures_total');
      }

      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  private async handle(message: ReceivedMessage): Promise<void> {
    this.inFlight += 1;

    try {
      const outcome = await this.process(message);

      // Ack only now: the effects are committed, so losing the message could
      // no longer lose the work.
      await this.acknowledge(message, outcome);
    } catch (error) {
      this.logger.error(
        'consumer failed to handle message',
        { messageId: message.messageId, receiveCount: message.receiveCount },
        error,
      );
      this.metrics.increment('consumer_handling_failures_total');
    } finally {
      this.inFlight -= 1;
    }
  }

  private async acknowledge(
    message: ReceivedMessage,
    outcome: Outcome,
  ): Promise<void> {
    if (outcome.kind === 'RETRY') {
      // Release instead of delete: the message becomes visible at once rather
      // than waiting out the visibility timeout, so a transient outage does not
      // cost a full timeout per message.
      await this.queue.release(this.queueUrl, message.receiptHandle);
      this.metrics.increment('consumer_retries_total');
      return;
    }

    if (outcome.kind === 'DEAD_LETTER') {
      await this.queue.sendToDeadLetter(this.queueUrl, this.dlqUrl, message);
      this.metrics.increment('consumer_dead_letters_total');
      return;
    }

    await this.queue.delete(this.queueUrl, message.receiptHandle);
  }

  private async process(message: ReceivedMessage): Promise<Outcome> {
    if (message.body.length > MAX_MESSAGE_LENGTH) {
      return { kind: 'DEAD_LETTER' };
    }

    const command = this.parse(message.body);

    if (!command) {
      return { kind: 'DEAD_LETTER' };
    }

    const startedAt = this.clock.now();

    try {
      const result = await this.runWithInbox(message, command);

      this.record(result, startedAt);
    } catch (error) {
      return this.classify(error, message);
    }

    return { kind: 'ACK' };
  }

  /**
   * Inbox row and effects in one transaction, then the ack happens outside.
   *
   * This is the shape §10 asks for: a duplicate `messageId` trips the unique
   * constraint, the whole transaction rolls back, and nothing was applied
   * twice — which is why redelivery after a crash is harmless.
   */
  private async runWithInbox(
    message: ReceivedMessage,
    command: SubmitTransactionCommand,
  ): Promise<SubmitTransactionResult> {
    const payloadHash = hashOf(message.body);

    return this.uow.transaction(async (tx: EntityManager) => {
      try {
        await this.inbox.insert(
          tx,
          InboxMessage.receive({
            messageId: message.messageId,
            consumerName: CONSUMER_NAME,
            payloadHash,
            receivedAt: this.clock.now(),
          }),
        );
      } catch (error) {
        if (error instanceof UniqueConstraintViolationException) {
          // Somebody already applied this exact message. The transaction is
          // doomed, so let it roll back: the effects are already in.
          throw new AlreadyHandledError();
        }
        throw error;
      }

      // The SAME use case HTTP uses (§10). Anything else would be a second
      // definition of "correct" for the same operation.
      return this.submit.executeIn(tx, command);
    });
  }

  private classify(error: unknown, message: { receiveCount: number }): Outcome {
    if (error instanceof AlreadyHandledError) return { kind: 'ACK' };

    // A DomainError means the payload was understood and refused on its
    // merits. Redelivering cannot change the answer, so it is terminal.
    if (isDomainError(error)) {
      this.metrics.increment('consumer_business_rejections_total', {
        code: error.code,
      });
      return { kind: 'ACK' };
    }

    // The messaging mirror of §12's lock-conflict signal. This is where every
    // failure lands — the consumer has no outer catch — so it is counted here
    // rather than at the throw, and only once per message.
    if (isLockConflict(error)) {
      this.metrics.increment('lock_conflicts_total');
    }

    // Everything else is infrastructure or an unreadable payload. The latter
    // never becomes readable, so it goes to the DLQ rather than looping.
    if (this.isPermanent(error)) {
      this.logger.error(
        'message permanently failed, sending to DLQ',
        { receiveCount: message.receiveCount },
        error,
      );
      return { kind: 'DEAD_LETTER' };
    }

    return { kind: 'RETRY' };
  }

  /**
   * True when retrying cannot possibly help.
   *
   * Deliberately conservative: an unrecognised failure is treated as
   * transient, because a spurious retry is cheap while a spurious DLQ entry
   * hides a working system's bug.
   */
  private isPermanent(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    return (
      error.name === 'SyntaxError' ||
      error.name === 'TypeError' ||
      error.message.toLowerCase().includes('unsupported')
    );
  }

  private parse(body: string): SubmitTransactionCommand | null {
    try {
      const envelope: unknown = JSON.parse(body);

      if (typeof envelope !== 'object' || envelope === null) return null;

      const { data } = envelope as { data?: unknown };

      if (typeof data !== 'object' || data === null) return null;

      const d = data as Record<string, unknown>;
      const required = [
        'providerId',
        'externalTransactionId',
        'playerId',
        'walletId',
        'roundId',
        'gameId',
        'kind',
        'money',
      ] as const;

      for (const field of required) {
        if (d[field] === undefined) return null;
      }

      if (typeof d.money !== 'object' || d.money === null) return null;

      const money = d.money as { amount?: unknown; currency?: unknown };

      if (typeof money.amount !== 'string' || typeof money.currency !== 'string') {
        return null;
      }

      // Validated here rather than cast: `Money.from` would refuse it later,
      // but only after the use case had already opened a transaction. An
      // unknown currency is a malformed payload, and malformed payloads go to
      // the DLQ — they never become readable by retrying.
      if (!Object.values(CurrencyCode).includes(money.currency as CurrencyCode)) {
        return null;
      }

      // `Object.values`, not `in`: the enum is `{ Bet: 'BET' }`, so `in`
      // tests the KEYS and would reject every valid message — sending the
      // whole queue to the DLQ. (Same trap the currency check above avoids.)
      if (
        typeof d.kind !== 'string' ||
        !Object.values(WagerTransactionKind).includes(
          d.kind as (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind],
        )
      ) {
        return null;
      }

      return {
        providerId: String(d.providerId),
        externalTransactionId: String(d.externalTransactionId),
        // §9: the header is the source of truth. A message that carries its
        // own key is replayed exactly like the HTTP call it mirrors.
        idempotencyKey:
          typeof d.idempotencyKey === 'string'
            ? d.idempotencyKey
            : `${String(d.providerId)}:${String(d.externalTransactionId)}`,
        playerId: String(d.playerId),
        walletId: String(d.walletId),
        roundId: String(d.roundId),
        gameId: String(d.gameId),
        kind: d.kind as SubmitTransactionCommand['kind'],
        money: {
          amount: money.amount,
          currency: money.currency as CurrencyCode,
        },
        referenceExternalTransactionId:
          typeof d.referenceExternalTransactionId === 'string'
            ? d.referenceExternalTransactionId
            : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * The queue-side counterpart of the submission's own recording (§12).
   *
   * Counted and timed HERE rather than inside the use case, and for the same
   * reason: this is a different entry point. A message's processing time is
   * the queue's number — it spans the inbox write and the whole transaction —
   * and folding the two entry points into one series would hide which of them
   * is actually slow.
   */
  private record(result: SubmitTransactionResult, startedAt: Date): void {
    this.metrics.observe(
      'message_processing_seconds',
      secondsBetween(startedAt, this.clock.now()),
      { status: result.status },
    );

    this.metrics.increment('consumer_processed_total', {
      status: result.status,
    });

    if (result.idempotentReplay) {
      this.metrics.increment('consumer_duplicates_total');
    }
  }
}

type Outcome =
  | { readonly kind: 'ACK' }
  | { readonly kind: 'RETRY' }
  | { readonly kind: 'DEAD_LETTER' };

/** Thrown inside the transaction so it rolls back before anything is written. */
class AlreadyHandledError extends Error {
  constructor() {
    super('message was already handled by this consumer');
    this.name = 'AlreadyHandledError';
  }
}

/**
 * A short, stable hash of the body, stored on the inbox row.
 *
 * It is not a security control — it exists so an operator can see that the
 * same messageId arrived with a different payload, which is the one case a
 * dedupe key alone would happily hide.
 */
function hashOf(body: string): string {
  let hash = 0;

  for (let i = 0; i < body.length; i += 1) {
    hash = (hash * 31 + body.charCodeAt(i)) | 0;
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}
