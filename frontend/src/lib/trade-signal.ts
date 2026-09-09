/**
 * Mirrors the persisted TradeSignal row shape from the backend's Prisma
 * schema (see backend/prisma/schema.prisma), as returned by
 * GET /api/signals/today and GET /api/signals/archive.
 */

export type TradeDirection = 'CALL' | 'PUT';

export type TradeExpiryType = 'CURRENT_WEEK' | 'NEXT_WEEK';

export type TradeStatus = 'ACTIVE' | 'TARGET_HIT' | 'STOPLOSS_HIT';

export interface TradeSignal {
  id: string;
  timestamp: string;
  dateString: string;
  direction: TradeDirection;
  strikePrice: number;
  expiryType: TradeExpiryType;
  entrySpotPrice: number;
  stopLossSpot: number;
  targetSpot: number;
  currentStatus: TradeStatus;
  resolvedAt: string | null;
  resolvedSpot: number | null;
  /** Best-favorable spot price seen since entry (highest for CALL, lowest for PUT) — null until the first monitor tick after creation. */
  peakSpot: number | null;
  /** The ATR(14) reading (index points) this trade's SL/target distances were sized from at creation. Null for legacy rows predating this field. */
  atr14: number | null;
  /** Whether `targetSpot` came from a support/resistance pivot or a symmetric ATR distance. Null for legacy rows predating this field. */
  targetBasis: 'PIVOT' | 'ATR' | null;
  /** Realized cash P&L for 1 lot at resolution — positive for TARGET_HIT, negative for STOPLOSS_HIT. Null while ACTIVE. */
  netCashINR: number | null;
}

/** Peak favorable move, in index points, since entry — null if not yet tracked. */
export function peakPoints(signal: TradeSignal): number | null {
  if (signal.peakSpot === null) return null;
  return Math.abs(signal.peakSpot - signal.entrySpotPrice);
}

/**
 * Risk-protocol constants mirrored from the backend's LOT_SIZE/DELTA_PROXY
 * defaults (see backend/.env) — the frontend already assumes these are
 * effectively fixed (the dashboard footer states "1 lot, 65 units, Δ 0.5
 * proxy" outright). Used only to estimate live unrealized P&L for an ACTIVE
 * position client-side; every *realized* figure (`netCashINR`) is computed
 * and persisted by the backend itself, never by this constant.
 */
export const LOT_SIZE = 65;
export const DELTA_PROXY = 0.5;

/**
 * Approx unrealized cash P&L (1 lot) for an ACTIVE position at the given
 * live spot price — the same formula the backend applies at resolution (see
 * position-monitor.service.ts `computeNetCashINR`), just evaluated before
 * the target/stop-loss boundary has actually been crossed. Signed by
 * whether the move so far favors the position, not by an exit outcome.
 * Null when the position isn't ACTIVE or no live price is available yet.
 */
export function liveUnrealizedCashINR(signal: TradeSignal, livePrice: number | null): number | null {
  if (signal.currentStatus !== 'ACTIVE' || livePrice === null) return null;
  const favorablePoints = signal.direction === 'CALL' ? livePrice - signal.entrySpotPrice : signal.entrySpotPrice - livePrice;
  return Math.round(favorablePoints * DELTA_PROXY * LOT_SIZE);
}

/** How long the position has been held — entry to resolution, or entry to "now" while still ACTIVE. */
export function holdDurationMs(signal: TradeSignal): number {
  const start = new Date(signal.timestamp).getTime();
  const end = signal.resolvedAt ? new Date(signal.resolvedAt).getTime() : Date.now();
  return Math.max(0, end - start);
}

/** Formats a duration as "1h 5m" / "4m 32s" / "32s" — the two biggest units, dropping smaller ones once minutes/hours are in play. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Query filters accepted by GET /api/signals/archive. */
export interface ArchiveFilters {
  status?: TradeStatus;
  direction?: TradeDirection;
  expiryType?: TradeExpiryType;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

export interface ArchiveResult {
  items: TradeSignal[];
  total: number;
  limit: number;
  offset: number;
}

/** Payload broadcast over the 'signal-status-changed' WebSocket event. */
export interface SignalStatusChangedPayload {
  signal: TradeSignal;
  livePrice: number;
  netCashINR: number;
}
