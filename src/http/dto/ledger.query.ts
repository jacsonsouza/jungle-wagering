import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class LedgerQuery {
  @IsOptional()
  @IsString()
  cursor?: string;

  /** Query strings arrive as text, and `enableImplicitConversion` is off. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
