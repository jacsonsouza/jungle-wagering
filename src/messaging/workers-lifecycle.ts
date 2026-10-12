import type { LoggerPort } from '../ports/logger.port.js';
import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { OutboxPublisher } from './outbox-publisher.js';
import { ReferenceWorker } from './reference-worker.js';
import { TransactionConsumer } from './transaction-consumer.js';

/**
 * Starts the three background workers and drains them in the right order on
 * shutdown.
 *
 * The ORDER matters more than the stopping. Consumers are halted first so no
 * new message is taken while the publisher is still catching up; the publisher
 * and the reference worker stop last, because a message whose effects were
 * committed but whose ack never went out is a duplicate on redelivery, while a
 * message that is dropped mid-transaction is lost work.
 *
 * `SIGTERM` therefore means "finish what you started", not "abort" — which is
 * what §10 asks for when it says a shutdown must complete in-flight messages
 * or return them to visibility.
 */
export class WorkersLifecycle
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(
    private readonly consumer: TransactionConsumer,
    private readonly publisher: OutboxPublisher,
    private readonly referenceWorker: ReferenceWorker,
    private readonly logger: LoggerPort,
    /** Workers are driven manually by the integration suite, never on a timer. */
    private readonly enabled: boolean,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;

    // The publisher starts first: a consumer that commits an event into the
    // outbox with nothing draining it would leave the event stuck until the
    // next deploy.
    this.publisher.start();
    this.referenceWorker.start();
    this.consumer.start();

    this.logger.info('messaging workers started', {
      consumer: 'wager-transactions-consumer',
      publisher: 'outbox-publisher',
      referenceWorker: 'reference-worker',
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.enabled) return;

    this.logger.info('draining messaging workers');

    // Sequential on purpose — running these in parallel would let the consumer
    // take a fresh message while the publisher it depends on is going away.
    await this.consumer.stop();
    await this.publisher.stop();
    await this.referenceWorker.stop();

    this.logger.info('messaging workers drained');
  }
}
