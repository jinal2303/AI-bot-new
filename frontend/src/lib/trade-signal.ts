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
