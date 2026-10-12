import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { PORTS } from '../ports/tokens.js';
import type { UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import { MikroOrmUnitOfWork } from '../ports/unit-of-work.port.js';
import type { WalletRepositoryPort } from '../ports/wallet-repository.port.js';
import type { WagerTransactionRepositoryPort } from '../ports/wager-transaction-repository.port.js';
import type { OutboxRepositoryPort } from '../ports/outbox-repository.port.js';
import type { ClockPort } from '../ports/clock.port.js';
import type { IdGeneratorPort } from '../ports/id-generator.port.js';
import type { LoggerPort } from '../ports/logger.port.js';
import type { MetricsPort } from '../ports/metrics.port.js';
import { SystemClock } from '../ports/clock.port.js';
import { UuidGenerator } from '../ports/id-generator.port.js';
import { MikroOrmWalletRepository } from '../repositories/wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../repositories/wager-transaction.repository.js';
import { MikroOrmOutboxRepository } from '../repositories/outbox.repository.js';
import { JsonLogger } from '../observability/json-logger.js';
import { PrometheusMetrics } from '../observability/metrics.js';
import { CreateWalletUseCase } from './create-wallet.use-case.js';
import { SubmitTransactionUseCase } from './submit-transaction.use-case.js';
import { GetWalletUseCase } from './get-wallet.use-case.js';
import { ListWalletLedgerUseCase } from './list-wallet-ledger.use-case.js';
import { GetTransactionUseCase } from './get-transaction.use-case.js';
import { ReconcileWalletUseCase } from './reconcile-wallet.use-case.js';
import { env } from '../config/env.js';

/**
 * Composition root for the application layer.
 *
 * Ports are bound to their MikroORM/infrastructure implementations here and
 * nowhere else, so a use case can only ever depend on the abstraction.
 *
 * Logger and metrics are bound here rather than in the root module because a
 * use case (`ReconcileWalletUseCase`) consumes them: a provider declared in the
 * root is invisible to the modules it imports.
 */
@Module({
  providers: [
    {
      provide: PORTS.unitOfWork,
      useFactory: (em: EntityManager): UnitOfWorkPort =>
        new MikroOrmUnitOfWork(em),
      inject: [EntityManager],
    },
    { provide: PORTS.wallets, useClass: MikroOrmWalletRepository },
    {
      provide: PORTS.wagerTransactions,
      useClass: MikroOrmWagerTransactionRepository,
    },
    { provide: PORTS.outbox, useClass: MikroOrmOutboxRepository },
    { provide: PORTS.clock, useClass: SystemClock },
    { provide: PORTS.ids, useClass: UuidGenerator },
    {
      provide: PORTS.logger,
      useValue: new JsonLogger('jungle-wagering', env.logLevel),
    },
    {
      provide: PORTS.metrics,
      // Default metrics are skipped under test so parallel vitest workers do
      // not fight over one global default registry.
      useValue: new PrometheusMetrics(env.nodeEnv !== 'test'),
    },
    {
      provide: CreateWalletUseCase,
      useFactory: (
        uow: UnitOfWorkPort,
        wallets: WalletRepositoryPort,
        wagerTransactions: WagerTransactionRepositoryPort,
        outbox: OutboxRepositoryPort,
        clock: ClockPort,
        ids: IdGeneratorPort,
      ) =>
        new CreateWalletUseCase(
          uow,
          wallets,
          wagerTransactions,
          outbox,
          clock,
          ids,
        ),
      inject: [
        PORTS.unitOfWork,
        PORTS.wallets,
        PORTS.wagerTransactions,
        PORTS.outbox,
        PORTS.clock,
        PORTS.ids,
      ],
    },
    {
      provide: SubmitTransactionUseCase,
      useFactory: (
        uow: UnitOfWorkPort,
        wallets: WalletRepositoryPort,
        wagerTransactions: WagerTransactionRepositoryPort,
        outbox: OutboxRepositoryPort,
        clock: ClockPort,
        ids: IdGeneratorPort,
        logger: LoggerPort,
        metrics: MetricsPort,
      ) =>
        new SubmitTransactionUseCase(
          uow,
          wallets,
          wagerTransactions,
          outbox,
          clock,
          ids,
          logger,
          metrics,
        ),
      inject: [
        PORTS.unitOfWork,
        PORTS.wallets,
        PORTS.wagerTransactions,
        PORTS.outbox,
        PORTS.clock,
        PORTS.ids,
        PORTS.logger,
        PORTS.metrics,
      ],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (uow: UnitOfWorkPort, wallets: WalletRepositoryPort) =>
        new GetWalletUseCase(uow, wallets),
      inject: [PORTS.unitOfWork, PORTS.wallets],
    },
    {
      provide: ListWalletLedgerUseCase,
      useFactory: (uow: UnitOfWorkPort, wallets: WalletRepositoryPort) =>
        new ListWalletLedgerUseCase(uow, wallets),
      inject: [PORTS.unitOfWork, PORTS.wallets],
    },
    {
      provide: GetTransactionUseCase,
      useFactory: (
        uow: UnitOfWorkPort,
        wagerTransactions: WagerTransactionRepositoryPort,
      ) => new GetTransactionUseCase(uow, wagerTransactions),
      inject: [PORTS.unitOfWork, PORTS.wagerTransactions],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (
        uow: UnitOfWorkPort,
        wallets: WalletRepositoryPort,
        logger: LoggerPort,
        metrics: MetricsPort,
      ) => new ReconcileWalletUseCase(uow, wallets, logger, metrics),
      inject: [PORTS.unitOfWork, PORTS.wallets, PORTS.logger, PORTS.metrics],
    },
  ],
  exports: [
    CreateWalletUseCase,
    SubmitTransactionUseCase,
    GetWalletUseCase,
    ListWalletLedgerUseCase,
    GetTransactionUseCase,
    ReconcileWalletUseCase,
    // Re-exported so the root module can build the exception filter, and the
    // HTTP layer can read the live registry for /metrics.
    PORTS.logger,
    PORTS.metrics,
    // The messaging layer reuses these exact instances: a second repository
    // would mean a second identity map, and two identity maps on one
    // transaction is how a dedupe check starts lying.
    PORTS.unitOfWork,
    PORTS.wallets,
    PORTS.wagerTransactions,
    PORTS.outbox,
    PORTS.clock,
    PORTS.ids,
  ],
})
export class UseCasesModule {}
