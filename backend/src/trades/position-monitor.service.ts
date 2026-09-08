import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Direction, TradeStatus } from '@prisma/client';
import { MarketDataService } from '../market-data/market-data.service';
import { TradesService } from './trades.service';
import { isIndianMarketOpen } from '../common/market-hours.util';
import { TRADE_STATUS_CHANGED_EVENT, TradeStatusChangedPayload } from './trade-events';

type ExitOutcome = typeof TradeStatus.TARGET_HIT | typeof TradeStatus.STOPLOSS_HIT;

/**
 * Fast secondary ticker — every 10 seconds, independent of the 60s strategy
 * cron — that re-evaluates every currently ACTIVE position against the live
 * Nifty spot price and flips it to TARGET_HIT / STOPLOSS_HIT the moment its
 * boundary is crossed. Emits an internal event on every resolution so the
 * realtime gateway can broadcast it to connected dashboards immediately,
 * without waiting for the next poll.
 */
@Injectable()
export class PositionMonitorService {
  private readonly logger = new Logger(PositionMonitorService.name);
  private readonly symbol: string;
  private readonly lotSize: number;
  private readonly deltaProxy: number;
  /** Guards against overlapping ticks if a fetch/DB round-trip runs long. */
  private isTicking = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly marketDataService: MarketDataService,
    private readonly tradesService: TradesService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.symbol = this.configService.get<string>('NIFTY_SYMBOL', '^NSEI');
    this.lotSize = Number(this.configService.get<string>('LOT_SIZE', '65'));
    this.deltaProxy = Number(this.configService.get<string>('DELTA_PROXY', '0.5'));
  }

  @Interval(10_000)
  async handleTick(): Promise<void> {
    if (!isIndianMarketOpen()) {
      return; // No point tracking exits while the market is shut.
    }
    if (this.isTicking) {
      this.logger.debug('Previous position-monitor tick still running — skipping overlap.');
      return;
    }
    this.isTicking = true;

    try {
      const activePositions = await this.tradesService.findActivePositions();
      if (activePositions.length === 0) {
        return; // Nothing to track — skip the spot fetch entirely.
      }

      const livePrice = await this.marketDataService.fetchLiveSpot(this.symbol);

      for (const position of activePositions) {
        // The best-favorable price so far — highest since entry for a CALL,
        // lowest for a PUT — updated whether or not this tick also resolves
        // the position (a resolving tick is, by construction, at least as
        // favorable as the peak, so it always folds in cleanly here).
        const peakSpot = this.computePeakSpot(position.direction, position.entrySpotPrice, position.peakSpot, livePrice);

        const outcome = this.evaluateExit(position.direction, livePrice, position.targetSpot, position.stopLossSpot);

        if (!outcome) {
          if (peakSpot !== position.peakSpot) {
            await this.tradesService.updatePeakSpot(position.id, peakSpot);
          }
          continue;
        }

        const updated = await this.tradesService.resolvePosition(position.id, outcome, livePrice, peakSpot);
        const netCashINR = this.computeNetCashINR(outcome, position.entrySpotPrice, livePrice);
        this.logger.log(
          `Position ${updated.id} (${updated.direction} ${updated.strikePrice}) resolved → ${outcome} at spot ${livePrice} (₹${netCashINR})`,
        );

        const payload: TradeStatusChangedPayload = { signal: updated, livePrice, netCashINR };
        this.eventEmitter.emit(TRADE_STATUS_CHANGED_EVENT, payload);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Position-monitor tick failed: ${message}`);
      // Swallow after logging: a transient Yahoo Finance/DB hiccup must
      // never crash this interval or leave active positions unwatched
      // beyond a single tick — the next 10s tick simply retries.
    } finally {
      this.isTicking = false;
    }
  }

  /** Boundary check per the strategy's fixed exit rules. */
  private evaluateExit(
    direction: Direction,
    livePrice: number,
    targetSpot: number,
    stopLossSpot: number,
  ): ExitOutcome | null {
    if (direction === Direction.CALL) {
      if (livePrice >= targetSpot) return TradeStatus.TARGET_HIT;
      if (livePrice <= stopLossSpot) return TradeStatus.STOPLOSS_HIT;
    } else {
      if (livePrice <= targetSpot) return TradeStatus.TARGET_HIT;
      if (livePrice >= stopLossSpot) return TradeStatus.STOPLOSS_HIT;
    }
    return null;
  }

  /**
   * The most favorable spot price seen so far — the running max for a CALL
   * (higher is better), the running min for a PUT (lower is better) —
   * starting from `entrySpotPrice` the first time a position is checked.
   */
  private computePeakSpot(direction: Direction, entrySpotPrice: number, currentPeak: number | null, livePrice: number): number {
    const baseline = currentPeak ?? entrySpotPrice;
    return direction === Direction.CALL ? Math.max(baseline, livePrice) : Math.min(baseline, livePrice);
  }

  /**
   * Exact realized cash P&L for 1 lot, from the *actual* index-point move
   * between entry and the resolving tick — optionPoints × lotSize. Since
   * exit distances are now ATR-sized per signal rather than a fixed point
   * count, this is computed off the real prices rather than a global
   * constant (and it's exact either way: a resolving tick can slightly
   * overshoot the target/SL threshold between 10s checks).
   */
  private computeNetCashINR(outcome: ExitOutcome, entrySpotPrice: number, resolvedSpot: number): number {
    const indexPoints = Math.abs(resolvedSpot - entrySpotPrice);
    const cash = Math.round(indexPoints * this.deltaProxy * this.lotSize);
    return outcome === TradeStatus.TARGET_HIT ? cash : -cash;
  }
}
