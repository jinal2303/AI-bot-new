import { Injectable, Logger } from '@nestjs/common';
import { Direction, ExpiryType, Prisma, TargetBasis, TradeSignal, TradeStatus, TrailStage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getISTDateParts, toISTIsoDate } from '../common/ist-time.util';
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

  /**
   * Count of today's signals currently resolved at the given status — the
   * input to the daily loss circuit breaker (counts STOPLOSS_HIT) and
   * available generically for any other same-day status breakdown (e.g. a
   * future win-rate widget) without a new method per status.
   */
  async countTodayByStatus(status: TradeStatus): Promise<number> {
    return this.prisma.tradeSignal.count({ where: { dateString: this.todayIso(), currentStatus: status } });
  }

  /**
   * SESSION WINDOW UPPER LIMITS — count of today's signals *opened*
   * (`timestamp`) within a given [startMinutes, endMinutes) IST
   * minutes-since-midnight range — the input to SignalsService's per-window
   * entry cap (Morning/Mid-Day/Afternoon). Done in application code rather
   * than a raw-SQL timezone EXTRACT: today's row count is always small
   * (bounded by the daily cap), and every other IST time-of-day calculation
   * in this codebase already goes through `getISTDateParts()` — one source
   * of truth for the UTC+5:30 conversion instead of a second one in SQL.
   */
  async countTodayInWindow(startMinutes: number, endMinutes: number): Promise<number> {
    const todaysTimestamps = await this.prisma.tradeSignal.findMany({
      where: { dateString: this.todayIso() },
      select: { timestamp: true },
    });

    return todaysTimestamps.filter(({ timestamp }) => {
      const { hour, minute } = getISTDateParts(timestamp);
      const minutesSinceMidnight = hour * 60 + minute;
      return minutesSinceMidnight >= startMinutes && minutesSinceMidnight < endMinutes;
    }).length;
  }

  /** True if there is currently any position still being tracked. */
  async hasActivePosition(): Promise<boolean> {
    const active = await this.prisma.tradeSignal.findFirst({
      where: { currentStatus: TradeStatus.ACTIVE },
      select: { id: true },
    });
    return active !== null;
  }

  /**
   * 10-MINUTE RE-ENTRY COOLDOWN GUARD — when the most recently *resolved*
   * (any terminal status: TARGET_HIT / TRAIL_STOP_HIT / STOPLOSS_HIT /
   * TIME_EXIT) trade in this direction closed. Not restricted to today's
   * `dateString` — a trade resolved in the last few minutes of one session
   * should still cool down a same-direction signal in the first minutes of
   * the next tick cycle. Returns null if no trade in this direction has
   * ever resolved. See SignalsService's re-entry cooldown check.
   */
  async mostRecentResolutionTime(direction: Direction): Promise<Date | null> {
    const last = await this.prisma.tradeSignal.findFirst({
      where: { direction, currentStatus: { not: TradeStatus.ACTIVE }, resolvedAt: { not: null } },
      orderBy: { resolvedAt: 'desc' },
      select: { resolvedAt: true },
    });
    return last?.resolvedAt ?? null;
  }

  /**
   * DAILY LOSS CIRCUIT BREAKER (total) — count of today's resolved trades
   * with a negative realized `netCashINR`, regardless of which terminal
   * status they closed at. Broader than `countTodayByStatus(STOPLOSS_HIT)`:
   * a STOPLOSS_HIT is always a loss, but a TIME_EXIT can legitimately close
   * negative too (see TIME_EXIT's doc in schema.prisma) — this counts every
   * losing trade, not just full-risk-stop ones.
   */
  async countTodayLosses(): Promise<number> {
    return this.prisma.tradeSignal.count({
      where: { dateString: this.todayIso(), netCashINR: { lt: 0 } },
    });
  }

  /**
   * DAILY LOSS CIRCUIT BREAKER (consecutive) — how many of today's most
   * recently resolved trades, walking backward from the latest, resolved
   * STOPLOSS_HIT in an unbroken streak. Stops counting at the first
   * trade (if any) that resolved some other way — a TARGET_HIT or
   * TRAIL_STOP_HIT in between breaks the streak, same as it would for a
   * human reading the day's trade log back-to-front.
   */
  async consecutiveStoplossHits(): Promise<number> {
    const todaysResolved = await this.prisma.tradeSignal.findMany({
      where: { dateString: this.todayIso(), resolvedAt: { not: null } },
      orderBy: { resolvedAt: 'desc' },
      select: { currentStatus: true },
    });

    let streak = 0;
    for (const trade of todaysResolved) {
      if (trade.currentStatus !== TradeStatus.STOPLOSS_HIT) break;
      streak++;
    }
    return streak;
  }

  /**
   * GLOBAL LOSS COOLDOWN — when the most recently resolved trade in EITHER
   * direction closed with a negative `netCashINR`. Not restricted to
   * today's `dateString`, same reasoning as `mostRecentResolutionTime()` —
   * a loss in the last minutes of one session should still cool down
   * fresh entries in the first minutes of the next tick cycle. Returns
   * null if no trade has ever closed at a loss. Unlike
   * `mostRecentResolutionTime()` (which is per-direction and fires on ANY
   * resolution, win or loss), this is direction-agnostic and fires only on
   * a loss — see SignalsService's re-entry cooldown check.
   */
  async mostRecentLossTime(): Promise<Date | null> {
    const last = await this.prisma.tradeSignal.findFirst({
      where: { netCashINR: { lt: 0 }, resolvedAt: { not: null } },
      orderBy: { resolvedAt: 'desc' },
      select: { resolvedAt: true },
    });
    return last?.resolvedAt ?? null;
  }

  /**
   * SAME-STRIKE LOSS BLACKLIST — when this exact (strikePrice, direction)
   * combination — e.g. 23,400 PE — most recently resolved STOPLOSS_HIT. Not
   * restricted to today's `dateString`, same reasoning as
   * `mostRecentResolutionTime()`. Returns null if this strike+direction has
   * never hit its original risk stop. See SignalsService's blacklist check —
   * a fresh setup on the SAME strike is rejected until STRIKE_BLACKLIST_MINUTES
   * has elapsed since this timestamp, so the bot doesn't immediately
   * re-enter the exact strike that just stopped it out in a choppy zone.
   */
  async mostRecentStoplossHitTime(strikePrice: number, direction: Direction): Promise<Date | null> {
    const last = await this.prisma.tradeSignal.findFirst({
      where: { strikePrice, direction, currentStatus: TradeStatus.STOPLOSS_HIT, resolvedAt: { not: null } },
      orderBy: { resolvedAt: 'desc' },
      select: { resolvedAt: true },
    });
    return last?.resolvedAt ?? null;
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
        // Anchors target-progress milestone tracking and the scaled
        // profit-lock threshold — always equal to targetSpot at creation
        // (no revision has happened yet), so it's derived here rather than
        // asking every caller to pass the same value twice.
        initialTargetSpot: input.targetSpot,
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
   * (stopLossSpot + trailStage), the one-time stale-exit target reduction
   * (targetSpot + staleAdjusted), and/or a newly-crossed target-progress
   * milestone (lastNotifiedMilestonePct). Written to the DB the instant
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
      lastNotifiedMilestonePct: number;
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
