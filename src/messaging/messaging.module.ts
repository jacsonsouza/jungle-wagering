import { Module } from '@nestjs/common';
import { PORTS } from '../ports/tokens.js';
import type { ClockPort } from '../ports/clock.port.js';
import type { IdGeneratorPort } from '../ports/id-generator.port.js';
import type { InboxRepositoryPort } from '../ports/inbox-repository.port.js';
import type { LoggerPort } from '../ports/logger.port.js';
import type { MessageQueuePort } from '../ports/message-queue.port.js';
import type { MetricsPort } from '../ports/metrics.port.js';
import type { OutboxRepositoryPort } from '../ports/outbox-repository.port.js';
import type { UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import type { WalletRepositoryPort } from '../ports/wallet-repository.port.js';
import type { WagerTransactionRepositoryPort } from '../ports/wager-transaction-repository.port.js';
import { MikroOrmInboxRepository } from '../repositories/inbox.repository.js';
import { SubmitTransactionUseCase } from '../use-cases/submit-transaction.use-case.js';
import { UseCasesModule } from '../use-cases/use-cases.module.js';
import { env } from '../config/env.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { ReferenceWorker } from './reference-worker.js';
import { SqsMessageQueue } from './sqs-message-queue.js';
import { TransactionConsumer } from './transaction-consumer.js';
import { WorkersLifecycle } from './workers-lifecycle.js';

/**
 * Composition root for the messaging layer (§10, §11).
 *
 * The three workers sit here rather than inside `UseCasesModule` because they
 * are adapters over the queue, not part of the application's business rules —
 * the use case they drive is imported, never redefined.
 *
 * They reuse the exact repository and unit-of-work instances the HTTP path
 * uses. A second instance of either would mean a second identity map, and two
 * identity maps sharing one transaction is precisely how an inbox dedupe check
 * starts reporting "not seen yet" for a row it just wrote.
 */
@Module({
  imports: [UseCasesModule],
  providers: [
    {
      provide: PORTS.inbox,
      useClass: MikroOrmInboxRepository,
    },
    {
      provide: PORTS.messageQueue,
      useFactory: (): MessageQueuePort => new SqsMessageQueue(env.sqs),
    },
    {
      provide: TransactionConsumer,
      useFactory: (
        uow: UnitOfWorkPort,
        inbox: InboxRepositoryPort,
        submit: SubmitTransactionUseCase,
        queue: MessageQueuePort,
        clock: ClockPort,
        logger: LoggerPort,
        metrics: MetricsPort,
      ) =>
        new TransactionConsumer(
          uow,
          inbox,
          submit,
          queue,
          clock,
          logger,
          metrics,
          env.sqs.queueUrl,
          env.sqs.dlqUrl,
          {
            maxMessages: env.sqs.maxMessages,
            waitTimeSeconds: env.sqs.waitTimeSeconds,
            visibilityTimeoutSeconds: env.sqs.visibilityTimeoutSeconds,
          },
        ),
      inject: [
        PORTS.unitOfWork,
        PORTS.inbox,
        SubmitTransactionUseCase,
        PORTS.messageQueue,
        PORTS.clock,
        PORTS.logger,
        PORTS.metrics,
      ],
    },
    {
      provide: OutboxPublisher,
      useFactory: (
        uow: UnitOfWorkPort,
        outbox: OutboxRepositoryPort,
        queue: MessageQueuePort,
        clock: ClockPort,
        logger: LoggerPort,
        metrics: MetricsPort,
      ) =>
        new OutboxPublisher(
          uow,
          outbox,
          queue,
          clock,
          logger,
          metrics,
          env.sqs.queueUrl,
        ),
      inject: [
        PORTS.unitOfWork,
        PORTS.outbox,
        PORTS.messageQueue,
        PORTS.clock,
        PORTS.logger,
        PORTS.metrics,
      ],
    },
    {
      provide: ReferenceWorker,
      useFactory: (
        uow: UnitOfWorkPort,
        wagerTransactions: WagerTransactionRepositoryPort,
        wallets: WalletRepositoryPort,
        outbox: OutboxRepositoryPort,
        submit: SubmitTransactionUseCase,
        clock: ClockPort,
        ids: IdGeneratorPort,
        logger: LoggerPort,
        metrics: MetricsPort,
      ) =>
        new ReferenceWorker(
          uow,
          wagerTransactions,
          wallets,
          outbox,
          submit,
          clock,
          ids,
          logger,
          metrics,
        ),
      inject: [
        PORTS.unitOfWork,
        PORTS.wagerTransactions,
        PORTS.wallets,
        PORTS.outbox,
        SubmitTransactionUseCase,
        PORTS.clock,
        PORTS.ids,
        PORTS.logger,
        PORTS.metrics,
      ],
    },
    {
      provide: WorkersLifecycle,
      useFactory: (
        consumer: TransactionConsumer,
        publisher: OutboxPublisher,
        referenceWorker: ReferenceWorker,
        logger: LoggerPort,
      ) =>
        new WorkersLifecycle(
          consumer,
          publisher,
          referenceWorker,
          logger,
          // The integration suite drives each worker by hand so it can assert
          // on intermediate state; leaving the loops running would race it.
          env.nodeEnv !== 'test',
        ),
      inject: [
        TransactionConsumer,
        OutboxPublisher,
        ReferenceWorker,
        PORTS.logger,
      ],
    },
  ],
  exports: [
    WorkersLifecycle,
    TransactionConsumer,
    OutboxPublisher,
    ReferenceWorker,
  ],
})
export class MessagingModule {}
