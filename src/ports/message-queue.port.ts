/**
 * A message as the transport hands it over — transport-agnostic, so the
 * consumer can be tested without a broker.
 */
export interface ReceivedMessage {
  /** Broker-assigned id. §10: the inbox dedupes on (consumerName, messageId). */
  readonly messageId: string;
  /** Receipt handle proves the consumer holds the message; deleting needs it. */
  readonly receiptHandle: string;
  readonly body: string;
  readonly receiveCount: number;
}

export interface OutgoingMessage {
  /**
   * FIFO group. One wallet's operations must stay ordered, so the walletId is
   * the natural group: parallel consumers then work on DIFFERENT wallets while
   * a single wallet's stream never interleaves.
   */
  readonly messageGroupId: string;
  /** FIFO dedupe id: a duplicate publish inside the window is dropped by SQS. */
  readonly deduplicationId: string;
  readonly body: string;
}

/**
 * The queue, behind a port.
 *
 * SQS is one implementation; the consumer and publisher only ever see these
 * four verbs, so the workers can be unit-tested against a fake and exercised
 * against LocalStack in integration tests.
 */
export interface MessageQueuePort {
  send(queueUrl: string, message: OutgoingMessage): Promise<void>;
  receive(
    queueUrl: string,
    options: {
      readonly maxMessages: number;
      readonly waitTimeSeconds: number;
      readonly visibilityTimeoutSeconds: number;
    },
  ): Promise<readonly ReceivedMessage[]>;
  /** Delete only AFTER the database commit — never before (§10). */
  delete(queueUrl: string, receiptHandle: string): Promise<void>;
  /**
   * Put a message back immediately.
   *
   * Used on shutdown, so work that cannot finish becomes someone else's
   * problem at once instead of sitting invisible for the whole visibility
   * timeout.
   */
  release(queueUrl: string, receiptHandle: string): Promise<void>;
  /** Move a poison message to the DLQ and clear it from the main queue. */
  sendToDeadLetter(
    queueUrl: string,
    dlqUrl: string,
    message: ReceivedMessage,
  ): Promise<void>;
}
