import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { env } from './config/env.js';
import { runWithCorrelationId } from './observability/correlation-context.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.enableShutdownHooks();

  // §12: every log line and every response carries a correlation id. Reading
  // an inbound header rather than always minting one means a caller can
  // correlate this service's traces with theirs.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const inbound = req.headers['x-correlation-id'];

    const id =
      typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID();

    res.setHeader('x-correlation-id', id);

    runWithCorrelationId(id, () => next());
  });

  await app.listen(env.port);
}

await bootstrap();
