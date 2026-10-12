import { Controller, Get, Param } from '@nestjs/common';
import { GetTransactionUseCase } from '../../use-cases/get-transaction.use-case.js';
import { presentTransaction } from '../presenters.js';

/** Both §9 lookup routes, on one controller so the shapes cannot drift. */
@Controller()
export class TransactionsController {
  constructor(private readonly getTransaction: GetTransactionUseCase) {}

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string): Promise<unknown> {
    return presentTransaction(
      await this.getTransaction.execute({ by: 'transactionId', transactionId }),
    );
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byProviderExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<unknown> {
    return presentTransaction(
      await this.getTransaction.execute({
        by: 'providerExternal',
        providerId,
        externalTransactionId,
      }),
    );
  }
}
