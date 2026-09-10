import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { Direction, TradeStatus } from '@prisma/client';

/**
 * TESTING MODE SWITCH — daily-trade-limit bypass.
 *
 * While `false`, both the 5-trade daily cap AND the 2-stoploss daily kill
 * switch below are bypassed entirely: evaluation never halts for either
 * reason, so bulk/live strategy testing isn't throttled by production risk
 * limits. `dailySignalCount` / `stoplossHitCount` / `dailyLimitReached` /
 * `lossCircuitBreakerTripped` are still computed and returned on every
 * snapshot either way (the dashboard keeps showing real counts) — only the
 * *halt* behavior is gated.
 *
 * Flip this back to `true` before running against real capital. It can also
 * be overridden per-environment via ENABLE_DAILY_LIMIT=true/false in .env
 * without touching code — see the constructor — but this constant is the
 * source of truth when that env var is unset.
 */
const ENABLE_DAILY_LIMIT = false;
import { MarketDataService } from '../market-data/market-data.service';
import { IndicatorsService } from '../indicators/indicators.service';
import { ExpiryService } from '../expiry/expiry.service';
import { TradesService } from '../trades/trades.service';
import { TRADE_CREATED_EVENT, TradeCreatedPayload } from '../trades/trade-events';
import { isIndianMarketOpen } from '../common/market-hours.util';
import { DailyLevels, OptionType, SignalData, SignalDirection, TradeRules } from './signals.types';

/**
 * Core strategy engine. On a schedule (and on-demand for the very first
 * request), it fetches fresh Nifty 50 candles, derives SMA(9) / RSI(14) /
 * ATR(14), decides whether a directional signal fires, and caches exactly
 * one "latest" signal snapshot in memory for the API to serve. When a
 * fresh, actionable setup appears — and the daily throttle/active-position
 * guards both allow it — it also persists a new TradeSignal row, which is
 * what the 10s position monitor and the dashboard's today/archive views
 * track from that point on.
 */
@Injectable()
export class SignalsService {
  private readonly logger = new Logger(SignalsService.name);

  private readonly symbol: string;
  private readonly strikeStep: number;
  /** Max signals/day — hard-capped at 5 regardless of configured value (see the desk's overtrading guard). */
  private readonly maxDailySignals: number;
  /**
   * Daily loss circuit breaker — once this many signals resolve
   * STOPLOSS_HIT (the original, un-trailed risk stop) on the same IST
   * date, evaluation halts entirely for the rest of the day, same as the
   * daily signal-count throttle. TRAIL_STOP_HIT and TIME_EXIT don't count
   * here — neither is ever a full-risk loss.
   */
  private readonly maxDailyStoplossHits: number;
  /** TESTING MODE — see the `ENABLE_DAILY_LIMIT` module constant above for what this gates. */
  private readonly enableDailyLimit: boolean;

  /**
   * 10-MINUTE RE-ENTRY COOLDOWN GUARD — after ANY trade resolves
   * (TARGET_HIT / TRAIL_STOP_HIT / STOPLOSS_HIT / TIME_EXIT), a fresh setup
   * in that *same* direction is rejected for this many minutes, to stop
   * rapid overtrading back-to-back in one direction. See the cooldown check
   * in `refreshSignal()` and `TradesService.mostRecentResolutionTime()`.
   * Independent of `enableDailyLimit` — this guard stays active in testing
   * mode too, since it's a re-entry throttle, not a daily cap.
   */
  private readonly reentryCooldownMinutes: number;

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

    const configuredMax = Number(this.configService.get<string>('MAX_DAILY_SIGNALS', '5'));
    // Strict 5-trade daily limit — hard-capped at 5 no matter what's
    // configured (floor of 1 so a misconfigured/zero value under-trades
    // rather than disabling evaluation entirely).
    this.maxDailySignals = Math.min(5, Math.max(1, Number.isFinite(configuredMax) ? configuredMax : 5));

    const configuredMaxStoplossHits = Number(this.configService.get<string>('MAX_DAILY_STOPLOSS_HITS', '2'));
    this.maxDailyStoplossHits = Math.max(1, Number.isFinite(configuredMaxStoplossHits) ? configuredMaxStoplossHits : 2);

