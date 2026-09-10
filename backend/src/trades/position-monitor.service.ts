import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Direction, TradeSignal, TradeStatus, TrailStage } from '@prisma/client';
import { MarketDataService } from '../market-data/market-data.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TradesService, ExitStatus } from './trades.service';
import { isIndianMarketOpen, minutesUntilMarketClose } from '../common/market-hours.util';
import { TARGET_MILESTONE_EVENT, TRADE_STATUS_CHANGED_EVENT, TargetMilestonePayload, TradeStatusChangedPayload } from './trade-events';

const MS_PER_MINUTE = 60_000;

/** 10%-wide target-progress bands notified once each — see `checkTargetMilestones()`. 100% is TARGET_HIT itself, already covered by its own exit notification. */
const MILESTONE_PERCENTAGES = [30, 40, 50, 60, 70, 80, 90] as const;

/**
 * Fast secondary ticker — every 10 seconds, independent of the 60s strategy
 * cron — that re-evaluates every currently ACTIVE position against the live
 * Nifty spot price. Per position, in order:
 *
 *  1. Exit check — has the position's *current* target or trailed-stop been
 *     crossed? Resolve and stop; nothing below applies once it's no longer ACTIVE.
 *  2. Target-progress milestones — pure notification side effect (never
 *     triggers an exit) — see `checkTargetMilestones()`.
 *  3. Mandatory EOD square-off — 15 min before the 15:30 IST close,
 *     unconditional. See below.
 *  4. Dynamic Profit Protection — ratchet the stop-loss to breakeven, then
 *     to a locked partial profit, as favorable movement deepens. See
 *     `applyTrailingStop()`.
 *  5. Dynamic Target Revision (peak giveback, scaled threshold) — lock in a
 *     strong-but-fading move before it round-trips. See
 *     `evaluateTargetRevisionExit()`.
 *  6. Stale-position handling — target pull-in / forced time exit once a
 *     position has gone quiet for too long. See `applyStaleExitRule()`.
 *
 * Every level change is persisted immediately (TradesService.updateActivePosition)
 * so it survives a restart of this service, and every adjustment/exit fires
 * both the WebSocket broadcast and the NotificationsService hook.
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

  // --- BREAKEVEN-LOCK-TRAP FIX ------------------------------------------------
  // See `applyTrailingStop()`: once favorable movement reaches this many x ATR
  // OR this many Nifty points (whichever comes first), the stop is no longer
  // allowed to sit flat at breakeven — it's floored at entry ± minLockProfitAtrMult.
  private readonly minLockTriggerAtrMult: number;
  private readonly minLockTriggerPoints: number;
  private readonly minLockProfitAtrMult: number;

  // --- Stale-position time exit ----------------------------------------------
  private readonly staleExitMinutes: number;
  private readonly staleTargetReductionPct: number;
  private readonly staleMinFavorableAtrMult: number;

  // --- Mandatory EOD square-off ------------------------------------------------
  private readonly eodSquareOffMinutesBeforeClose: number;

  // --- Dynamic target revision / peak giveback exit ----------------------------
  private readonly peakGivebackAtrMult: number;
  /** DYNAMIC PEAK GIVEBACK — absolute-points OR-trigger, alongside the scaled %-of-target threshold. See `evaluateTargetRevisionExit()`. */
  private readonly peakGivebackTriggerPoints: number;

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

    // BREAKEVEN-LOCK-TRAP FIX — defaults per spec: 1.3x ATR OR 20 Nifty
    // points triggers a floor of entry ± 0.5x ATR of guaranteed profit,
    // instead of the flat breakeven the trade would otherwise sit at.
    this.minLockTriggerAtrMult = Number(this.configService.get<string>('TRAIL_MIN_LOCK_TRIGGER_ATR_MULT', '1.3'));
    this.minLockTriggerPoints = Number(this.configService.get<string>('TRAIL_MIN_LOCK_TRIGGER_POINTS', '20'));
    this.minLockProfitAtrMult = Number(this.configService.get<string>('TRAIL_MIN_LOCK_PROFIT_ATR_MULT', '0.5'));

    this.staleExitMinutes = Number(this.configService.get<string>('STALE_EXIT_MINUTES', '30'));
    this.staleTargetReductionPct = Number(this.configService.get<string>('STALE_TARGET_REDUCTION_PCT', '0.30'));
    this.staleMinFavorableAtrMult = Number(this.configService.get<string>('STALE_MIN_FAVORABLE_ATR_MULT', '0.5'));

    // Tied to the exchange close (minutesUntilMarketClose), not a second
    // hardcoded clock — 15 min before 15:30 IST close = 15:15, the
    // mandatory intraday square-off cutoff.
    this.eodSquareOffMinutesBeforeClose = Number(this.configService.get<string>('EOD_SQUAREOFF_MINUTES_BEFORE_CLOSE', '15'));

    this.peakGivebackAtrMult = Number(this.configService.get<string>('PEAK_GIVEBACK_ATR_MULT', '0.5'));
    this.peakGivebackTriggerPoints = Number(this.configService.get<string>('PEAK_GIVEBACK_TRIGGER_POINTS', '30'));
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

  /**
   * Runs the full per-position pipeline for one tick — see the class-level
   * doc comment for the numbered steps. Each one returns early the moment
   * it resolves the position; nothing later in the pipeline applies to a
   * position that's no longer ACTIVE.
   */
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

    // Step 3 — target-progress milestones. Pure notification side effect —
    // never triggers an exit — so it runs unconditionally, ahead of every
    // exit-triggering rule below, off the *current* live price (not peak).
    await this.checkTargetMilestones(position, livePrice);

    // Step 4 — mandatory EOD square-off. Unconditional (doesn't need atr14)
    // and checked before every ATR-dependent rule below: "no overnight
    // rollover" is a hard constraint, not a volatility-scaled one. Firing
    // this tick means today's window (09:15–15:30 IST) has 15 minutes or
    // less left — force-close at market now rather than risk the position
    // monitor's own 10s cadence not catching it before the market shuts.
    if (minutesUntilMarketClose(new Date()) <= this.eodSquareOffMinutesBeforeClose) {
      await this.resolve(position, TradeStatus.TIME_EXIT, livePrice, peakSpot, 'mandatory EOD square-off — no overnight rollover');
      return;
    }

    // Legacy rows created before ATR-based sizing existed have no atr14 to
    // scale the trailing/stale/target-revision rules off — leave them on the
    // plain fixed-level target/stop-loss check (+ EOD square-off) above.
    if (position.atr14 === null) {
      return;
    }

    // Step 5 — Dynamic Profit Protection: ratchet the stop-loss toward
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
      void this.notificationsService.notifyTrailingStopAdjusted(position, trailed.trailStage, trailed.stopLossSpot);
    }

    // Step 6 — Dynamic Target Revision (scaled peak-giveback exit): a
    // supplementary protective layer on top of the stop-loss ratchet above.
    // The ratchet only moves the *level* stopLossSpot sits at; this instead
    // reacts directly to the shape of the move — a position that got most
    // of the way to target and then reversed shouldn't have to wait for
    // price to fall all the way back to whatever the current stop happens
    // to be.
    const revision = this.evaluateTargetRevisionExit(position, livePrice, peakSpot);
    if (revision) {
      await this.resolve(position, TradeStatus.TRAIL_STOP_HIT, livePrice, peakSpot, `Target Revised & Profit Locked at ${revision.lockedPct}%`);
      return;
    }

    // Step 7 — stale-position handling: only relevant once the position has
    // actually been open for a while.
    const holdMinutes = (Date.now() - new Date(position.timestamp).getTime()) / MS_PER_MINUTE;
    if (holdMinutes < this.staleExitMinutes) {
      return;
    }

    const staleOutcome = await this.applyStaleExitRule(position, livePrice, holdMinutes);
    if (staleOutcome) {
      await this.resolve(position, TradeStatus.TIME_EXIT, livePrice, peakSpot, 'stale position — profit decayed below the giveback floor');
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
   * TARGET PROGRESS MILESTONES (30% → 90%, in 10% bands). Measured against
   * `initialTargetSpot` — the target exactly as set at creation — rather
   * than the live `targetSpot`, so a later stale-exit target reduction
   * doesn't retroactively shift what "50% of the way there" means mid-trade.
   *
   *   progressPct = (currentFavorableDistance / initialTargetDistance) × 100
   *
   * `lastNotifiedMilestonePct` (persisted on the row) is the guard against
   * re-notifying the same band on every subsequent 10s tick. Every band
   * strictly between what's already been notified and the current progress
   * fires its own notification — so a fast move that jumps clean over more
   * than one band between two ticks (e.g. a gap from 25% to 65%) still
   * notifies each of 30/40/50/60 individually rather than silently
   * collapsing them into one — before the persisted high-water mark is
   * advanced to the highest band reached, in a single DB write.
   */
  private async checkTargetMilestones(position: TradeSignal, livePrice: number): Promise<void> {
    const { direction, entrySpotPrice, initialTargetSpot, lastNotifiedMilestonePct } = position;
    if (initialTargetSpot === null) return; // Legacy row — no stable anchor to measure progress against.

    const initialTargetDistance = Math.abs(initialTargetSpot - entrySpotPrice);
    if (initialTargetDistance === 0) return;

    const isCall = direction === Direction.CALL;
    const currentFavorableDistance = isCall ? livePrice - entrySpotPrice : entrySpotPrice - livePrice;
    const progressPct = (currentFavorableDistance / initialTargetDistance) * 100;

    const newlyCrossed = MILESTONE_PERCENTAGES.filter(
      (milestone) => milestone > lastNotifiedMilestonePct && progressPct >= milestone,
    );
    if (newlyCrossed.length === 0) return;

    const highest = newlyCrossed[newlyCrossed.length - 1];
    await this.tradesService.updateActivePosition(position.id, { lastNotifiedMilestonePct: highest });

    for (const milestone of newlyCrossed) {
      this.logger.log(
        `Position ${position.id} (${direction} ${position.strikePrice}) reached ${milestone}% of target (${progressPct.toFixed(1)}% actual)`,
      );
      const payload: TargetMilestonePayload = { signal: { ...position, lastNotifiedMilestonePct: highest }, milestonePct: milestone, progressPct, livePrice };
      this.eventEmitter.emit(TARGET_MILESTONE_EVENT, payload);
      void this.notificationsService.notifyTargetMilestone(position, milestone, progressPct, livePrice);
    }
  }

  /**
   * REQUIREMENT — Trailing Breakeven + Breakeven-Lock-Trap Fix + Dynamic
   * Profit Lock, in three ratcheting stages:
   *   1. +1.0x ATR  → stop → flat breakeven (entry).
   *   2. +1.3x ATR OR +20 Nifty points (whichever first) → stop → entry ±
   *      0.5x ATR of *guaranteed* profit (see the breakeven-lock-trap fix
   *      block below) — a trade that ran this far no longer sits at flat
   *      ₹0 on a pullback.
   *   3. +1.5x ATR → stop → entry ± 0.75x ATR (supersedes both above).
   * All three are expressed as "only ever improve stopLossSpot" via max
   * (CALL) / min (PUT) against the position's *current* stop, so they
   * compose safely regardless of which thresholds have already fired, and
   * the stop can never be loosened by a later, less-favorable tick. The
   * trigger itself is evaluated off `peakSpot` (the best price ever seen),
   * not the current tick's `livePrice` — a brief spike to +1.5x ATR that
   * has since pulled back to +1.1x ATR must still lock in the profit it
   * earned; only the *level* is a fixed absolute distance from entry, not
   * proportional to how far past the trigger price ran.
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

    // --- BREAKEVEN-LOCK-TRAP FIX -------------------------------------------
    // Holding the stop at a flat breakeven (₹0 profit) once a trade has run
    // well past the breakeven trigger wastes real, already-earned gains — a
    // pullback all the way to entry gives back movement that was there for
    // the taking. Once favorable movement reaches minLockTriggerAtrMult x ATR
    // (default 1.3x) OR minLockTriggerPoints Nifty points (default 20,
    // whichever comes first), floor the stop at entry ± minLockProfitAtrMult
    // x ATR (default 0.5x) of *guaranteed* profit instead of flat breakeven.
    // Composes safely with both neighbors via max/min: never loosens a stop
    // the breakeven shield or profit-lock stage below already set tighter.
    if (peakFavorablePoints >= atr14 * this.minLockTriggerAtrMult || peakFavorablePoints >= this.minLockTriggerPoints) {
      const minLockLevel = entrySpotPrice + (isCall ? 1 : -1) * atr14 * this.minLockProfitAtrMult;
      candidateStopLoss = isCall ? Math.max(candidateStopLoss, minLockLevel) : Math.min(candidateStopLoss, minLockLevel);
      if (candidateStage === TrailStage.NONE || candidateStage === TrailStage.BREAKEVEN) candidateStage = TrailStage.PROFIT_LOCK;
    }

    // Profit lock — pull the stop further, to entry ± 0.75x ATR of
    // *guaranteed* profit, once +1.5x ATR is reached. Supersedes breakeven
    // and the minimum-lock floor above (both are floors this only ever improves on).
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
   * Scaled profit-lock threshold, tiered by the trade's entry-time target
   * payoff (targetCashINR) — a smaller setup needs to travel a larger
   * fraction of its own (already-modest) target before a reversal is worth
   * banking early; a bigger payoff can afford to wait for less of it before
   * locking in, since even a partial capture is still meaningful cash.
   *
   *   ₹1,000 – ₹1,500  → 70% of target distance
   *   ₹1,501 – ₹2,999  → 60%
   *   ≥ ₹3,000         → 50%
   *
   * `targetCashINR` isn't a persisted column — it's fully derived here from
   * `initialTargetDistance × deltaProxy × lotSize`, the exact formula
   * SignalsService used to compute it at signal-creation time, so it can
   * never drift out of sync with the levels actually stored on the row.
   */
  private resolveTargetRevisionThresholdPct(targetCashINR: number): number {
    if (targetCashINR >= 3000) return 0.5;
    if (targetCashINR >= 1501) return 0.6;
    return 0.7; // covers ₹1,000–₹1,500, and any edge case below (MIN_TARGET_CASH_INR should prevent that from occurring)
  }

  /**
   * DYNAMIC TARGET REVISION & PEAK PROFIT LOCK (scaled thresholds) — a
   * supplementary protective layer, independent of the stopLossSpot ratchet
   * above. The trailing stop only protects once price has moved a fixed
   * multiple of ATR; a move that got most of the way to *target* but is
   * still short of even the breakeven trigger would otherwise be left
   * completely unprotected while it gives that whole move back. This closes
   * that gap directly off the move's shape instead of a fixed level:
   *
   *   1. Compute the scaled threshold for this trade's payoff size (see
   *      `resolveTargetRevisionThresholdPct()`). The giveback-monitoring
   *      gate opens once EITHER peak favorable movement has reached that
   *      fraction of the distance to the *original* target
   *      (`initialTargetSpot`, not the live one, so a stale-exit reduction
   *      never lowers this bar after the fact), OR peak favorable movement
   *      has reached `peakGivebackTriggerPoints` (default 30) Nifty points
   *      outright — a large absolute move deserves giveback protection even
   *      on a big-target trade where 30pts is still short of the scaled %
   *      threshold. If neither is met, the move never got interesting
   *      enough for a reversal to matter here — the ordinary
   *      stop-loss/trailing-stop logic handles it alone.
   *   2. If so, has price since given back more than `peakGivebackAtrMult`
   *      x ATR(14) (default 0.5x) from that peak? If so, revise the target
   *      down to what was actually achieved and exit immediately at market
   *      to lock in what's left of the move, rather than risk it fully
   *      erasing before the (further-away) stop-loss level is reached.
   *
   * Resolves as TRAIL_STOP_HIT — like a trailed stop, this is a
   * profit-protection exit, not a hit on the original risk stop; by
   * construction it only fires after real favorable progress (>= the
   * scaled threshold), so it lands on the winning side in the overwhelming
   * majority of cases, though — same as any tick-based check — an
   * unusually large single-tick reversal could in principle still land it
   * slightly negative of entry.
   */
  private evaluateTargetRevisionExit(
    position: TradeSignal,
    livePrice: number,
    peakSpot: number,
  ): { lockedPct: number } | null {
    const { direction, entrySpotPrice, initialTargetSpot, atr14 } = position;
    if (atr14 === null || initialTargetSpot === null) return null;

    const initialTargetDistance = Math.abs(initialTargetSpot - entrySpotPrice);
    if (initialTargetDistance === 0) return null;

    const targetCashINR = Math.round(initialTargetDistance * this.deltaProxy * this.lotSize);
    const requiredThresholdPct = this.resolveTargetRevisionThresholdPct(targetCashINR);

    const isCall = direction === Direction.CALL;
    const peakFavorableDistance = isCall ? peakSpot - entrySpotPrice : entrySpotPrice - peakSpot;
    const peakProgressFraction = peakFavorableDistance / initialTargetDistance;
    // DYNAMIC PEAK GIVEBACK GATE — scaled %-of-target threshold OR a flat
    // absolute-points trigger, whichever opens the gate first.
    const gateOpen = peakProgressFraction >= requiredThresholdPct || peakFavorableDistance >= this.peakGivebackTriggerPoints;
    if (!gateOpen) {
      return null; // Never reached either threshold — leave it to the ordinary stop-loss/trailing-stop logic.
    }

    const currentFavorableDistance = isCall ? livePrice - entrySpotPrice : entrySpotPrice - livePrice;
    const givebackPoints = peakFavorableDistance - currentFavorableDistance;
    if (givebackPoints <= atr14 * this.peakGivebackAtrMult) {
      return null; // Hasn't reversed enough yet.
    }

    return { lockedPct: Math.round(peakProgressFraction * 100) };
  }

  /**
   * REQUIREMENT — Time-Based Stale Exit. Only reached once the position has
   * been open >= staleExitMinutes. Two independent effects, both one-shot /
   * idempotent:
   *
   *   a) If still in profit and target was never reduced before, pull the
   *      target in by staleTargetReductionPct (default 30%) — a stalled
   *      move is less likely to still reach the original, more ambitious
   *      target, so give it a nearer one it can actually hit. Fires once
   *      per position (`staleAdjusted` guards re-shrinking it every tick).
   *      Note this only ever touches the *live* `targetSpot`, never
   *      `initialTargetSpot` — the milestone/target-revision math above
   *      stays anchored to the original regardless.
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
      void this.notificationsService.notifyStaleTargetReduced(position, holdMinutes, newTarget);
    }

    // (b) Force exit if the favorable move has slipped back under the floor.
    if (favorablePoints < atr14 * this.staleMinFavorableAtrMult) {
      this.logger.log(
        `Position ${id} (${direction} ${position.strikePrice}) stale + giving back profit (${favorablePoints.toFixed(1)}pts < ${(atr14 * this.staleMinFavorableAtrMult).toFixed(1)}pts floor) — forcing TIME_EXIT at market`,
      );
      void this.notificationsService.notifyStaleForceExit(position, holdMinutes, livePrice);
      return true;
    }

    return false;
  }

  /**
   * Resolves a position (any terminal status), persisting the exit and
   * broadcasting it over both channels — the existing WebSocket event (for
   * the dashboard's live exit toast) and the notification hook.
   */
  private async resolve(
    position: TradeSignal,
    status: ExitStatus,
    livePrice: number,
    peakSpot: number,
    reason?: string,
  ): Promise<void> {
    const netCashINR = this.computeNetCashINR(position.direction, position.entrySpotPrice, livePrice);
    const updated = await this.tradesService.resolvePosition(position.id, status, livePrice, peakSpot, netCashINR);

    this.logger.log(
      `Position ${updated.id} (${updated.direction} ${updated.strikePrice}) resolved → ${status}${reason ? ` (${reason})` : ''} at spot ${livePrice} (₹${netCashINR})`,
    );

    const payload: TradeStatusChangedPayload = { signal: updated, livePrice, netCashINR, reason };
    this.eventEmitter.emit(TRADE_STATUS_CHANGED_EVENT, payload);

    void this.notificationsService.notifyPositionClosed(updated, status, livePrice, netCashINR, reason);
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
   * TRAIL_STOP_HIT almost always fire on the favorable side (see the
   * caveat on `evaluateTargetRevisionExit()`), STOPLOSS_HIT only on the
   * unfavorable side, and TIME_EXIT can legitimately land on either side of
   * entry — this formula gets all of them right without special-casing.
   */
  private computeNetCashINR(direction: Direction, entrySpotPrice: number, resolvedSpot: number): number {
    const favorablePoints = direction === Direction.CALL ? resolvedSpot - entrySpotPrice : entrySpotPrice - resolvedSpot;
    return Math.round(favorablePoints * this.deltaProxy * this.lotSize);
  }
}
