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
 * Fixed to 1 lot (65 units) with an ATM delta proxy of 0.5, per the desk's
 * standardized risk protocol.
 */
export interface TradeRules {
  entryPrice: number;
  /** Index-point stop-loss / target levels (absolute spot price). */
  indexStopLoss: number;
  indexTarget: number;
  /** Index-point distances used to derive the above levels. */
  indexStopLossPoints: number;
  indexTargetPoints: number;
  /** Option-premium point distances, scaled by the ATM delta proxy. */
  optionStopLossPoints: number;
  optionTargetPoints: number;
  /** Delta proxy used to translate index points into option points. */
  deltaProxy: number;
  /** Contract units per lot (hardcoded desk convention: 65). */
  lotSize: number;
  /** Cash risk/reward for exactly 1 lot, in INR. */
  maxRiskCashINR: number;
  targetCashINR: number;
}

/** The full payload returned by GET /api/signals/latest. */
export interface SignalData {
  id: string;
  generatedAt: string;
  symbol: string;
  spot: number;
  sma9: number;
  rsi14: number;
  atmStrike: number;
  optionType: OptionType;
  signal: SignalDirection;
  expiry: ExpiryInfo;
  tradeRules: TradeRules | null;
  marketOpen: boolean;
  /** Recent 5m candles with SMA(9)/RSI(14) overlays, for charting. */
  series: SeriesPoint[];
}
