import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { CurrencyCode } from '../../domain/index.js';

export class MoneyBody {
  /**
   * A decimal STRING, never a JSON number: `25.10` arrives as `25.1` in binary
   * floating point before the service ever sees it. `Money` parses the string and keeps
   * it that way, which is the whole point of §5.9.
   */
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'amount must be a decimal string with at most 2 fraction digits',
  })
  amount!: string;

  /** Rejected here rather than cast: an unknown currency is a client error. */
  @IsString()
  @Length(3, 3)
  @IsIn(Object.values(CurrencyCode))
  currency!: (typeof CurrencyCode)[keyof typeof CurrencyCode];
}

export class CreateWalletBody {
  @IsString()
  @IsNotEmpty()
  @Length(1, 64)
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyBody)
  initialBalance!: MoneyBody;
}