    // TESTING MODE — env override wins when set; otherwise falls back to the
    // ENABLE_DAILY_LIMIT constant at the top of this file.
    const dailyLimitOverride = this.configService.get<string>('ENABLE_DAILY_LIMIT');
    this.enableDailyLimit = dailyLimitOverride !== undefined ? dailyLimitOverride === 'true' : ENABLE_DAILY_LIMIT;
    if (!this.enableDailyLimit) {
      this.logger.warn(
        '⚠️  TESTING MODE: daily 5-trade cap and 2-stoploss kill switch are DISABLED (ENABLE_DAILY_LIMIT=false). Re-enable before trading live capital.',
      );
    }

    this.reentryCooldownMinutes = Number(this.configService.get<string>('REENTRY_COOLDOWN_MINUTES', '10'));

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

      let { signal, optionType } = this.evaluateStrategy(snapshot.spot, snapshot.sma9, snapshot.rsi14);
      let tradeRules = this.buildTradeRules(signal, snapshot.spot, snapshot.atr14, dailyLevels);

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

      // --- 10-MINUTE RE-ENTRY COOLDOWN GUARD ------------------------------
      // Blocks rapid overtrading in the same direction (e.g. three PUT
      // trades back-to-back within 13 minutes): once a trade in a given
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
   * Builds the 1-lot risk-protocol matrix for an active signal. Stop-loss
   * is sized off the *current* ATR(14) reading — `stopLoss = ATR ×
   * atrStopLossMultiplier` — so a volatile session naturally gets more
   * room and a quiet one gets pulled in tighter. The target prefers a real
   * support/resistance pivot in the trade's favor over a symmetric ATR
   * distance — see `resolveTargetPoints()`. Returns null for NO_SIGNAL,
   * since there is no trade to manage.
   */
  private buildTradeRules(
    signal: SignalDirection,
    entryPrice: number,
    atr14: number,
    dailyLevels: DailyLevels,
  ): TradeRules | null {
    if (signal === 'NO_SIGNAL') {
      return null;
    }

    const direction = signal === 'BUY CALL (CE)' ? 1 : -1;
    const indexStopLossPoints = this.round(atr14 * this.atrStopLossMultiplier);
    const atrTargetPoints = this.round(atr14 * this.atrTargetMultiplier);
    const { indexTargetPoints, targetBasis } = this.resolveTargetPoints(direction, entryPrice, atrTargetPoints, dailyLevels);

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
   * Step 1 — find the nearest support/resistance pivot in the trade's
   * favorable direction (resistance above entry for a CALL, support below
   * entry for a PUT); a farther pivot is never relevant since price would
   * reach the nearer one first.
   *
   * Step 2 — `atrTargetPoints` (ATR × ATR_TARGET_MULTIPLIER, default 2×ATR)
   * is both the fallback target *and* the qualifying bar for the pivot.
   *
   * Step 3 — use the pivot as target only when it is at least as far as
   * atrTargetPoints; otherwise fall back to atrTargetPoints itself. This
   * guarantees indexTargetPoints is NEVER less than atrTargetPoints,
   * whichever branch fires — and therefore never below the default 2:1
   * reward:risk versus indexStopLossPoints (ATR × ATR_STOPLOSS_MULTIPLIER).
   *
   * BUGFIX: this previously qualified a pivot against `indexStopLossPoints`
   * (1×ATR by default) instead of `atrTargetPoints` (2×ATR) — the wrong
   * yardstick. A pivot sitting anywhere between 1x and 2x ATR away used to
   * pass that check and get selected as target, silently shipping trades
   * with as little as ~1:1 reward:risk while believing they were 2:1,
   * since pivot placement is essentially independent of ATR and this was
   * the *common* case, not an edge case.
   */
  private resolveTargetPoints(
    direction: 1 | -1,
    entryPrice: number,
    atrTargetPoints: number,
    levels: DailyLevels,
  ): { indexTargetPoints: number; targetBasis: 'PIVOT' | 'ATR' } {
    // Step 1
    const candidates =
      direction === 1
        ? [levels.resistance1, levels.resistance2].filter((level) => level > entryPrice)
        : [levels.support1, levels.support2].filter((level) => level < entryPrice);

    if (candidates.length > 0) {
      const nearestPivot = direction === 1 ? Math.min(...candidates) : Math.max(...candidates);
      const pivotDistance = this.round(Math.abs(nearestPivot - entryPrice));

      // Step 3 — qualify against the ATR TARGET distance, not the
      // stop-loss distance (see BUGFIX note above).
      if (pivotDistance >= atrTargetPoints) {
        return { indexTargetPoints: pivotDistance, targetBasis: 'PIVOT' };
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
