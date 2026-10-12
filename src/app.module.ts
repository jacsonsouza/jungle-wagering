import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './database/mikro-orm.config.js';
import { DomainErrorFilter } from './http/domain-error.filter.js';
import { HttpModule } from './http/http.module.js';
import { NoopAuthGuard } from './http/noop-auth.guard.js';
import { MessagingModule } from './messaging/messaging.module.js';
import type { LoggerPort } from './ports/logger.port.js';
import { PORTS } from './ports/tokens.js';
import { UseCasesModule } from './use-cases/use-cases.module.js';

/**
 * Composition root: infrastructure wiring only, no business rules.
 *
 * The exception filter and the auth guard are registered globally here so a
 * controller can never forget them; everything else is owned by the module
 * that actually consumes it.
 */
@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    UseCasesModule,
    HttpModule,
    MessagingModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useFactory: (logger: LoggerPort) => new DomainErrorFilter(logger),
      inject: [PORTS.logger],
    },
    // §2 explicitly allows the authentication mechanism to be a stub.
    { provide: APP_GUARD, useClass: NoopAuthGuard },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    },
  ],
})
export class AppModule {}
