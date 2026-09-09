import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Direction, TradeSignal, TradeStatus, TrailStage } from '@prisma/client';
import { MarketDataService } from '../market-data/market-data.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TradesService, ExitStatus } from './trades.service';
import { isIndianMarketOpen } from '../common/market-hours.util';
import { TRADE_STATUS_CHANGED_EVENT, TradeStatusChangedPayload } from './trade-events';

const MS_PER_MINUTE = 60_000;

/**
 * Fast secondary ticker — every 10 seconds, independent of the 60s strategy
 * cron — that re-evaluates every currently ACTIVE position against the live
 * Nifty spot price. Three things happen here, in order, per position:
 *
 *  1. Exit check — has the position's *current* target or stop-loss (which
 *     may since have been trailed) been crossed? If so, resolve it and move
 *     on; nothing below applies to an already-resolved position.
 *  2. Dynamic Profit Protection — has favorable movement earned the stop a
 *     ratchet up to breakeven, or further to a locked-in partial profit?
 *     See `applyTrailingStop()`.
 *  3. Stale-position handling — has the position gone stale (open too long,
 *     in profit, momentum stalled) and, if so, does it need its target
 *     pulled in or an outright forced exit? See `applyStaleExitRule()`.
 *
 * Every level change is persisted immediately (TradesService.updateActivePosition)
 * so it survives a restart of this service, and every adjustment/exit fires
 * both the existing WebSocket broadcast and the NotificationsService hook.
 */
@Injectable()
export class PositionMonitorService {
  private readonly logger = new Logger(PositionMonitorService.name);
  private readonly symbol: string;
  private readonly lotSize: number;
  private readonly deltaProxy: number;

  // --- Dynamic Profit Protection (trailing stop) ----------------------------
  private readonly trailBreakevenAtrMult: number;
  private readonly trailProfitLockAtrMult: number;
  private readonly trailProfitLockFraction: number;

  // --- Stale-position time exit ----------------------------------------------
  private readonly staleExitMinutes: number;
  private readonly staleTargetReductionPct: number;
  private readonly staleMinFavorableAtrMult: number;

  /** Guards against overlapping ticks if a fetch/DB round-trip runs long. */
  private isTicking = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly marketDataService: MarketDataService,
    private readonly tradesService: TradesService,
    private readonly notificationsService: NotificationsService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.symbol = this.configService.get<string>('NIFTY_SYMBOL', '^NSEI');
    this.lotSize = Number(this.configService.get<string>('LOT_SIZE', '65'));
    this.deltaProxy = Number(this.configService.get<string>('DELTA_PROXY', '0.5'));

    this.trailBreakevenAtrMult = Number(this.configService.get<string>('TRAIL_BREAKEVEN_ATR_MULT', '1.0'));
    this.trailProfitLockAtrMult = Number(this.configService.get<string>('TRAIL_PROFIT_LOCK_ATR_MULT', '1.5'));
    this.trailProfitLockFraction = Number(this.configService.get<string>('TRAIL_PROFIT_LOCK_FRACTION', '0.75'));

    this.staleExitMinutes = Number(this.configService.get<string>('STALE_EXIT_MINUTES', '30'));
    this.staleTargetReductionPct = Number(this.configService.get<string>('STALE_TARGET_REDUCTION_PCT', '0.30'));
    this.staleMinFavorableAtrMult = Number(this.configService.get<string>('STALE_MIN_FAVORABLE_ATR_MULT', '0.5'));
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
        await this.trackPosition(position, livePrice);
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

