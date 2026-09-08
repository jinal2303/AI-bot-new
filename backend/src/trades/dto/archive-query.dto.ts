import { Direction, ExpiryType, TradeStatus } from '@prisma/client';
import { IsDateString, IsIn, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Query params accepted by GET /api/signals/archive. Every field is
 * optional — an empty query returns the full (paginated) history.
 */
export class ArchiveQueryDto {
  @IsOptional()
  @IsIn(Object.values(TradeStatus))
  status?: TradeStatus;

  @IsOptional()
  @IsIn(Object.values(Direction))
  direction?: Direction;

  @IsOptional()
  @IsIn(Object.values(ExpiryType))
  expiryType?: ExpiryType;

  /** Inclusive IST calendar-date range, e.g. 2026-09-01. */
  @IsOptional()
  @IsDateString({ strict: true })
  dateFrom?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 100;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
