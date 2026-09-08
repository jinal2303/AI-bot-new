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
}

/** Peak favorable move, in index points, since entry — null if not yet tracked. */
export function peakPoints(signal: TradeSignal): number | null {
  if (signal.peakSpot === null) return null;
  return Math.abs(signal.peakSpot - signal.entrySpotPrice);
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