  /** Runs the full per-position pipeline (exit check → trailing stop → stale-exit rule) for one tick. */
  private async trackPosition(position: TradeSignal, livePrice: number): Promise<void> {
    // Step 1 — best-favorable price so far, updated whether or not this tick
    // also resolves the position (a resolving tick is, by construction, at
    // least as favorable as the peak, so it always folds in cleanly here).
    const peakSpot = this.computePeakSpot(position.direction, position.entrySpotPrice, position.peakSpot, livePrice);

    // Step 2 — has the position's *current* (possibly already-trailed)
    // target/stop-loss been crossed? Resolve and stop — nothing below
    // applies once a position is no longer ACTIVE.
    const outcome = this.evaluateExit(position, livePrice);
    if (outcome) {
      await this.resolve(position, outcome, livePrice, peakSpot);
      return;
    }

    if (peakSpot !== position.peakSpot) {
      await this.tradesService.updateActivePosition(position.id, { peakSpot });
    }

    // Legacy rows created before ATR-based sizing existed have no atr14 to
    // scale the trailing/stale rules off — leave them on the plain
    // fixed-level target/stop-loss check above, nothing more.
    if (position.atr14 === null) {
      return;
    }

    // Step 3 — Dynamic Profit Protection: ratchet the stop-loss toward
    // (and past) breakeven as favorable movement deepens.
    const trailed = this.applyTrailingStop(position, peakSpot);
    if (trailed) {
      await this.tradesService.updateActivePosition(position.id, {
        stopLossSpot: trailed.stopLossSpot,
        trailStage: trailed.trailStage,
      });
      this.logger.log(
        `Position ${position.id} (${position.direction} ${position.strikePrice}) trailing stop → ${trailed.trailStage} — stop-loss moved to ${trailed.stopLossSpot.toFixed(2)}`,
      );
      void this.notificationsService.send(
        `🔧 *Trailing stop adjusted*\n${position.direction} ${position.strikePrice} — stage → *${trailed.trailStage}*\nNew stop-loss: ${trailed.stopLossSpot.toFixed(2)} (spot)`,
      );
    }

    // Step 4 — stale-position handling: only relevant once the position has
    // actually been open for a while.
    const holdMinutes = (Date.now() - new Date(position.timestamp).getTime()) / MS_PER_MINUTE;
    if (holdMinutes < this.staleExitMinutes) {
      return;
    }

    const staleOutcome = await this.applyStaleExitRule(position, livePrice, holdMinutes);
    if (staleOutcome) {
      await this.resolve(position, TradeStatus.TIME_EXIT, livePrice, peakSpot);
    }
  }

  /**
   * Boundary check against the position's *current* target/stop-loss
   * (which trailing may since have moved). Distinguishes STOPLOSS_HIT (the
   * original entry-time risk stop) from TRAIL_STOP_HIT (a stop that had
   * already been ratcheted into breakeven-or-better) purely from
   * `trailStage` — the comparison itself is identical either way.
   */
  private evaluateExit(position: TradeSignal, livePrice: number): ExitStatus | null {
    const { direction, targetSpot, stopLossSpot, trailStage } = position;
    const stopLossOutcome: ExitStatus = trailStage === TrailStage.NONE ? TradeStatus.STOPLOSS_HIT : TradeStatus.TRAIL_STOP_HIT;

    if (direction === Direction.CALL) {
      if (livePrice >= targetSpot) return TradeStatus.TARGET_HIT;
      if (livePrice <= stopLossSpot) return stopLossOutcome;
    } else {
      if (livePrice <= targetSpot) return TradeStatus.TARGET_HIT;
      if (livePrice >= stopLossSpot) return stopLossOutcome;
    }
    return null;
  }

