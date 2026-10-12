import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { FailureCategory, isDomainError } from '../domain/index.js';
import type { LoggerPort } from '../ports/logger.port.js';

/**
 * The single place that turns a failure into an HTTP status.
 *
 * §9 explicitly forbids collapsing distinct outcomes into one code, because a
 * provider would then have to parse the error text to learn whether resending
 * is safe. Three inputs, three rules:
 *
 *  - A **thrown** DomainError means the request was refused before anything
 *    was persisted. Its category is the whole story, so it decides the status.
 *  - An **HttpException** is Nest's own — a `ValidationPipe` rejection, or one
 *    thrown by a controller. It already carries the status and body it wants,
 *    so it is handed straight back. This branch is not optional: this filter is
 *    a catch-all, and without it every 400 and 409 in the API would collapse
 *    into a 500.
 *  - A **returned** status of REJECTED is not thrown — it is a committed row
 *    that must replay identically forever (§7.7). Those are mapped by the
 *    controller, not here, because a filter only ever sees exceptions.
 *
 * STATE maps to 409, not 500: the resource exists and is simply in a state
 * that forbids this operation, which is exactly what Conflict means.
 * EXHAUSTED maps to 503 so the caller knows retrying later may work.
 *
 * Anything left is a bug or unreachable infrastructure. Either way the stack
 * stays in the logs and never in the response body.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerPort) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (isDomainError(exception)) {
      response
        .status(STATUS_BY_CATEGORY[exception.category])
        .json({ error: exception.toJSON() });
      return;
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    this.logger.error('unhandled exception', {}, exception);

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        name: 'InternalError',
        code: 'INTERNAL_ERROR',
        category: FailureCategory.Validation,
        message: 'unexpected error',
        details: {},
      },
    });
  }
}

const STATUS_BY_CATEGORY: Readonly<Record<string, HttpStatus>> = {
  [FailureCategory.Validation]: HttpStatus.BAD_REQUEST,
  [FailureCategory.Conflict]: HttpStatus.CONFLICT,
  [FailureCategory.NotFound]: HttpStatus.NOT_FOUND,
  [FailureCategory.State]: HttpStatus.CONFLICT,
  [FailureCategory.Exhausted]: HttpStatus.SERVICE_UNAVAILABLE,
};
