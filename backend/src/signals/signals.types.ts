/**
 * Shared type definitions for the signal-tracking domain.
 */

export type SignalDirection = 'BUY CALL (CE)' | 'BUY PUT (PE)' | 'NO_SIGNAL';

export type OptionType = 'CE' | 'PE' | null;

export type ExpiryCycle = 'CURRENT_WEEK' | 'NEXT_WEEK';

/** A single OHLCV candlestick bar. */
export interface CandleBar {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Result of running the technical-indicator pipeline over the latest candles. */
export interface IndicatorSnapshot {
  spot: number;
  sma9: number;
  rsi14: number;
  /** Average True Range(14) — recent volatility, in index points; sizes the exit distances. */
  atr14: number;
  candleTimestamp: Date;
}

/** One point of the charting series: a candle plus its indicator values at that bar. */
export interface SeriesPoint {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  sma9: number | null;
  rsi14: number | null;
}

/**
 * Today's intraday range plus classic floor-trader pivot points, derived
 * from the previous trading day's high/low/close. Support/resistance are
 * projections, not guarantees — they're the same formula every retail
 * charting platform uses, given here purely as reference levels.
 */
export interface DailyLevels {
  dayHigh: number;
  dayLow: number;
  /** (prevHigh + prevLow + prevClose) / 3 */
  pivot: number;
  resistance1: number;
  resistance2: number;
  support1: number;
  support2: number;
}

/** Which weekly options-expiry cycle the current signal should trade, and when it falls. */
export interface ExpiryInfo {
  cycle: ExpiryCycle;
  /** ISO date (YYYY-MM-DD) of the target expiry. */
  date: string;
  /** Human label, e.g. "11 Sep 2026 (Current Week)". */
  label: string;
}

/**
 * The trade-rule / risk-protocol matrix attached to an active signal.
 * Fixed to 1 lot (65 units) with an ATM delta proxy of 0.5, but the
 * stop-loss/target *distances* are no longer fixed points — they scale with
 * the market's own recent volatility: distance = ATR(14) × a multiplier
 * (wider stops/targets in a choppy, high-ATR market; tighter in a calm one).
 */
export interface TradeRules {
  entryPrice: number;
  /** Index-point stop-loss / target levels (absolute spot price). */
  indexStopLoss: number;
  indexTarget: number;
  /** Index-point distances used to derive the above levels — ATR(14) × multiplier. */
  indexStopLossPoints: number;
  indexTargetPoints: number;
  /** Option-premium point distances, scaled by the ATM delta proxy. */
  optionStopLossPoints: number;
  optionTargetPoints: number;
  /** Delta proxy used to translate index points into option points. */
  deltaProxy: number;
  /** Contract units per lot (hardcoded desk convention: 65). */
  lotSize: number;
  /** Cash risk/reward for exactly 1 lot, in INR — derived from the ATR-sized distances above. */
  maxRiskCashINR: number;
  targetCashINR: number;
  /** The raw ATR(14) reading (index points) this trade's distances were sized from. */
  atr14: number;
  /**
   * Where the target came from: 'PIVOT' when the nearest resistance (CALL)
   * / support (PUT) offered at least a 1:1 reward:risk and was used
   * directly; 'ATR' when no pivot qualified and the symmetric ATR-sized
   * target was used instead.
   */
  targetBasis: 'PIVOT' | 'ATR';
}

/** The full payload returned by GET /api/signals/latest. */
export interface SignalData {
  id: string;
  generatedAt: string;
  symbol: string;
  spot: number;
  sma9: number;
  rsi14: number;
  atr14: number;
  atmStrike: number;
  optionType: OptionType;
  signal: SignalDirection;
  expiry: ExpiryInfo;
  tradeRules: TradeRules | null;
  marketOpen: boolean;
  /** Recent 5m candles with SMA(9)/RSI(14) overlays, for charting. */
  series: SeriesPoint[];
  dailyLevels: DailyLevels;
  /** Daily overtrading guard — see TradesService.countToday(). */
  dailySignalCount: number;
  maxDailySignals: number;
  dailyLimitReached: boolean;
  /** True while an ACTIVE persisted position is already being tracked — a
   *  fresh strategy read won't open a second one until it resolves. */
  hasActivePosition: boolean;
}
