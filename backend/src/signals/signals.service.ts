import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { Direction, TradeStatus } from '@prisma/client';

/**
 * PRODUCTION MODE (default) — daily-trade-limit enforcement.
 *
 * `true`: both the daily signal-count cap (MAX_DAILY_SIGNALS) AND the
 * stop-loss daily kill switch (MAX_DAILY_STOPLOSS_HITS) below are enforced —
 * the bot trades the full day and halts itself once either limit trips. Set
 * to `false` only for unlimited bulk/live strategy verification runs, where
 * neither guard should throttle evaluation. `dailySignalCount` /
 * `stoplossHitCount` / `dailyLimitReached` / `lossCircuitBreakerTripped` are
 * still computed and returned on every snapshot either way (the dashboard
 * keeps showing real counts) — only the *halt* behavior is gated.
 *
 * Can be overridden per-environment via ENABLE_DAILY_LIMIT=true/false in
 * .env without touching code — see the constructor — but this constant is
 * the fail-safe source of truth when that env var is unset (a fresh deploy
 * that forgets to set it lands in production-safe mode, not silent
 * unlimited trading).
 */
const ENABLE_DAILY_LIMIT = true;
import { MarketDataService } from '../market-data/market-data.service';
import { IndicatorsService } from '../indicators/indicators.service';
import { ExpiryService } from '../expiry/expiry.service';
import { TradesService } from '../trades/trades.service';
import { TRADE_CREATED_EVENT, TradeCreatedPayload } from '../trades/trade-events';
import { getSessionWindow, isIndianMarketOpen, SESSION_WINDOW_BOUNDS, SessionWindow } from '../common/market-hours.util';
import { CandleBar, OptionType, ReactionLevel, SignalData, SignalDirection, TradeRules } from './signals.types';

/**
 * MARKET-MOVEMENT-FIRST SIGNAL ENGINE. On a schedule (and on-demand for the
 * very first request), fetches fresh Nifty 50 candles, derives SMA(9) /
 * RSI(14) / ATR(14) / ATR-expansion, decides whether a signal fires *purely*
 * off high-probability market-movement criteria, and caches exactly one
 * "latest" signal snapshot in memory for the API to serve. This is
 * deliberately NOT a quota-filling engine — every cap in this file (daily
 * count, daily stop-loss kill switch, per-session-window limits) is an
 * UPPER BOUND on how many trades may be taken, never a target to reach; a
 * quiet day that produces 0-3 actionable setups is expected and preferred
 * over forcing a trade to look "active". When a fresh, actionable setup
 * clears every quality filter AND every cap below, it persists a new
 * TradeSignal row, which is what the 10s position monitor and the
 * dashboard's today/archive views track from that point on.
 */
@Injectable()
export class SignalsService {
  private readonly logger = new Logger(SignalsService.name);

  private readonly symbol: string;
  private readonly strikeStep: number;
  /** SAFETY CAP — hard ceiling on trades/day, never exceeded regardless of configured value (see the desk's overtrading guard). This is an upper bound, not a quota to fill. */
  private readonly maxDailySignals: number;
  /**
   * SAFETY CAP — daily loss circuit breaker. Once this many signals resolve
   * STOPLOSS_HIT (the original, un-trailed risk stop) on the same IST
   * date, evaluation halts entirely for the rest of the day, same as the
   * daily signal-count throttle. TRAIL_STOP_HIT and TIME_EXIT don't count
   * here — neither is ever a full-risk loss. Also a hard ceiling, never
   * exceeded regardless of configured value.
   */
  private readonly maxDailyStoplossHits: number;
  /** TESTING MODE — see the `ENABLE_DAILY_LIMIT` module constant above for what this gates. */
  private readonly enableDailyLimit: boolean;

  /**
   * RE-ENTRY COOLDOWN GUARD — after ANY trade resolves (TARGET_HIT /
   * TRAIL_STOP_HIT / STOPLOSS_HIT / TIME_EXIT), a fresh setup in that
   * *same* direction is rejected for this many minutes, to stop rapid
   * overtrading back-to-back in one direction. See the cooldown check in
   * `refreshSignal()` and `TradesService.mostRecentResolutionTime()`.
   * Independent of `enableDailyLimit` — this guard stays active in testing
   * mode too, since it's a re-entry throttle, not a daily cap.
   */
  private readonly reentryCooldownMinutes: number;

  /**
   * SESSION WINDOW UPPER LIMITS — a separate cap on how many NEW positions
   * may be *opened* within each of the three named intraday windows (see
   * `SESSION_WINDOW_BOUNDS` in market-hours.util.ts), independent of the
   * overall daily cap above. Same "ceiling, not goal" philosophy: a window
   * with 0 qualifying setups takes 0 trades. Mid-Day's cap is deliberately
   * the tightest (the desk's choppiest stretch) and additionally requires
   * the stricter PIVOT-only structural confirmation — see
   * `passesStructuralReactionFilter()`'s `requirePivotLevel` param.
   */
  private readonly sessionWindowCaps: Record<SessionWindow, number>;

  /**
   * SAME-STRIKE LOSS BLACKLIST — after a trade resolves STOPLOSS_HIT, that
   * exact (strikePrice, direction) is rejected for this many minutes, so the
   * bot doesn't immediately re-enter the same strike in the same choppy
   * zone that just stopped it out. See the blacklist check in
   * `refreshSignal()` and `TradesService.mostRecentStoplossHitTime()`. Set
   * this well above a trading session's length (e.g. 999) to blacklist for
   * the rest of the day instead of a rolling window.
   */
  private readonly strikeBlacklistMinutes: number;

  // --- PIVOT & STRUCTURE REACTION ANALYSIS ------------------------------------
  /**
   * How close (in x ATR(14)) the latest 5m candle's wick must come to a
   * reaction level to count as a "bounce" (CALL) or "rejection" (PUT) off
   * it — see `passesStructuralReactionFilter()`.
   */
  private readonly structureReactionToleranceAtrMult: number;
  /**
   * Minimum distance (in x ATR(14)) a structural reaction level must offer
   * to qualify as `targetSpot`, snapping the target to it instead of the
   * plain symmetric ATR distance — see `resolveTargetPoints()`. Per spec,
   * tunable across 1.5x–2x ATR; defaults to 2x to preserve the desk's
   * existing 2:1 reward:risk guarantee (indexStopLossPoints defaults to 1x
   * ATR) — lower it toward 1.5x deliberately, not by accident, since that
   * trades a smaller guaranteed reward:risk floor for tighter, more
   * frequently-hit structural targets.
   */
  private readonly structureMinTargetAtrMult: number;

