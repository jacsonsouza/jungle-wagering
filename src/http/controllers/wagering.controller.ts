import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { SubmitTransactionResult } from '../../use-cases/submit-transaction.use-case.js';
import { SubmitTransactionUseCase } from '../../use-cases/submit-transaction.use-case.js';
import { SubmitTransactionBody } from '../dto/submit-transaction.body.js';
import { presentSubmitResult } from '../presenters.js';

@Controller('wagering')
export class WageringController {
  constructor(private readonly submit: SubmitTransactionUseCase) {}

  @Post('transactions')
  @HttpCode(HttpStatus.OK)
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: SubmitTransactionBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: {
          name: 'MissingIdempotencyKeyError',
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          category: 'VALIDATION',
          message: 'the Idempotency-Key header is required (§9)',
          details: {},
        },
      });
    }

    const result = await this.submit.execute({
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      idempotencyKey,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
    });

    res.status(statusFor(result));

    return presentSubmitResult(result);
  }
}

/**
 * §9: the status has to say, without any prose, whether resending is safe.
 *
 *  200  applied — do not resend
 *  202  accepted, still waiting for the reference — resend is safe and useful
 *  422  rejected by a business rule — resending changes nothing
 *  409  ALREADY_REVERSED: the one business refusal a caller may be able to
 *       fix (they reversed twice), so it must not look like a plain 422
 *
 * The REJECTED mapping lives here rather than in the exception filter because
 * a rejection is a committed row, not an exception: it has to replay with the
 * same status forever (§7.7), and a filter cannot express that.
 */
function statusFor(result: SubmitTransactionResult): HttpStatus {
  if (result.status === 'PENDING_REFERENCE') return HttpStatus.ACCEPTED;

  if (result.status === 'REJECTED') {
    return result.failureCode === 'ALREADY_REVERSED'
      ? HttpStatus.CONFLICT
      : HttpStatus.UNPROCESSABLE_ENTITY;
  }

  return HttpStatus.OK;
}