  /**
   * REQUIREMENT 1 (Trailing Breakeven) + REQUIREMENT 2 (Dynamic Profit
   * Lock). Both are expressed as "only ever improve stopLossSpot" via
   * max (CALL) / min (PUT) against the position's *current* stop, so
   * they compose safely regardless of which thresholds have already
   * fired, and the stop can never be loosened by a later, less-favorable
   * tick. The trigger itself is evaluated off `peakSpot` (the best price
   * ever seen), not the current tick's `livePrice` — a brief spike to
   * +1.5x ATR that has since pulled back to +1.1x ATR must still lock in
   * the profit it earned; only the *level* is a fixed absolute distance
   * from entry, not proportional to how far past the trigger price ran.
   *
   * Returns the new (stopLossSpot, trailStage) pair only when something
   * actually changed — null means no adjustment was needed this tick.
   */
  private applyTrailingStop(
    position: TradeSignal,
    peakSpot: number,
  ): { stopLossSpot: number; trailStage: TrailStage } | null {
    const { direction, entrySpotPrice, atr14, stopLossSpot, trailStage } = position;
    if (atr14 === null) return null;

    const isCall = direction === Direction.CALL;
    const peakFavorablePoints = isCall ? peakSpot - entrySpotPrice : entrySpotPrice - peakSpot;

    let candidateStopLoss = stopLossSpot;
    let candidateStage = trailStage;

    // Breakeven shield — pull the stop to entry once +1.0x ATR is reached.
    if (peakFavorablePoints >= atr14 * this.trailBreakevenAtrMult) {
      candidateStopLoss = isCall ? Math.max(candidateStopLoss, entrySpotPrice) : Math.min(candidateStopLoss, entrySpotPrice);
      if (candidateStage === TrailStage.NONE) candidateStage = TrailStage.BREAKEVEN;
    }

    // Profit lock — pull the stop further, to entry ± 0.75x ATR of
    // *guaranteed* profit, once +1.5x ATR is reached. Supersedes breakeven.
    if (peakFavorablePoints >= atr14 * this.trailProfitLockAtrMult) {
      const lockLevel = entrySpotPrice + (isCall ? 1 : -1) * atr14 * this.trailProfitLockFraction;
      candidateStopLoss = isCall ? Math.max(candidateStopLoss, lockLevel) : Math.min(candidateStopLoss, lockLevel);
      candidateStage = TrailStage.PROFIT_LOCK;
    }

    const stopLossImproved = isCall ? candidateStopLoss > stopLossSpot : candidateStopLoss < stopLossSpot;
    if (!stopLossImproved && candidateStage === trailStage) {
      return null; // Nothing crossed a new threshold this tick.
    }

    return { stopLossSpot: candidateStopLoss, trailStage: candidateStage };
  }

