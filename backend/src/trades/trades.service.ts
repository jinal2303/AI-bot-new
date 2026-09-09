import { Injectable, Logger } from '@nestjs/common';
import { Direction, ExpiryType, Prisma, TargetBasis, TradeSignal, TradeStatus, TrailStage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toISTIsoDate } from '../common/ist-time.util';
import { ArchiveQueryDto } from './dto/archive-query.dto';

/** Every terminal status the 10s position monitor can resolve an ACTIVE position to. */
export type ExitStatus = Exclude<TradeStatus, typeof TradeStatus.ACTIVE>;

export interface CreateTradeSignalInput {
  direction: Direction;
  strikePrice: number;
  expiryType: ExpiryType;
  entrySpotPrice: number;
  stopLossSpot: number;
  targetSpot: number;
  /** The ATR(14) reading these SL/target distances were sized from — persisted for accurate display later. */
  atr14: number;
  targetBasis: TargetBasis;
}

export interface ArchiveResult {
  items: TradeSignal[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * All persisted TradeSignal reads/writes go through here — the strategy
 * engine (creation + daily throttle), the 10s position monitor (active-scan
 * + resolution), and the REST layer (today/archive) all share this single
 * source of truth.
 */
@Injectable()
export class TradesService {
  private readonly logger = new Logger(TradesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Today's IST calendar date, in the same YYYY-MM-DD shape stored in `dateString`. */
  private todayIso(): string {
    return toISTIsoDate(new Date());
  }

  /** Count of signals generated today — the input to the daily-throttle guard. */
  async countToday(): Promise<number> {
    return this.prisma.tradeSignal.count({ where: { dateString: this.todayIso() } });
  }

  /** True if there is currently any position still being tracked. */
  async hasActivePosition(): Promise<boolean> {
    const active = await this.prisma.tradeSignal.findFirst({
      where: { currentStatus: TradeStatus.ACTIVE },
      select: { id: true },
    });
    return active !== null;
  }

  /** Creates a new ACTIVE signal for today. */
  async createSignal(input: CreateTradeSignalInput): Promise<TradeSignal> {
    const signal = await this.prisma.tradeSignal.create({
      data: {
        dateString: this.todayIso(),
        direction: input.direction,
        strikePrice: input.strikePrice,
        expiryType: input.expiryType,
        entrySpotPrice: input.entrySpotPrice,
        stopLossSpot: input.stopLossSpot,
        targetSpot: input.targetSpot,
        atr14: input.atr14,
        targetBasis: input.targetBasis,
        currentStatus: TradeStatus.ACTIVE,
      },
    });
    this.logger.log(
      `New ${signal.direction} signal persisted — strike ${signal.strikePrice}, id ${signal.id}`,
    );
    return signal;
  }

  /** All currently-open positions, for the 10s target/stop-loss monitor to re-evaluate. */
  async findActivePositions(): Promise<TradeSignal[]> {
    return this.prisma.tradeSignal.findMany({ where: { currentStatus: TradeStatus.ACTIVE } });
  }

  /**
   * Flips a position to a terminal status (TARGET_HIT / STOPLOSS_HIT /
   * TRAIL_STOP_HIT / TIME_EXIT), recording the resolving spot price, the
   * final peak-favorable price, and the realized cash P&L in one write.
   */
  async resolvePosition(
    id: string,
    status: ExitStatus,
    resolvedSpot: number,
    peakSpot: number,
    netCashINR: number,
  ): Promise<TradeSignal> {
    return this.prisma.tradeSignal.update({
      where: { id },
      data: { currentStatus: status, resolvedAt: new Date(), resolvedSpot, peakSpot, netCashINR },
    });
  }

  /**
   * Persists any subset of a still-ACTIVE position's live-tracking fields —
   * the new peak-favorable price, a trailing-stop adjustment
   * (stopLossSpot + trailStage), and/or the one-time stale-exit target
   * reduction (targetSpot + staleAdjusted). Written to the DB the instant
   * they change (not just held in memory) so every level survives a
   * restart of this service — the next tick simply re-reads it from
   * `findActivePositions()`.
   */
  async updateActivePosition(
    id: string,
    data: Partial<{
      peakSpot: number;
      stopLossSpot: number;
      targetSpot: number;
      trailStage: TrailStage;
      staleAdjusted: boolean;
    }>,
  ): Promise<void> {
    await this.prisma.tradeSignal.update({ where: { id }, data });
  }

  /** Every signal generated today (any status), newest first — powers the live dashboard table. */
  async findToday(): Promise<TradeSignal[]> {
    return this.prisma.tradeSignal.findMany({
      where: { dateString: this.todayIso() },
      orderBy: { timestamp: 'desc' },
    });
  }

  /** Filtered, paginated historical query — powers the /archive screen. */
  async findArchive(query: ArchiveQueryDto): Promise<ArchiveResult> {
    const where: Prisma.TradeSignalWhereInput = {
      ...(query.status && { currentStatus: query.status }),
      ...(query.direction && { direction: query.direction }),
      ...(query.expiryType && { expiryType: query.expiryType }),
      ...((query.dateFrom || query.dateTo) && {
        dateString: {
          ...(query.dateFrom && { gte: query.dateFrom }),
          ...(query.dateTo && { lte: query.dateTo }),
        },
      }),
    };

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.tradeSignal.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.tradeSignal.count({ where }),
    ]);

    return { items, total, limit, offset };
  }
}
