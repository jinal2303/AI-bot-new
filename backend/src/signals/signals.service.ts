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
  /** Minimum target payoff (1 lot) a setup must clear to be taken at all — see the filter in refreshSignal(). */
  private readonly minTargetCashINR: number;

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
    this.minTargetCashINR = Number(this.configService.get<string>('MIN_TARGET_CASH_INR', '1000'));
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
            }
          : this.buildFallbackSignal(dailySignalCount, dailyLimitReached, false, stoplossHitCount, lossCircuitBreakerTripped);
        return;
      }

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
      // SESSION WINDOW UPPER LIMITS — which named window (if any) "now"
      // falls in. Computed once, reused below by both the Mid-Day stricter
      // structural-confirmation rule and the per-window cap filter.
      const currentWindow = getSessionWindow(new Date());

      let { signal, optionType } = this.evaluateStrategy(snapshot.spot, snapshot.sma9, snapshot.rsi14);

      // --- MARKET-MOVEMENT-FIRST FILTER: ATR expansion (NEW) --------------
      // The SMA/RSI corridor alone can't tell a genuine breakout from a
      // flat chop that happens to sit in the right zone. Require ATR(14)
      // to actually be expanding — real volatility/movement underway — or
      // downgrade to NO_SIGNAL rather than take a directionally-plausible
      // but movement-less setup. See IndicatorsService.computeSnapshot().
      if (signal !== 'NO_SIGNAL' && !snapshot.atrExpanding) {
        this.logger.debug(`Signal downgraded to NO_SIGNAL — ${signal} lacks ATR expansion (no real market movement underway)`);
        signal = 'NO_SIGNAL';
        optionType = null;
      }

      // --- STRUCTURAL PIVOT-REACTION FILTER -------------------------------
      // The SMA/RSI read above only says "the trend direction looks right";
      // it says nothing about *where* price actually is relative to the
      // levels the rest of the market is watching. Require confirmation —
      // a breakout/bounce for a CALL, a breakdown/rejection for a PUT — off
      // a real reaction level before taking the setup at all. Mid-Day
      // (10:30–13:15, the desk's choppiest stretch) requires the STRICTER
      // form: the reacted-off level must be a genuine daily floor pivot
      // (kind 'PIVOT'), not just an intraday swing cluster (kind 'SWING') —
      // see `passesStructuralReactionFilter()`'s `requirePivotLevel` param.
      const requirePivotLevel = currentWindow === 'MIDDAY';
      if (signal !== 'NO_SIGNAL' && !this.passesStructuralReactionFilter(signal, candles, reactionLevels, snapshot.atr14, requirePivotLevel)) {
        this.logger.debug(
          `Signal downgraded to NO_SIGNAL — ${signal} lacks structural confirmation (no breakout/breakdown/bounce/rejection at a key${requirePivotLevel ? ' floor-pivot' : ''} reaction level)`,
        );
        signal = 'NO_SIGNAL';
        optionType = null;
      }

      let tradeRules = this.buildTradeRules(signal, snapshot.spot, snapshot.atr14, reactionLevels);

      // --- Minimum-profit filter ------------------------------------------
      // A setup that technically clears the RSI/SMA/R:R bars but only pays
      // out a small amount (thin ATR, target capped by a nearby pivot) may
      // not be worth the fixed 1-lot brokerage/slippage overhead. Downgrade
      // it to NO_SIGNAL rather than take it — same as any other disqualified
      // read, so it never reaches the trade-creation step below.
      if (tradeRules !== null && tradeRules.targetCashINR < this.minTargetCashINR) {
        this.logger.debug(
          `Signal downgraded to NO_SIGNAL — target payoff ₹${tradeRules.targetCashINR} is below the ₹${this.minTargetCashINR} minimum`,
        );
        signal = 'NO_SIGNAL';
        optionType = null;
        tradeRules = null;
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
          this.logger.debug(
            `Signal downgraded to NO_SIGNAL — ${desiredDirection} re-entry cooldown active (${remainingMinutes}m remaining)`,
          );
          signal = 'NO_SIGNAL';
          optionType = null;
          tradeRules = null;
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
          this.logger.debug(
            `Signal downgraded to NO_SIGNAL — strike ${strikeKey} is blacklisted after a recent STOPLOSS_HIT (${remainingMinutes}m remaining)`,
          );
          signal = 'NO_SIGNAL';
          optionType = null;
          tradeRules = null;
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
          this.logger.debug('Signal downgraded to NO_SIGNAL — outside every session window (past 15:15 IST, EOD square-off only)');
          signal = 'NO_SIGNAL';
          optionType = null;
          tradeRules = null;
        } else {
          const { startMinutes, endMinutes } = SESSION_WINDOW_BOUNDS[currentWindow];
          const windowCount = await this.tradesService.countTodayInWindow(startMinutes, endMinutes);
          const windowCap = this.sessionWindowCaps[currentWindow];

          if (windowCount >= windowCap) {
            this.logger.debug(
              `Signal downgraded to NO_SIGNAL — ${currentWindow} session window cap reached (${windowCount}/${windowCap})`,
            );
            signal = 'NO_SIGNAL';
            optionType = null;
            tradeRules = null;
          }
        }
      }

      // --- Persist a new position, if this tick actually opens one -------
      // Only when the strategy is actionable AND nothing is already being
      // tracked — the bot holds exactly one open position at a time; the
      // 10s monitor resolves it before a new one can be created.
      const hasActivePosition = await this.tradesService.hasActivePosition();
      if (optionType !== null && tradeRules !== null && !hasActivePosition) {
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
      };

      this.logger.log(
        `Signal refreshed → ${signal} | spot=${this.latestSignal.spot} sma9=${this.latestSignal.sma9} rsi14=${this.latestSignal.rsi14} atr14=${this.latestSignal.atr14} atm=${atmStrike} expiry=${expiry.cycle} dailyCount=${refreshedCount}/${this.maxDailySignals}${this.enableDailyLimit ? '' : ' (limit disabled — TESTING MODE)'} active=${refreshedHasActive}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Signal refresh failed: ${message}`);
      // Deliberately swallow the error after logging: a failed refresh must
      // never crash the cron scheduler or the HTTP request that triggered
      // an on-demand refresh. The previous cached signal (if any) is kept
      // as-is so the frontend keeps showing the last known-good state; if
      // nothing has ever succeeded, we surface a NO_SIGNAL placeholder.
      if (!this.latestSignal) {
        this.latestSignal = this.buildFallbackSignal(0, false, false, 0, false);
      }
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Strict, single-signal decision rules:
   *  - BULLISH: spot > SMA9 AND 55 <= RSI14 <= 65 -> BUY CALL (CE)
   *  - BEARISH: spot < SMA9 AND 35 <= RSI14 <= 45 -> BUY PUT (PE)
   *  - Otherwise -> NO_SIGNAL (choppy or overextended)
   */
  private evaluateStrategy(
    spot: number,
    sma9: number,
    rsi14: number,
  ): { signal: SignalDirection; optionType: OptionType } {
    const isBullish = spot > sma9 && rsi14 >= 55 && rsi14 <= 65;
    const isBearish = spot < sma9 && rsi14 >= 35 && rsi14 <= 45;

    if (isBullish) {
      return { signal: 'BUY CALL (CE)', optionType: 'CE' };
    }
    if (isBearish) {
      return { signal: 'BUY PUT (PE)', optionType: 'PE' };
    }
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
   * confirmation requirement): when true, only kind==='PIVOT' levels (the
   * classic daily floor pivots) are eligible to confirm against — intraday
   * SWING clusters don't count. Mid-Day is the desk's choppiest stretch, so
   * its lower trade cap is paired with demanding a "cleaner" reaction off a
   * level every participant is watching, not just a locally-detected swing.
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

    const eligibleLevels = requirePivotLevel ? reactionLevels.filter((l) => l.kind === 'PIVOT') : reactionLevels;
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
    };
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