  /**
   * REQUIREMENT 3 (Time-Based Stale Exit). Only reached once the position
   * has been open >= staleExitMinutes. Two independent effects, both
   * one-shot / idempotent:
   *
   *   a) If still in profit and target was never reduced before, pull the
   *      target in by staleTargetReductionPct (default 30%) — a stalled
   *      move is less likely to still reach the original, more ambitious
   *      target, so give it a nearer one it can actually hit. Fires once
   *      per position (`staleAdjusted` guards re-shrinking it every tick).
   *   b) Regardless of (a), if the *current* favorable move has slipped
   *      back below staleMinFavorableAtrMult x ATR (default 0.5x) — i.e.
   *      the position is giving back the very edge that made it "stale but
   *      in profit" in the first place — force an immediate market exit
   *      (TIME_EXIT) rather than let a stalled trade round-trip into a
   *      full loss.
   *
   * "Momentum has stalled" is inferred from reaching this function at all:
   * the exit check above already confirmed target/stop-loss weren't hit,
   * so a still-ACTIVE position past its stale window has, by definition,
   * neither resolved nor kept running toward target.
   *
   * Returns true when the position should be force-exited this tick.
   */
  private async applyStaleExitRule(position: TradeSignal, livePrice: number, holdMinutes: number): Promise<boolean> {
    const { id, direction, entrySpotPrice, targetSpot, atr14, staleAdjusted } = position;
    if (atr14 === null) return false;

    const isCall = direction === Direction.CALL;
    const favorablePoints = isCall ? livePrice - entrySpotPrice : entrySpotPrice - livePrice;

    // (a) One-time 30% target-distance reduction, only while still in profit.
    if (!staleAdjusted && favorablePoints > 0) {
      const originalTargetDistance = Math.abs(targetSpot - entrySpotPrice);
      const reducedDistance = originalTargetDistance * (1 - this.staleTargetReductionPct);
      const newTarget = entrySpotPrice + (isCall ? 1 : -1) * reducedDistance;

      await this.tradesService.updateActivePosition(id, { targetSpot: newTarget, staleAdjusted: true });
      this.logger.log(
        `Position ${id} (${direction} ${position.strikePrice}) stale after ${holdMinutes.toFixed(0)}m — target pulled in ${(this.staleTargetReductionPct * 100).toFixed(0)}% to ${newTarget.toFixed(2)}`,
      );
      void this.notificationsService.send(
        `⏱️ *Stale position — target reduced*\n${direction} ${position.strikePrice} — open ${holdMinutes.toFixed(0)}m, momentum stalled.\nTarget pulled in to ${newTarget.toFixed(2)} (spot).`,
      );
    }

    // (b) Force exit if the favorable move has slipped back under the floor.
    if (favorablePoints < atr14 * this.staleMinFavorableAtrMult) {
      this.logger.log(
        `Position ${id} (${direction} ${position.strikePrice}) stale + giving back profit (${favorablePoints.toFixed(1)}pts < ${(atr14 * this.staleMinFavorableAtrMult).toFixed(1)}pts floor) — forcing TIME_EXIT at market`,
      );
      void this.notificationsService.send(
        `🚪 *Time-decay exit*\n${direction} ${position.strikePrice} — open ${holdMinutes.toFixed(0)}m, gave back profit below the ${this.staleMinFavorableAtrMult}x ATR floor.\nExiting at market (${livePrice}).`,
      );
      return true;
    }

    return false;
  }

  /**
   * Resolves a position (any terminal status), persisting the exit and
   * broadcasting it over both channels — the existing WebSocket event (for
   * the dashboard's live exit toast) and the notification hook.
   */
  private async resolve(position: TradeSignal, status: ExitStatus, livePrice: number, peakSpot: number): Promise<void> {
    const netCashINR = this.computeNetCashINR(position.direction, position.entrySpotPrice, livePrice);
    const updated = await this.tradesService.resolvePosition(position.id, status, livePrice, peakSpot, netCashINR);

    this.logger.log(
      `Position ${updated.id} (${updated.direction} ${updated.strikePrice}) resolved → ${status} at spot ${livePrice} (₹${netCashINR})`,
    );

    const payload: TradeStatusChangedPayload = { signal: updated, livePrice, netCashINR };
    this.eventEmitter.emit(TRADE_STATUS_CHANGED_EVENT, payload);

    const emoji = netCashINR >= 0 ? '✅' : '🛑';
    void this.notificationsService.send(
      `${emoji} *Position closed — ${status}*\n${updated.direction} ${updated.strikePrice} @ spot ${livePrice}\nP&L: ₹${netCashINR}`,
    );
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
   * Exact realized cash P&L for 1 lot, signed by the *actual* index-point
   * move between entry and the resolving tick — optionPoints × lotSize.
   * Deriving the sign from the real move (rather than a per-outcome lookup)
   * is both simpler and correct for every exit path here: TARGET_HIT and
   * TRAIL_STOP_HIT only ever fire on the favorable side, STOPLOSS_HIT only
   * on the unfavorable side, and TIME_EXIT can legitimately land on either
   * side of entry — this formula gets all four right without special-casing.
   */
  private computeNetCashINR(direction: Direction, entrySpotPrice: number, resolvedSpot: number): number {
    const favorablePoints = direction === Direction.CALL ? resolvedSpot - entrySpotPrice : entrySpotPrice - resolvedSpot;
    return Math.round(favorablePoints * this.deltaProxy * this.lotSize);
  }
}