  // --- Risk protocol, fixed to 1 lot with an ATM delta proxy of 0.5 -----
  /** Contract units per lot (desk convention hardcoded per spec: 65). */
  private readonly lotSize: number;
  /** Proxy delta used to translate index-point moves into option premium moves. */
  private readonly deltaProxy: number;
  /**
   * Exit distances are no longer a fixed point count — they scale with the
   * market's own recent volatility: distance = ATR(14) × multiplier. A 2:1
   * target:stop-loss multiplier ratio is the standard volatility-sized
   * reward:risk convention (wider stops/targets in a choppy, high-ATR
   * market; tighter in a calm one) — tune via ATR_TARGET_MULTIPLIER /
   * ATR_STOPLOSS_MULTIPLIER.
   */
  private readonly atrTargetMultiplier: number;
  private readonly atrStopLossMultiplier: number;
  /**
   * DYNAMIC MIN-PROFIT FILTER — the target payoff (1 lot) a setup must
   * clear is no longer one fixed rupee figure. It's the greater of:
   *   - `minTargetCashFloorINR` — an absolute sanity floor (brokerage +
   *     slippage territory) below which a trade is never worth taking
   *     regardless of volatility, and
   *   - `atr14 x deltaProxy x lotSize x minTargetAtrFraction` — a figure
   *     that scales with the market's own current volatility and the
   *     desk's actual lot size/delta proxy.
   * A single fixed floor (the old ₹1000 default) becomes a near-total
   * blockade on a quiet-ATR day, since 2xATR-sized targets in cash terms
   * shrink well below it — this makes the bar track the setup's own
   * plausible payoff instead of an arbitrary constant. See the filter in
   * refreshSignal().
   */
  private readonly minTargetCashFloorINR: number;
  private readonly minTargetAtrFraction: number;

  // --- RSI DIRECTIONAL BANDS ---------------------------------------------
  /** Half-width of the true "no read" dead zone centered on RSI 50 — default 2 -> 48-52 is NO_SIGNAL regardless of spot/SMA9. */
  private readonly rsiNeutralHalfWidth: number;
  /** Hard upper/lower RSI cutoffs — beyond these, price is treated as too extended/exhausted to chase (mean-reversion risk outweighs continuation odds). */
  private readonly rsiMax: number;
  private readonly rsiMin: number;

  // --- MARKET-MOVEMENT-FIRST FILTER (softened) ----------------------------
  /** Minimum current-ATR14 ÷ ATR14-N-bars-ago ratio to count as "still expanding enough" — 1.0 is the old strict rule; below 1.0 tolerates a move that already happened and is now gently cooling rather than treating it as dead chop. */
  private readonly atrExpansionMinRatio: number;
  /** Absolute ATR14 floor (index points) that bypasses the expansion-ratio check entirely — if volatility is already this high in absolute terms, real movement is self-evidently underway regardless of the recent trend in ATR itself. */
  private readonly atrBaselinePoints: number;

  /**
   * SUSTAINED-TREND BYPASS — a second way to clear the structural-reaction
   * filter, alongside the level-touch check (`passesStructuralReactionFilter()`).
   * A steady, one-directional grind (SMA9/RSI14 agreeing bar after bar) can
   * run for a long stretch entirely inside the gap between two structural
   * levels, never producing a discrete breakout/breakdown/bounce/rejection
   * for the level-touch check to confirm against — legitimate trend, zero
   * confirmable "event". When BOTH hold: the trailing streak of strict
   * trend-agreement bars (`IndicatorsService.computeConsecutiveTrendBars()`,
   * 55/45 RSI threshold, not the widened entry band) is at least
   * `sustainedTrendMinBars`, AND ATR14 is at least `sustainedTrendAtrBaseline`
   * (high-conviction volatility, not a slow drift) — the level-touch
   * requirement is bypassed and the trade is allowed through on trend
   * conviction alone. See the STRUCTURAL_REACTION block in refreshSignal().
   */
  private readonly sustainedTrendMinBars: number;
  private readonly sustainedTrendAtrBaseline: number;

  /** In-memory cache of the most recently computed live snapshot. */
  private latestSignal: SignalData | null = null;
  /** Guards against overlapping cron executions if a fetch runs long. */
  private isRefreshing = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly marketDataService: MarketDataService,
    private readonly indicatorsService: IndicatorsService,
    private readonly expiryService: ExpiryService,
    private readonly tradesService: TradesService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.symbol = this.configService.get<string>('NIFTY_SYMBOL', '^NSEI');
    this.strikeStep = Number(this.configService.get<string>('STRIKE_STEP', '50'));

    const configuredMax = Number(this.configService.get<string>('MAX_DAILY_SIGNALS', '10'));
    // SAFETY CAP — hard-capped at 10 no matter what's configured (floor of
    // 1 so a misconfigured/zero value under-trades rather than disabling
    // evaluation entirely). This is a ceiling the market-movement-first
    // engine may never reach on a quiet day, not a quota it's trying to fill.
    this.maxDailySignals = Math.min(10, Math.max(1, Number.isFinite(configuredMax) ? configuredMax : 10));

    const configuredMaxStoplossHits = Number(this.configService.get<string>('MAX_DAILY_STOPLOSS_HITS', '4'));
    // SAFETY CAP — hard-capped at 4 no matter what's configured, same
    // ceiling/floor reasoning as maxDailySignals above.
    this.maxDailyStoplossHits = Math.min(4, Math.max(1, Number.isFinite(configuredMaxStoplossHits) ? configuredMaxStoplossHits : 4));

    // TESTING MODE — env override wins when set; otherwise falls back to the
    // ENABLE_DAILY_LIMIT constant at the top of this file.
    const dailyLimitOverride = this.configService.get<string>('ENABLE_DAILY_LIMIT');
    this.enableDailyLimit = dailyLimitOverride !== undefined ? dailyLimitOverride === 'true' : ENABLE_DAILY_LIMIT;
    if (!this.enableDailyLimit) {
      this.logger.warn(
        `⚠️  TESTING MODE: daily ${this.maxDailySignals}-trade cap and ${this.maxDailyStoplossHits}-stoploss kill switch are DISABLED (ENABLE_DAILY_LIMIT=false). Re-enable before trading live capital.`,
      );
    }

    // RE-ENTRY COOLDOWN — 15 minutes, per spec.
    this.reentryCooldownMinutes = Number(this.configService.get<string>('REENTRY_COOLDOWN_MINUTES', '15'));

    // SAME-STRIKE LOSS BLACKLIST default: 45 minutes, per spec.
    this.strikeBlacklistMinutes = Number(this.configService.get<string>('STRIKE_BLACKLIST_MINUTES', '45'));

