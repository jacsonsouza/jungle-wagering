import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { decodeCursor } from '../../domain/index.js';
import { CreateWalletUseCase } from '../../use-cases/create-wallet.use-case.js';
import { GetWalletUseCase } from '../../use-cases/get-wallet.use-case.js';
import { ListWalletLedgerUseCase } from '../../use-cases/list-wallet-ledger.use-case.js';
import { ReconcileWalletUseCase } from '../../use-cases/reconcile-wallet.use-case.js';
import { CreateWalletBody } from '../dto/create-wallet.body.js';
import { LedgerQuery } from '../dto/ledger.query.js';
import { presentWallet } from '../presenters.js';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listLedger: ListWalletLedgerUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  async create(@Body() body: CreateWalletBody): Promise<unknown> {
    const result = await this.createWallet.execute({
      playerId: body.playerId,
      currency: body.initialBalance.currency,
      initialAmount: body.initialBalance.amount,
    });

    // A duplicate (player, currency) is a conflict, not a retryable failure:
    // the wallet already exists and sending the same request again will never
    // create it. §9 requires the two situations to be distinguishable.
    if (result.outcome === 'ALREADY_EXISTS') {
      throw new ConflictException({
        error: {
          name: 'WalletAlreadyExistsError',
          code: 'WALLET_ALREADY_EXISTS',
          category: 'CONFLICT',
          message: 'a wallet already exists for this player and currency',
          details: {
            playerId: body.playerId,
            currency: body.initialBalance.currency,
          },
        },
      });
    }

    return presentWallet(result.wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<unknown> {
    return presentWallet(await this.getWallet.execute(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query() query: LedgerQuery,
  ): Promise<unknown> {
    // `decodeCursor` answers null for anything this endpoint did not mint, and the use
    // case takes `undefined` for "no cursor" — so null is a caller error and
    // undefined is simply the first page.
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;

    if (query.cursor && !after) {
      throw new BadRequestException({
        error: {
          name: 'InvalidCursorError',
          code: 'INVALID_CURSOR',
          category: 'VALIDATION',
          message:
            'cursor is not a value previously returned by this endpoint',
          details: {},
        },
      });
    }

    const page = await this.listLedger.execute({
      walletId,
      after: after ?? undefined,
      limit: query.limit,
    });

    return {
      walletId: page.walletId,
      entries: page.entries,
      nextCursor: page.nextCursor,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconciliation(@Param('walletId') walletId: string): Promise<unknown> {
    return this.reconcile.execute(walletId);
  }
}
