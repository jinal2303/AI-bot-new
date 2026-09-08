import { Controller, Get, HttpException, HttpStatus, Logger, Query } from '@nestjs/common';
import { TradeSignal } from '@prisma/client';
import { TradesService, ArchiveResult } from './trades.service';
import { ArchiveQueryDto } from './dto/archive-query.dto';

/**
 * Shares the `/api/signals` route prefix with SignalsController — this
 * controller owns the persisted-history endpoints (today / archive) while
 * SignalsController owns the live indicator snapshot (`/latest`).
 */
@Controller('signals')
export class TradesController {
  private readonly logger = new Logger(TradesController.name);

  constructor(private readonly tradesService: TradesService) {}

  /** GET /api/signals/today — every signal generated on the current IST date. */
  @Get('today')
  async getToday(): Promise<TradeSignal[]> {
    try {
      return await this.tradesService.findToday();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to load today's signals: ${message}`);
      throw new HttpException(
        { message: "Unable to load today's signals right now.", detail: message },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /** GET /api/signals/archive — filtered, paginated historical signals. */
  @Get('archive')
  async getArchive(@Query() query: ArchiveQueryDto): Promise<ArchiveResult> {
    try {
      return await this.tradesService.findArchive(query);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to load archive: ${message}`);
      throw new HttpException(
        { message: 'Unable to load the signal archive right now.', detail: message },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