    // SESSION WINDOW UPPER LIMITS — Morning 4 / Mid-Day 2 / Afternoon 4, per spec.
    this.sessionWindowCaps = {
      MORNING: Number(this.configService.get<string>('SESSION_CAP_MORNING', '4')),
      MIDDAY: Number(this.configService.get<string>('SESSION_CAP_MIDDAY', '2')),
      AFTERNOON: Number(this.configService.get<string>('SESSION_CAP_AFTERNOON', '4')),
    };

    // PIVOT & STRUCTURE REACTION ANALYSIS
    this.structureReactionToleranceAtrMult = Number(
      this.configService.get<string>('STRUCTURE_REACTION_TOLERANCE_ATR_MULT', '0.15'),
    );
    this.structureMinTargetAtrMult = Number(this.configService.get<string>('STRUCTURE_MIN_TARGET_ATR_MULT', '2'));

    this.lotSize = Number(this.configService.get<string>('LOT_SIZE', '65'));
    this.deltaProxy = Number(this.configService.get<string>('DELTA_PROXY', '0.5'));
    this.atrTargetMultiplier = Number(this.configService.get<string>('ATR_TARGET_MULTIPLIER', '2'));
    this.atrStopLossMultiplier = Number(this.configService.get<string>('ATR_STOPLOSS_MULTIPLIER', '1'));

    // DYNAMIC MIN-PROFIT FILTER — replaces the old fixed MIN_TARGET_CASH_INR.
    // Floor default (₹650 = 10 CE/PE option points × the 65 lot size) is the
    // minimum anticipated option-premium move a setup must offer to be worth
    // taking — raised from the old ₹300 (~4-5pts) brokerage/slippage-only
    // floor, which let through setups too thin to be worth the entry; the
    // ATR-scaled fraction (0.5 default) is what actually tracks whether
    // *this* setup's sized target pays out enough on a more volatile day.
    this.minTargetCashFloorINR = Number(this.configService.get<string>('MIN_TARGET_CASH_FLOOR_INR', '650'));
    this.minTargetAtrFraction = Number(this.configService.get<string>('MIN_TARGET_ATR_FRACTION', '0.5'));

    // RSI DIRECTIONAL BANDS
    this.rsiNeutralHalfWidth = Number(this.configService.get<string>('RSI_NEUTRAL_HALFWIDTH', '2'));
    this.rsiMax = Number(this.configService.get<string>('RSI_MAX', '85'));
    this.rsiMin = Number(this.configService.get<string>('RSI_MIN', '15'));

    // MARKET-MOVEMENT-FIRST FILTER — tightened from 0.9 to 1.05 (2026-09-16):
    // 0.9 tolerated ATR that was already flat/cooling, which let through
    // setups with fading momentum that only carried a few points before
    // reversing. 1.05 requires ATR14 to still be genuinely expanding (not
    // just elevated) relative to ~30 min ago, favoring setups more likely to
    // keep running.
    this.atrExpansionMinRatio = Number(this.configService.get<string>('ATR_EXPANSION_MIN_RATIO', '1.05'));
    this.atrBaselinePoints = Number(this.configService.get<string>('ATR_BASELINE_POINTS', '12'));

