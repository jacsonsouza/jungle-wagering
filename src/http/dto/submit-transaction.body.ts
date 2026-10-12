import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { WagerTransactionKind } from '../../domain/index.js';
import { MoneyBody } from './create-wallet.body.js';

export class SubmitTransactionBody {
  @IsString()
  @IsNotEmpty()
  @Length(1, 64)
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  @Length(1, 128)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  @Length(1, 128)
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  @Length(1, 64)
  gameId!: string;

  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @ValidateNested()
  @Type(() => MoneyBody)
  money!: MoneyBody;

  /**
   * Only reversal kinds may carry it — §7.4 — and the domain enforces that
   * rule, so this DTO only checks the shape.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Length(1, 128)
  referenceExternalTransactionId?: string;
}
