/**
 * Mirrors the shape returned by the NestJS backend's
 * GET /api/signals/latest endpoint (see backend/src/signals/signals.types.ts).
 */

export type SignalDirection = 'BUY CALL (CE)' | 'BUY PUT (PE)' | 'NO_SIGNAL';

export type OptionType = 'CE' | 'PE' | null;

export type ExpiryCycle = 'CURRENT_WEEK' | 'NEXT_WEEK';

export interface SeriesPoint {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  sma9: number | null;
  rsi14: number | null;
}

export interface ExpiryInfo {
  cycle: ExpiryCycle;
  date: string;
  label: string;
}

/**
 * Today's intraday range plus classic floor-trader pivot points, derived
 * from the previous trading day's high/low/close — reference levels only,
 * not guarantees.
 */
export interface DailyLevels {
  dayHigh: number;
  dayLow: number;
  pivot: number;
  resistance1: number;
  resistance2: number;
  support1: number;
  support2: number;
}

export interface TradeRules {
  entryPrice: number;
  indexTarget: number;
  indexStopLoss: number;
  /** ATR(14) x multiplier, unless a support/resistance pivot was used instead — see `targetBasis`. */
  indexTargetPoints: number;
  indexStopLossPoints: number;
  optionTargetPoints: number;
  optionStopLossPoints: number;
  deltaProxy: number;
  lotSize: number;
  maxRiskCashINR: number;
  targetCashINR: number;
  /** The raw ATR(14) reading (index points) this trade's distances were sized from. */
  atr14: number;
  /** 'PIVOT' when the nearest support/resistance level was used as the target; 'ATR' when no pivot qualified. */
  targetBasis: 'PIVOT' | 'ATR';
}

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
  series: SeriesPoint[];
  dailyLevels: DailyLevels;
  dailySignalCount: number;
  maxDailySignals: number;
  dailyLimitReached: boolean;
  hasActivePosition: boolean;
}