    // SUSTAINED-TREND BYPASS
    this.sustainedTrendMinBars = Number(this.configService.get<string>('SUSTAINED_TREND_MIN_BARS', '3'));
    this.sustainedTrendAtrBaseline = Number(this.configService.get<string>('SUSTAINED_TREND_ATR_BASELINE', '15'));
  }

  /**
   * Cron tick — fires every 60 seconds, but only does real work during
   * Indian market hours (09:15–15:30 IST, Mon–Fri) to avoid hammering
   * Yahoo Finance while the market is closed.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'nifty-signal-refresh' })
  async handleScheduledRefresh(): Promise<void> {
    if (!isIndianMarketOpen()) {
      this.logger.debug('Market closed — skipping scheduled signal refresh.');
      return;
    }
    await this.refreshSignal();
  }

  /**
   * Returns the cached latest signal, computing one on-demand the first
   * time it's requested (e.g. right after server boot, before the first
   * cron tick has fired) so the endpoint never returns an empty body.
   */
  async getLatestSignal(): Promise<SignalData> {
    if (!this.latestSignal) {
      await this.refreshSignal();
    }
    // refreshSignal() guarantees latestSignal is populated on success; if it
    // failed, it throws — so this branch only remains unreachable on error.
    return this.latestSignal as SignalData;
  }

  /**
   * Fetches candles, computes indicators, evaluates the strategy, persists
   * a new TradeSignal when a fresh actionable setup clears the daily
   * throttle and active-position guards, and updates the in-memory "latest
   * snapshot" cache. Wrapped in try/catch so a transient Yahoo Finance/DB
   * outage never crashes the process or the cron scheduler.
   */
  private async refreshSignal(): Promise<void> {
    if (this.isRefreshing) {
      this.logger.debug('Refresh already in progress — skipping overlapping tick.');
      return;
    }
    this.isRefreshing = true;

    // FILTER-LEVEL AUDIT TRAIL — one entry per checkpoint this tick passes
    // through, PASS or REJECT, with the numbers behind that call. Declared
    // outside the try{} so a thrown error mid-evaluation still has whatever
    // trace accumulated so far available to log. See SignalData.rejectionTrace.
    const trace: string[] = [];

    try {
      // --- Daily overtrading guard + loss circuit breaker -----------------
      // Both checked BEFORE any indicator work — either one tripped skips
      // the Yahoo Finance call entirely, not just the trade-creation step.
      // TESTING MODE: dailyLimitReached/lossCircuitBreakerTripped are still
      // computed for the dashboard either way — `enableDailyLimit` only
      // gates whether either one actually halts evaluation below.
      const dailySignalCount = await this.tradesService.countToday();
      const stoplossHitCount = await this.tradesService.countTodayByStatus(TradeStatus.STOPLOSS_HIT);
      const dailyLimitReached = dailySignalCount >= this.maxDailySignals;
      const lossCircuitBreakerTripped = stoplossHitCount >= this.maxDailyStoplossHits;

      if (this.enableDailyLimit && (dailyLimitReached || lossCircuitBreakerTripped)) {
        const reason = lossCircuitBreakerTripped
          ? `Daily loss circuit breaker tripped (${stoplossHitCount}/${this.maxDailyStoplossHits} stop-losses hit)`
          : `Daily signal limit reached (${dailySignalCount}/${this.maxDailySignals})`;
        trace.push(`DAILY_HALT: REJECT — ${reason}`);
        this.logger.warn(`${reason} — halting evaluation until tomorrow.`);
        this.latestSignal = this.latestSignal
          ? {
              ...this.latestSignal,
              dailySignalCount,
              maxDailySignals: this.maxDailySignals,
              dailyLimitReached,
              stoplossHitCount,
              maxDailyStoplossHits: this.maxDailyStoplossHits,
              lossCircuitBreakerTripped,
              rejectionTrace: trace,
            }
          : this.buildFallbackSignal(dailySignalCount, dailyLimitReached, false, stoplossHitCount, lossCircuitBreakerTripped, trace);
        return;
      }
      trace.push('DAILY_HALT: PASS');

      const candles = await this.marketDataService.fetchFiveMinuteCandles(this.symbol);
      const snapshot = this.indicatorsService.computeSnapshot(candles);
      const series = this.indicatorsService.computeSeries(candles);
      const atmStrike = this.indicatorsService.computeAtmStrike(snapshot.spot, this.strikeStep);
      const expiry = this.expiryService.computeExpiryTarget();
      const dailyLevels = this.indicatorsService.computeDailyLevels(candles);
      // PIVOT & STRUCTURE REACTION ANALYSIS ENGINE — the dynamic array of
      // structural levels (daily floor pivots + intraday 5m swing-high/low
      // clusters) consumed by both the entry filter below and the
      // target-snap inside buildTradeRules() -> resolveTargetPoints().
      const reactionLevels = this.indicatorsService.computeReactionLevels(candles, dailyLevels, snapshot.atr14);
      // SUSTAINED-TREND BYPASS — trailing streak of strict trend-agreement
      // bars, feeding the structural-reaction filter's fallback below.
      const trendBars = this.indicatorsService.computeConsecutiveTrendBars(candles);
      // SESSION WINDOW UPPER LIMITS — which named window (if any) "now"
      // falls in. Computed once, reused below by both the Mid-Day stricter
      // structural-confirmation rule and the per-window cap filter.
      const currentWindow = getSessionWindow(new Date());

      let { signal, optionType } = this.evaluateStrategy(snapshot.spot, snapshot.sma9, snapshot.rsi14, trace);

      // --- MARKET-MOVEMENT-FIRST FILTER: ATR expansion (softened) ---------
      // The SMA/RSI read alone can't tell a genuine breakout from a flat
      // chop that happens to sit in the right zone. Two independent ways to
      // pass, either is enough:
      //   1. RATIO — current ATR14 is at least `atrExpansionMinRatio` x its
      //      reading ~30 min ago (default 0.9 — tolerates a move that's
      //      already underway and gently cooling, not just strictly rising).
      //   2. BASELINE — ATR14 is already above `atrBaselinePoints` in
      //      absolute terms, so real movement is self-evidently present
      //      regardless of the recent trend in ATR itself (e.g. a fast
      //      crash that's now consolidating at an elevated ATR reading).
      // Only fails, and downgrades to NO_SIGNAL, when NEITHER passes.
      if (signal !== 'NO_SIGNAL') {
        const ratioPass = snapshot.atrExpansionRatio >= this.atrExpansionMinRatio;
        const baselinePass = snapshot.atr14 >= this.atrBaselinePoints;
        if (ratioPass || baselinePass) {
          trace.push(
            `ATR_EXPANSION: PASS — ratio=${snapshot.atrExpansionRatio.toFixed(2)} (min ${this.atrExpansionMinRatio}${ratioPass ? ', met' : ' — missed'}) atr14=${snapshot.atr14.toFixed(2)} (baseline ${this.atrBaselinePoints}${baselinePass ? ', met' : ' — missed'})`,
          );
        } else {
          trace.push(
            `ATR_EXPANSION: REJECT — ${signal} — ratio=${snapshot.atrExpansionRatio.toFixed(2)} < min ${this.atrExpansionMinRatio} AND atr14=${snapshot.atr14.toFixed(2)} < baseline ${this.atrBaselinePoints}`,
          );
          this.logger.debug(`Signal downgraded to NO_SIGNAL — ${signal} lacks ATR expansion (no real market movement underway)`);
          signal = 'NO_SIGNAL';
          optionType = null;
        }
      }

      // --- STRUCTURAL PIVOT-REACTION FILTER -------------------------------
      // The SMA/RSI read above only says "the trend direction looks right";
      // it says nothing about *where* price actually is relative to the
      // levels the rest of the market is watching. Require confirmation —
      // a breakout/bounce for a CALL, a breakdown/rejection for a PUT — off
      // a real reaction level before taking the setup at all. Applied
      // universally (was Mid-Day-only): the reacted-off level must be a
      // genuine daily floor pivot OR a FALLBACK level (session VWAP /
      // morning high-low — see `IndicatorsService.computeReactionLevels()`),
      // not just a locally-detected intraday swing cluster (kind 'SWING') —
      // see `passesStructuralReactionFilter()`'s `requirePivotLevel` param.
      // Tightened from Mid-Day-only to every window (2026-09-16): swing-only
      // confirmations were letting through setups that only carried 1.5-8pts
      // of real follow-through before reversing — pivot/VWAP/morning-range
      // levels are what the wider market actually reacts off of, so
      // requiring one everywhere favors setups more likely to travel far
      // enough to matter, at the cost of fewer signals overall.
      const requirePivotLevel = true;
      if (signal !== 'NO_SIGNAL') {
        const levelTouchPass = this.passesStructuralReactionFilter(signal, candles, reactionLevels, snapshot.atr14, requirePivotLevel);

        if (levelTouchPass) {
          trace.push(`STRUCTURAL_REACTION: PASS (LEVEL_TOUCH) — ${signal} (PIVOT/FALLBACK only)`);
        } else {
          // SUSTAINED-TREND BYPASS — see the field docs on
          // sustainedTrendMinBars/sustainedTrendAtrBaseline above. A steady
          // one-directional grind inside the gap between two levels never
          // produces a level-touch event, but can still be a perfectly
          // valid trade on trend conviction alone.
          const relevantStreak = signal === 'BUY CALL (CE)' ? trendBars.consecutiveBullishBars : trendBars.consecutiveBearishBars;
          const streakPass = relevantStreak >= this.sustainedTrendMinBars;
          const atrPass = snapshot.atr14 >= this.sustainedTrendAtrBaseline;

          if (streakPass && atrPass) {
            trace.push(
              `STRUCTURAL_REACTION: PASS (SUSTAINED_TREND_BYPASS — ${relevantStreak} consecutive bars, atr14=${snapshot.atr14.toFixed(2)} >= ${this.sustainedTrendAtrBaseline})`,
            );
            this.logger.debug(
              `${signal} cleared via sustained-trend bypass — ${relevantStreak} consecutive trend-agreement bars, ATR14=${snapshot.atr14.toFixed(2)}`,
            );
          } else {
            trace.push(
              `STRUCTURAL_REACTION: REJECT — No level reaction and sustained trend count < ${this.sustainedTrendMinBars} (streak=${relevantStreak}, atr14=${snapshot.atr14.toFixed(2)}, needs atr>=${this.sustainedTrendAtrBaseline})`,
            );
            this.logger.debug(
              `Signal downgraded to NO_SIGNAL — ${signal} lacks structural confirmation (no breakout/breakdown/bounce/rejection at a key${requirePivotLevel ? ' floor-pivot/VWAP/morning-range' : ''} reaction level, and trend streak ${relevantStreak} < ${this.sustainedTrendMinBars} or ATR14 ${snapshot.atr14.toFixed(2)} < ${this.sustainedTrendAtrBaseline})`,
            );
            signal = 'NO_SIGNAL';
            optionType = null;
          }
        }
      }

      let tradeRules = this.buildTradeRules(signal, snapshot.spot, snapshot.atr14, reactionLevels);

      // --- Minimum-profit filter (dynamic) ---------------------------------
      // A setup that technically clears the RSI/SMA/R:R bars but only pays
      // out a small amount (thin ATR, target capped by a nearby pivot) may
      // not be worth the 1-lot brokerage/slippage overhead. The bar itself
      // now scales with the market's own volatility instead of one fixed
      // rupee figure — see `minTargetCashFloorINR` / `minTargetAtrFraction`
      // field docs. Downgrade to NO_SIGNAL rather than take it, same as any
      // other disqualified read, so it never reaches trade-creation below.
      if (tradeRules !== null) {
        const dynamicMinTargetCashINR = this.round(
          Math.max(this.minTargetCashFloorINR, snapshot.atr14 * this.deltaProxy * this.lotSize * this.minTargetAtrFraction),
        );
        if (tradeRules.targetCashINR < dynamicMinTargetCashINR) {
          trace.push(
            `MIN_PROFIT: REJECT — target ₹${tradeRules.targetCashINR} < dynamic min ₹${dynamicMinTargetCashINR} (floor ₹${this.minTargetCashFloorINR}, ATR-scaled ₹${this.round(snapshot.atr14 * this.deltaProxy * this.lotSize * this.minTargetAtrFraction)})`,
          );
          this.logger.debug(
            `Signal downgraded to NO_SIGNAL — target payoff ₹${tradeRules.targetCashINR} is below the ₹${dynamicMinTargetCashINR} dynamic minimum`,
          );
          signal = 'NO_SIGNAL';
          optionType = null;
          tradeRules = null;
        } else {
          trace.push(`MIN_PROFIT: PASS — target ₹${tradeRules.targetCashINR} >= dynamic min ₹${dynamicMinTargetCashINR}`);
        }
      }

      // --- RE-ENTRY COOLDOWN GUARD (15 minutes) ---------------------------
      // Blocks rapid overtrading in the same direction (e.g. three PUT
      // trades back-to-back within 18 minutes): once a trade in a given
      // direction has resolved (any terminal status), a fresh setup in that
      // *same* direction is downgraded to NO_SIGNAL until reentryCooldownMinutes
      // has elapsed since that resolution. The opposite direction is
      // unaffected — only same-direction re-entry is throttled.
      if (optionType !== null && tradeRules !== null) {
        const desiredDirection = optionType === 'CE' ? Direction.CALL : Direction.PUT;
        const lastResolvedAt = await this.tradesService.mostRecentResolutionTime(desiredDirection);
        const cooldownMs = this.reentryCooldownMinutes * 60_000;
        const elapsedMs = lastResolvedAt ? Date.now() - lastResolvedAt.getTime() : Infinity;

        if (elapsedMs < cooldownMs) {
          const remainingMinutes = ((cooldownMs - elapsedMs) / 60_000).toFixed(1);
          trace.push(`REENTRY_COOLDOWN: REJECT — ${desiredDirection} — ${remainingMinutes}m remaining of ${this.reentryCooldownMinutes}m`);
          this.logger.debug(
            `Signal downgraded to NO_SIGNAL — ${desiredDirection} re-entry cooldown active (${remainingMinutes}m remaining)`,
          );
          signal = 'NO_SIGNAL';
          optionType = null;
          tradeRules = null;
        } else {
          trace.push(`REENTRY_COOLDOWN: PASS — ${desiredDirection}`);
        }
      }

      // --- SAME-STRIKE LOSS BLACKLIST --------------------------------------
      // Prevents re-entering the exact strike (e.g. 23,400 PE) that most
      // recently stopped this bot out at its original risk stop — a choppy
      // zone that hit one strike's stop-loss is very likely to do it again
      // within the blacklist window. Only STOPLOSS_HIT blacklists a strike;
      // TARGET_HIT/TRAIL_STOP_HIT/TIME_EXIT don't, since those aren't losses.
      if (optionType !== null && tradeRules !== null) {
        const desiredDirection = optionType === 'CE' ? Direction.CALL : Direction.PUT;
        const lastStoplossHitAt = await this.tradesService.mostRecentStoplossHitTime(atmStrike, desiredDirection);
        const blacklistMs = this.strikeBlacklistMinutes * 60_000;
        const elapsedSinceStoplossMs = lastStoplossHitAt ? Date.now() - lastStoplossHitAt.getTime() : Infinity;

        if (elapsedSinceStoplossMs < blacklistMs) {
          const remainingMinutes = ((blacklistMs - elapsedSinceStoplossMs) / 60_000).toFixed(1);
          const strikeKey = `${atmStrike}_${desiredDirection === Direction.CALL ? 'CALL' : 'PUT'}`;
          trace.push(`STRIKE_BLACKLIST: REJECT — ${strikeKey} — ${remainingMinutes}m remaining of ${this.strikeBlacklistMinutes}m`);
          this.logger.debug(
            `Signal downgraded to NO_SIGNAL — strike ${strikeKey} is blacklisted after a recent STOPLOSS_HIT (${remainingMinutes}m remaining)`,
          );
          signal = 'NO_SIGNAL';
          optionType = null;
          tradeRules = null;
        } else {
          trace.push(`STRIKE_BLACKLIST: PASS — ${atmStrike}_${desiredDirection === Direction.CALL ? 'CALL' : 'PUT'}`);
        }
      }

      // --- SESSION WINDOW UPPER LIMITS (caps, not goals) -------------------
      // A supplementary throttle to the overall daily cap: how many NEW
      // positions have already been opened within the *current* named
      // window (Morning 09:15–10:30 max 4 / Mid-Day 10:30–13:15 max 2 /
      // Afternoon 13:15–15:15 max 4)? A window with 0 qualifying setups
      // simply takes 0 trades — this only ever blocks, never fills, a
      // window's remaining headroom. Outside all three windows (the
      // 15:15–15:30 EOD-only tail) no new entries are allowed at all,
      // regardless of the daily/window counts.
      if (optionType !== null && tradeRules !== null) {
        if (currentWindow === null) {
          trace.push('SESSION_WINDOW_CAP: REJECT — outside every session window (past 15:15 IST, EOD square-off only)');
          this.logger.debug('Signal downgraded to NO_SIGNAL — outside every session window (past 15:15 IST, EOD square-off only)');
          signal = 'NO_SIGNAL';
          optionType = null;
          tradeRules = null;
        } else {
          const { startMinutes, endMinutes } = SESSION_WINDOW_BOUNDS[currentWindow];
          const windowCount = await this.tradesService.countTodayInWindow(startMinutes, endMinutes);
          const windowCap = this.sessionWindowCaps[currentWindow];

          if (windowCount >= windowCap) {
            trace.push(`SESSION_WINDOW_CAP: REJECT — ${currentWindow} — ${windowCount}/${windowCap} already opened`);
            this.logger.debug(
              `Signal downgraded to NO_SIGNAL — ${currentWindow} session window cap reached (${windowCount}/${windowCap})`,
            );
            signal = 'NO_SIGNAL';
            optionType = null;
            tradeRules = null;
          } else {
            trace.push(`SESSION_WINDOW_CAP: PASS — ${currentWindow} — ${windowCount}/${windowCap}`);
          }
        }
      }

      // --- Persist a new position, if this tick actually opens one -------
      // Only when the strategy is actionable AND nothing is already being
      // tracked — the bot holds exactly one open position at a time; the
      // 10s monitor resolves it before a new one can be created.
      const hasActivePosition = await this.tradesService.hasActivePosition();
      if (optionType !== null && tradeRules !== null && hasActivePosition) {
        trace.push('ACTIVE_POSITION: REJECT — a position is already open, only one at a time');
      }
      if (optionType !== null && tradeRules !== null && !hasActivePosition) {
        trace.push(`ACTIVE_POSITION: PASS — creating ${optionType} @ ${atmStrike}`);
        const created = await this.tradesService.createSignal({
          direction: optionType === 'CE' ? Direction.CALL : Direction.PUT,
          strikePrice: atmStrike,
          expiryType: expiry.cycle,
          entrySpotPrice: tradeRules.entryPrice,
          stopLossSpot: tradeRules.indexStopLoss,
          targetSpot: tradeRules.indexTarget,
          atr14: tradeRules.atr14,
          targetBasis: tradeRules.targetBasis,
        });

        this.logger.log(
          `Opened at ATR(14)=${snapshot.atr14.toFixed(2)} → target ${tradeRules.indexTargetPoints.toFixed(1)}pts (${tradeRules.targetBasis}) / SL ${tradeRules.indexStopLossPoints.toFixed(1)}pts`,
        );

        // Broadcast immediately — the frontend's entry-alert notification
        // fires off this WebSocket event rather than waiting on its next
        // /today poll (up to 30s later).
        const payload: TradeCreatedPayload = { signal: created };
        this.eventEmitter.emit(TRADE_CREATED_EVENT, payload);
      }

      // Re-count after a possible creation above, so the snapshot always
      // reflects the true up-to-date daily count and active-position state.
      const [refreshedCount, refreshedHasActive] = await Promise.all([
        this.tradesService.countToday(),
        this.tradesService.hasActivePosition(),
      ]);

      // A live-snapshot "event" is only new when the actual strategy read
      // changes — direction, option side, or ATM strike. Reuse the same
      // id/generatedAt across ticks where the same read simply persists, so
      // the frontend (which notifies on a new id) fires exactly one desktop
      // alert per event instead of re-notifying on every 30s poll.
      const isSameSignalEvent =
        this.latestSignal !== null &&
        this.latestSignal.signal === signal &&
        this.latestSignal.optionType === optionType &&
        this.latestSignal.atmStrike === atmStrike;

      const id = isSameSignalEvent ? this.latestSignal!.id : randomUUID();
      const generatedAt = isSameSignalEvent ? this.latestSignal!.generatedAt : new Date().toISOString();

      const dayChange = this.round(snapshot.spot - dailyLevels.prevClose);
      const dayChangePercent = this.round((dayChange / dailyLevels.prevClose) * 100);

      this.latestSignal = {
        id,
        generatedAt,
        symbol: this.symbol,
        spot: this.round(snapshot.spot),
        dayChange,
        dayChangePercent,
        sma9: this.round(snapshot.sma9),
        rsi14: this.round(snapshot.rsi14),
        atr14: this.round(snapshot.atr14),
        atmStrike,
        optionType,
        signal,
        expiry,
        tradeRules,
        marketOpen: isIndianMarketOpen(),
        series,
        dailyLevels,
        dailySignalCount: refreshedCount,
        maxDailySignals: this.maxDailySignals,
        dailyLimitReached: refreshedCount >= this.maxDailySignals,
        // Not re-fetched: only the 10s position monitor ever changes a
        // STOPLOSS_HIT count, never this cron tick itself, so the value
        // read at the top of this tick is still accurate here.
        stoplossHitCount,
        maxDailyStoplossHits: this.maxDailyStoplossHits,
        lossCircuitBreakerTripped,
        hasActivePosition: refreshedHasActive,
        rejectionTrace: trace,
      };

      this.logger.log(
        `Signal refreshed → ${signal} | spot=${this.latestSignal.spot} sma9=${this.latestSignal.sma9} rsi14=${this.latestSignal.rsi14} atr14=${this.latestSignal.atr14} atm=${atmStrike} expiry=${expiry.cycle} dailyCount=${refreshedCount}/${this.maxDailySignals}${this.enableDailyLimit ? '' : ' (limit disabled — TESTING MODE)'} active=${refreshedHasActive}`,
      );
      // FILTER-LEVEL AUDIT TRAIL — full per-checkpoint trace for this tick,
      // always logged (not just on rejection) so "why did/didn't this fire"
      // is answerable from server logs without re-deriving it from the
      // individual debug lines scattered above. Also mirrored onto
      // SignalData.rejectionTrace for the same audit from the API/dashboard.
      this.logger.debug(`Filter trace:\n  ${trace.join('\n  ')}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Signal refresh failed: ${message}`);
      // Deliberately swallow the error after logging: a failed refresh must
      // never crash the cron scheduler or the HTTP request that triggered
      // an on-demand refresh. The previous cached signal (if any) is kept
      // as-is so the frontend keeps showing the last known-good state; if
      // nothing has ever succeeded, we surface a NO_SIGNAL placeholder.
      if (!this.latestSignal) {
        this.latestSignal = this.buildFallbackSignal(0, false, false, 0, false, trace);
      }
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Signal decision rule — ONE continuous RSI band per direction instead of
   * two disjoint bands with a dead gap between them:
   *  - BULLISH: spot > SMA9 AND (50 + rsiNeutralHalfWidth) <= RSI14 <= rsiMax
   *    -> BUY CALL (CE)      [defaults: 52 <= RSI14 <= 85]
   *  - BEARISH: spot < SMA9 AND rsiMin <= RSI14 <= (50 - rsiNeutralHalfWidth)
   *    -> BUY PUT (PE)       [defaults: 15 <= RSI14 <= 48]
   *  - Otherwise -> NO_SIGNAL: RSI sits in the tight 48-52 true-neutral
   *    zone (no directional edge either way), OR beyond rsiMax/rsiMin —
   *    extreme exhaustion territory where a reversal bounce is too likely
   *    to chase.
   *
   * The old two-band design (a 55-65/35-45 "corridor" plus a separate
   * 65-80/20-35 "momentum" band) left a live gap at RSI 45-55 on both
   * sides that both bands independently avoided — and on a fast,
   * strong-momentum day RSI can blow straight through a narrow corridor
   * within one or two 5m candles and never come back into it (seen live
   * on 2026-09-15's gap-down, which sat at RSI ~17-31 for most of the
   * morning session — zero signals fired all day under the old rule).
   * Collapsing both bands into one continuous range per direction removes
   * that dead zone entirely: any RSI reading that agrees with the SMA9
   * trend direction and isn't in the tight neutral band or beyond the
   * extreme cutoff now qualifies for evaluation. Every filter downstream
   * (ATR expansion, structural reaction, min-profit, cooldown, blacklist,
   * session caps) still has to clear before a trade is taken — this only
   * widens which RSI reads reach those checks, not how easy the checks
   * themselves are to pass.
   */
  private evaluateStrategy(
    spot: number,
    sma9: number,
    rsi14: number,
    trace: string[],
  ): { signal: SignalDirection; optionType: OptionType } {
    const trendUp = spot > sma9;
    const trendDown = spot < sma9;
    const bullishFloor = 50 + this.rsiNeutralHalfWidth;
    const bearishCeiling = 50 - this.rsiNeutralHalfWidth;

    const isBullish = trendUp && rsi14 >= bullishFloor && rsi14 <= this.rsiMax;
    const isBearish = trendDown && rsi14 >= this.rsiMin && rsi14 <= bearishCeiling;

    if (isBullish) {
      trace.push(`DIRECTIONAL_READ: PASS — BUY CALL (CE) — spot>${sma9.toFixed(2)}, rsi14=${rsi14.toFixed(2)} in [${bullishFloor}, ${this.rsiMax}]`);
      return { signal: 'BUY CALL (CE)', optionType: 'CE' };
    }
    if (isBearish) {
      trace.push(`DIRECTIONAL_READ: PASS — BUY PUT (PE) — spot<${sma9.toFixed(2)}, rsi14=${rsi14.toFixed(2)} in [${this.rsiMin}, ${bearishCeiling}]`);
      return { signal: 'BUY PUT (PE)', optionType: 'PE' };
    }

    const why = !trendUp && !trendDown
      ? 'spot === sma9 (no trend read)'
      : rsi14 > bearishCeiling && rsi14 < bullishFloor
        ? `rsi14=${rsi14.toFixed(2)} in neutral zone [${bearishCeiling}, ${bullishFloor}]`
        : `rsi14=${rsi14.toFixed(2)} beyond extreme cutoff [${this.rsiMin}, ${this.rsiMax}]`;
    trace.push(`DIRECTIONAL_READ: REJECT — ${why}`);
    return { signal: 'NO_SIGNAL', optionType: null };
  }

  /**
   * PIVOT & STRUCTURE REACTION ANALYSIS — signal-filter half. Confirms the
   * SMA/RSI directional read (`evaluateStrategy()`) against actual
   * price-action at a real structural level, off the most recently
   * completed 5m candle:
   *
   *   - BUY CALL (CE): either a breakout (candle closed above the nearest
   *     reaction level overhead) OR a bounce off strong support (the
   *     candle's low wicked into a level below — within
   *     `structureReactionToleranceAtrMult` x ATR — but closed back above
   *     it, i.e. support held).
   *   - BUY PUT (PE): either a breakdown (candle closed below the nearest
   *     reaction level underneath) OR a rejection from resistance (the
   *     candle's high wicked into a level above but closed back below it,
   *     i.e. resistance held).
   *
   * `requirePivotLevel` (SESSION WINDOW UPPER LIMITS — Mid-Day's extra
   * confirmation requirement): when true, only kind==='PIVOT' or
   * kind==='FALLBACK' levels (classic daily floor pivots, session VWAP, and
   * the morning 09:15–10:30 high/low) are eligible to confirm against —
   * locally-detected intraday SWING clusters don't count. Mid-Day is the
   * desk's choppiest stretch, so its lower trade cap is paired with
   * demanding a "cleaner" reaction off a level every participant is
   * watching, not just a locally-detected swing. PIVOT-only (the original
   * rule) meant Mid-Day could only ever confirm against 5 fixed numbers
   * derived from *yesterday's* range — on a day where price never
   * approaches one of those five, Mid-Day silently vetoes every setup
   * regardless of how genuine the reaction looks. FALLBACK levels are
   * still "everyone's watching this" structure (VWAP, the opening range)
   * but responsive to *today's* actual trading instead.
   *
   * Fails open (returns true) when there's simply no eligible level on the
   * relevant side to react off of — this is a confirmation filter, not a
   * second excuse to block a signal that has nothing structural nearby to
   * fail against.
   */
  private passesStructuralReactionFilter(
    signal: SignalDirection,
    candles: CandleBar[],
    reactionLevels: ReactionLevel[],
    atr14: number,
    requirePivotLevel: boolean,
  ): boolean {
    if (signal === 'NO_SIGNAL' || candles.length === 0) return true;

    const lastCandle = candles[candles.length - 1];
    const tolerance = Math.max(atr14 * this.structureReactionToleranceAtrMult, 1);

    const eligibleLevels = requirePivotLevel
      ? reactionLevels.filter((l) => l.kind === 'PIVOT' || l.kind === 'FALLBACK')
      : reactionLevels;
    const levelsBelow = eligibleLevels.map((l) => l.level).filter((level) => level < lastCandle.close);
    const levelsAbove = eligibleLevels.map((l) => l.level).filter((level) => level > lastCandle.close);
    const nearestSupport = levelsBelow.length > 0 ? Math.max(...levelsBelow) : null;
    const nearestResistance = levelsAbove.length > 0 ? Math.min(...levelsAbove) : null;

    if (nearestSupport === null && nearestResistance === null) {
      return true; // No structural context at all to confirm or deny against — fail open.
    }

    if (signal === 'BUY CALL (CE)') {
      const breakoutAboveResistance = nearestResistance !== null && lastCandle.close > nearestResistance;
      const bounceOffSupport =
        nearestSupport !== null && lastCandle.low <= nearestSupport + tolerance && lastCandle.close > nearestSupport;
      return breakoutAboveResistance || bounceOffSupport;
    }

    // BUY PUT (PE)
    const breakdownBelowSupport = nearestSupport !== null && lastCandle.close < nearestSupport;
    const rejectionFromResistance =
      nearestResistance !== null && lastCandle.high >= nearestResistance - tolerance && lastCandle.close < nearestResistance;
    return breakdownBelowSupport || rejectionFromResistance;
  }

  /**
   * Builds the 1-lot risk-protocol matrix for an active signal. Stop-loss
   * is sized off the *current* ATR(14) reading — `stopLoss = ATR ×
   * atrStopLossMultiplier` — so a volatile session naturally gets more
   * room and a quiet one gets pulled in tighter. The target prefers a real
   * structural reaction level in the trade's favor over a symmetric ATR
   * distance — see `resolveTargetPoints()`. Returns null for NO_SIGNAL,
   * since there is no trade to manage.
   */
  private buildTradeRules(
    signal: SignalDirection,
    entryPrice: number,
    atr14: number,
    reactionLevels: ReactionLevel[],
  ): TradeRules | null {
    if (signal === 'NO_SIGNAL') {
      return null;
    }

    const direction = signal === 'BUY CALL (CE)' ? 1 : -1;
    const indexStopLossPoints = this.round(atr14 * this.atrStopLossMultiplier);
    const atrTargetPoints = this.round(atr14 * this.atrTargetMultiplier);
    const { indexTargetPoints, targetBasis } = this.resolveTargetPoints(direction, entryPrice, atrTargetPoints, atr14, reactionLevels);

    const optionTargetPoints = this.round(indexTargetPoints * this.deltaProxy);
    const optionStopLossPoints = this.round(indexStopLossPoints * this.deltaProxy);

    return {
      entryPrice: this.round(entryPrice),
      indexTarget: this.round(entryPrice + direction * indexTargetPoints),
      indexStopLoss: this.round(entryPrice - direction * indexStopLossPoints),
      indexTargetPoints,
      indexStopLossPoints,
      optionTargetPoints,
      optionStopLossPoints,
      deltaProxy: this.deltaProxy,
      lotSize: this.lotSize,
      // Cash figures are fully derived from the sized distances above —
      // there's no fixed "desk-quoted" figure to round to once the target
      // itself varies signal-to-signal with volatility/pivot placement.
      maxRiskCashINR: this.round(optionStopLossPoints * this.lotSize),
      targetCashINR: this.round(optionTargetPoints * this.lotSize),
      atr14: this.round(atr14),
      targetBasis,
    };
  }

  /**
   * PIVOT & STRUCTURE REACTION ANALYSIS — target-snap half.
   *
   * Step 1 — find the nearest structural reaction level in the trade's
   * favorable direction (above entry for a CALL, below entry for a PUT),
   * drawn from the FULL merged set `computeReactionLevels()` built — daily
   * floor pivots AND intraday 5m swing-high/low clusters, not just the four
   * floor-pivot numbers; a farther level is never relevant since price
   * would reach the nearer one first.
   *
   * Step 2 — `atrTargetPoints` (ATR × ATR_TARGET_MULTIPLIER, default 2×ATR)
   * is the fallback target. The qualifying bar for snapping to a reaction
   * level instead is `structureMinTargetAtrMult` x ATR (independently
   * configurable, default 2x — see the field doc for why it isn't simply
   * reused from atrTargetPoints/atrTargetMultiplier).
   *
   * Step 3 — use the level as target only when it clears that bar;
   * otherwise fall back to atrTargetPoints itself. With the default 2x
   * setting for both knobs this guarantees indexTargetPoints is NEVER less
   * than atrTargetPoints, same guarantee as before the structure-levels
   * change — lowering structureMinTargetAtrMult toward 1.5x deliberately
   * trades some of that reward:risk floor for tighter, more frequently-hit
   * targets (see the field doc).
   *
   * BUGFIX (carried over): this must qualify a candidate level against the
   * ATR TARGET distance (or structureMinTargetAtrMult, its explicit
   * successor), never against indexStopLossPoints (1×ATR by default) — a
   * level sitting between 1x and 2x ATR away passing that check would
   * silently ship trades with as little as ~1:1 reward:risk while believing
   * they were 2:1, since level placement is essentially independent of ATR
   * and this was the *common* case, not an edge case.
   */
  private resolveTargetPoints(
    direction: 1 | -1,
    entryPrice: number,
    atrTargetPoints: number,
    atr14: number,
    reactionLevels: ReactionLevel[],
  ): { indexTargetPoints: number; targetBasis: 'PIVOT' | 'ATR' } {
    // Step 1
    const candidates = reactionLevels
      .map((reactionLevel) => reactionLevel.level)
      .filter((level) => (direction === 1 ? level > entryPrice : level < entryPrice));

    if (candidates.length > 0) {
      const nearestLevel = direction === 1 ? Math.min(...candidates) : Math.max(...candidates);
      const levelDistance = this.round(Math.abs(nearestLevel - entryPrice));

      // Step 3 — qualify against the structural target-snap distance (see
      // BUGFIX note above), independent of the ATR fallback multiplier.
      if (levelDistance >= atr14 * this.structureMinTargetAtrMult) {
        return { indexTargetPoints: levelDistance, targetBasis: 'PIVOT' };
      }
    }

    return { indexTargetPoints: atrTargetPoints, targetBasis: 'ATR' };
  }

  private buildFallbackSignal(
    dailySignalCount: number,
    dailyLimitReached: boolean,
    hasActivePosition: boolean,
    stoplossHitCount: number,
    lossCircuitBreakerTripped: boolean,
    rejectionTrace: string[] = [],
  ): SignalData {
    return {
      id: randomUUID(),
      generatedAt: new Date().toISOString(),
      symbol: this.symbol,
      spot: 0,
      dayChange: 0,
      dayChangePercent: 0,
      sma9: 0,
      rsi14: 0,
      atr14: 0,
      atmStrike: 0,
      optionType: null,
      signal: 'NO_SIGNAL',
      expiry: this.expiryService.computeExpiryTarget(),
      tradeRules: null,
      marketOpen: isIndianMarketOpen(),
      series: [],
      dailyLevels: { dayHigh: 0, dayLow: 0, prevClose: 0, pivot: 0, resistance1: 0, resistance2: 0, support1: 0, support2: 0 },
      dailySignalCount,
      maxDailySignals: this.maxDailySignals,
      dailyLimitReached,
      stoplossHitCount,
      maxDailyStoplossHits: this.maxDailyStoplossHits,
      lossCircuitBreakerTripped,
      hasActivePosition,
      rejectionTrace,
    };
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
