import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { UseCasesModule } from '../use-cases/use-cases.module.js';
import { type HealthCheckPort } from '../ports/health.port.js';
import { PORTS } from '../ports/tokens.js';
import { PostgresHealthCheck } from '../repositories/postgres-health-check.js';
import { HealthController } from './controllers/health.controller.js';
import { MetricsController } from './controllers/metrics.controller.js';
import { TransactionsController } from './controllers/transactions.controller.js';
import { WageringController } from './controllers/wagering.controller.js';
import { WalletsController } from './controllers/wallets.controller.js';

/**
 * The HTTP boundary and nothing else.
 *
 * Controllers depend on use cases, never on repositories or the EntityManager:
 * the only way in is through the application layer, which is what keeps the
 * `{ clear: true }` isolation guarantee on every request.
 */
@Module({
  imports: [UseCasesModule],
  providers: [
    // Readiness probes live here rather than in the root module because only
    // this module's controllers consume them: a provider is visible to the
    // module that declares it and the modules it imports, never the reverse.
    {
      provide: PORTS.healthChecks,
      useFactory: (em: EntityManager): readonly HealthCheckPort[] => [
        new PostgresHealthCheck(em),
      ],
      inject: [EntityManager],
    },
  ],
  controllers: [
    WalletsController,
    WageringController,
    TransactionsController,
    HealthController,
    MetricsController,
  ],
})
export class HttpModule {}
