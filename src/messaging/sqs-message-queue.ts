import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  MessageSystemAttributeName,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { SqsEnv } from '../config/env.js';
import type {
  MessageQueuePort,
  OutgoingMessage,
  ReceivedMessage,
} from '../ports/message-queue.port.js';

/**
 * SQS behind `MessageQueuePort`.
 *
 * LocalStack and real AWS share this class untouched: the only difference is
 * the endpoint and the credentials, both of which arrive from the environment.
 * Nothing here knows it is talking to a emulator.
 *
 * Credentials are supplied explicitly rather than left to the SDK's chain,
 * because the default chain probes EC2 instance metadata — and a developer
 * running against LocalStack would pay a multi-second timeout on every call.
 */
export class SqsMessageQueue implements MessageQueuePort {
  private readonly client: SQSClient;

  constructor(config: SqsEnv) {
    this.client = new SQSClient({
      endpoint: config.endpoint,
      region: config.region,
      // Explicit, not the SDK's default chain: that chain probes EC2 instance
      // metadata, and a developer running against LocalStack would pay a
      // multi-second timeout on every single call.
      //
      // A fresh object, not `config.credentials` itself: the SDK annotates the
      // credentials it is given with `$source` for attribution, and the env
      // loader returns that value frozen — so passing it through made the
      // annotation silently no-op and then blow up on the next line.
      credentials: {
        accessKeyId: config.credentials.accessKeyId,
        secretAccessKey: config.credentials.secretAccessKey,
      },
    });
  }

  async send(queueUrl: string, message: OutgoingMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: message.body,
        // FIFO queues require both. Omitting the group would serialize the
        // whole queue behind one consumer; omitting the dedupe id would make
        // every redelivery a new message.
        MessageGroupId: message.messageGroupId,
        MessageDeduplicationId: message.deduplicationId,
      }),
    );
  }

  async receive(
    queueUrl: string,
    options: {
      readonly maxMessages: number;
      readonly waitTimeSeconds: number;
      readonly visibilityTimeoutSeconds: number;
    },
  ): Promise<readonly ReceivedMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: options.maxMessages,
        WaitTimeSeconds: options.waitTimeSeconds,
        VisibilityTimeout: options.visibilityTimeoutSeconds,
        MessageAttributeNames: ['All'],
        // `MessageSystemAttributeNames`, not the deprecated `AttributeNames`:
        // the latter is typed against queue attributes and would not compile.
        MessageSystemAttributeNames: [
          MessageSystemAttributeName.ApproximateReceiveCount,
        ],
      }),
    );

    const received: ReceivedMessage[] = [];

    for (const message of response.Messages ?? []) {
      const { MessageId, ReceiptHandle, Body } = message;

      // SQS promises all three; TypeScript cannot. A message missing any of
      // them cannot be acked (no handle) nor parsed (no body), so dropping it
      // here is the only honest option — and it surfaces as a redelivery.
      if (
        MessageId === undefined ||
        ReceiptHandle === undefined ||
        Body === undefined
      ) {
        continue;
      }

      received.push({
        messageId: MessageId,
        receiptHandle: ReceiptHandle,
        body: Body,
        receiveCount:
          Number(message.Attributes?.ApproximateReceiveCount ?? '1') || 1,
      });
    }

    return received;
  }

  async delete(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async release(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        // Zero makes it immediately visible to any consumer — the message must
        // not sit invisible for the rest of the visibility timeout while this
        // process is shutting down.
        VisibilityTimeout: 0,
      }),
    );
  }

  async sendToDeadLetter(
    queueUrl: string,
    dlqUrl: string,
    message: ReceivedMessage,
  ): Promise<void> {
    // An explicit DLQ send, rather than relying on SQS's own redrive: §10 asks
    // the consumer to tell PERMANENT failures apart from transient ones, and
    // redrive only knows "received too many times".
    await this.send(dlqUrl, {
      messageGroupId: 'dead-letter',
      // Deterministic, so a duplicate send of the same poison message collapses
      // into one DLQ entry instead of piling up.
      deduplicationId: message.messageId,
      body: message.body,
    });

    await this.delete(queueUrl, message.receiptHandle);
  }
}
