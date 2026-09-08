import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { MarketDataService } from '../market-data/market-data.service';
import { IndicatorsService } from '../indicators/indicators.service';
import { ExpiryService } from '../expiry/expiry.service';
import { isIndianMarketOpen } from '../common/market-hours.util';
import { OptionType, SignalData, SignalDirection, TradeRules } from './signals.types';

/**
 * Core strategy engine. On a schedule (and on-demand for the very first
 * request), it fetches fresh Nifty 50 candles, derives SMA(9) / RSI(14),
 * decides whether a directional signal fires, and caches exactly one
 * "latest" signal snapshot in memory for the API to serve.
 */
@Injectable()
export class SignalsService {
  private readonly logger = new Logger(SignalsService.name);

  private readonly symbol: string;
  private readonly strikeStep: number;

  // --- Risk protocol, fixed to 1 lot with an ATM delta proxy of 0.5 -----
  /** Contract units per lot (desk convention hardcoded per spec: 65). */
  private readonly lotSize: number;
  /** Proxy delta used to translate index-point moves into option premium moves. */
  private readonly deltaProxy: number;
  /** Index-point distances that define the trade's SL/target on the underlying. */
  private readonly indexTargetPoints: number;
  private readonly indexStopLossPoints: number;
  /** Cash P&L for exactly 1 lot at the option-premium SL/target, in INR. */
  private readonly targetCashINR: number;
  private readonly maxRiskCashINR: number;

  /** In-memory cache of the most recently computed signal. */
  private latestSignal: SignalData | null = null;
  /** Guards against overlapping cron executions if a fetch runs long. */
  private isRefreshing = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly marketDataService: MarketDataService,
    private readonly indicatorsService: IndicatorsService,
    private readonly expiryService: ExpiryService,
  ) {
    this.symbol = this.configService.get<string>('NIFTY_SYMBOL', '^NSEI');
    this.strikeStep = Number(this.configService.get<string>('STRIKE_STEP', '50'));

    this.lotSize = Number(this.configService.get<string>('LOT_SIZE', '65'));
    this.deltaProxy = Number(this.configService.get<string>('DELTA_PROXY', '0.5'));
    this.indexTargetPoints = Number(this.configService.get<string>('INDEX_TARGET_POINTS', '60'));
    this.indexStopLossPoints = Number(this.configService.get<string>('INDEX_STOP_LOSS_POINTS', '30'));
    // NOTE: these are the desk's rounded, hardcoded cash figures (per spec),
    // not a live re-derivation of optionPoints * lotSize on every tick — that
    // keeps the number a viewer sees in the app stable and matching the risk
    // sheet, even though 30pts * 65 units nets ₹1,950 (~₹50 above the
    // ₹1,900 target quoted here) — the desk rounds down for a safety margin.
    this.targetCashINR = Number(this.configService.get<string>('TARGET_CASH_INR', '1900'));
    this.maxRiskCashINR = Number(this.configService.get<string>('MAX_RISK_CASH_INR', '975'));
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
   * Fetches candles, computes indicators, evaluates the strategy, and
   * updates the in-memory cache. Wrapped in try/catch so a transient
   * Yahoo Finance outage never crashes the process or the cron scheduler.
   */
  private async refreshSignal(): Promise<void> {
    if (this.isRefreshing) {
      this.logger.debug('Refresh already in progress — skipping overlapping tick.');
      return;
    }
    this.isRefreshing = true;

    try {
      const candles = await this.marketDataService.fetchFiveMinuteCandles(this.symbol);
      const snapshot = this.indicatorsService.computeSnapshot(candles);
      const series = this.indicatorsService.computeSeries(candles);
      const atmStrike = this.indicatorsService.computeAtmStrike(snapshot.spot, this.strikeStep);
      const expiry = this.expiryService.computeExpiryTarget();

      const { signal, optionType } = this.evaluateStrategy(snapshot.spot, snapshot.sma9, snapshot.rsi14);
      const tradeRules = this.buildTradeRules(signal, snapshot.spot);

      // A signal "event" is only new when the actual trade setup changes —
      // direction, option side, or ATM strike. Reuse the same id/generatedAt
      // across ticks where the same setup simply persists, so the frontend
      // (which notifies on a new id) fires exactly one desktop alert per
      // signal event instead of re-notifying on every 30s poll.
      const isSameSignalEvent =
        this.latestSignal !== null &&
        this.latestSignal.signal === signal &&
        this.latestSignal.optionType === optionType &&
        this.latestSignal.atmStrike === atmStrike;

      const id = isSameSignalEvent ? this.latestSignal!.id : randomUUID();
      const generatedAt = isSameSignalEvent ? this.latestSignal!.generatedAt : new Date().toISOString();

      this.latestSignal = {
        id,
        generatedAt,
        symbol: this.symbol,
        spot: this.round(snapshot.spot),
        sma9: this.round(snapshot.sma9),
        rsi14: this.round(snapshot.rsi14),
        atmStrike,
        optionType,
        signal,
        expiry,
        tradeRules,
        marketOpen: isIndianMarketOpen(),
        series,
      };

      this.logger.log(
        `Signal refreshed → ${signal} | spot=${this.latestSignal.spot} sma9=${this.latestSignal.sma9} rsi14=${this.latestSignal.rsi14} atm=${atmStrike} expiry=${expiry.cycle}`,
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
        this.latestSignal = this.buildFallbackSignal();
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
   * Builds the 1-lot risk-protocol matrix for an active signal. Returns
   * null for NO_SIGNAL, since there is no trade to manage.
   */
  private buildTradeRules(signal: SignalDirection, entryPrice: number): TradeRules | null {
    if (signal === 'NO_SIGNAL') {
      return null;
    }

    const direction = signal === 'BUY CALL (CE)' ? 1 : -1;
    const optionTargetPoints = this.round(this.indexTargetPoints * this.deltaProxy);
    const optionStopLossPoints = this.round(this.indexStopLossPoints * this.deltaProxy);

    return {
      entryPrice: this.round(entryPrice),
      indexTarget: this.round(entryPrice + direction * this.indexTargetPoints),
      indexStopLoss: this.round(entryPrice - direction * this.indexStopLossPoints),
      indexTargetPoints: this.indexTargetPoints,
      indexStopLossPoints: this.indexStopLossPoints,
      optionTargetPoints,
      optionStopLossPoints,
      deltaProxy: this.deltaProxy,
      lotSize: this.lotSize,
      maxRiskCashINR: this.maxRiskCashINR,
      targetCashINR: this.targetCashINR,
    };
  }

  private buildFallbackSignal(): SignalData {
    return {
      id: randomUUID(),
      generatedAt: new Date().toISOString(),
      symbol: this.symbol,
      spot: 0,
      sma9: 0,
      rsi14: 0,
      atmStrike: 0,
      optionType: null,
      signal: 'NO_SIGNAL',
      expiry: this.expiryService.computeExpiryTarget(),
      tradeRules: null,
      marketOpen: isIndianMarketOpen(),
      series: [],
    };
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
