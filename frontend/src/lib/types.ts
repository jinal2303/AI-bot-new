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

export interface TradeRules {
  entryPrice: number;
  indexTarget: number;
  indexStopLoss: number;
  indexTargetPoints: number;
  indexStopLossPoints: number;
  optionTargetPoints: number;
  optionStopLossPoints: number;
  deltaProxy: number;
  lotSize: number;
  maxRiskCashINR: number;
  targetCashINR: number;
}

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
  series: SeriesPoint[];
}
