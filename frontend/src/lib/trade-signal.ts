/**
 * Mirrors the persisted TradeSignal row shape from the backend's Prisma
 * schema (see backend/prisma/schema.prisma), as returned by
 * GET /api/signals/today and GET /api/signals/archive.
 */

import { SignalData } from '@/lib/types';

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

export type CallType = 'INTRADAY' | 'DELIVERY';

/** IST calendar date (YYYY-MM-DD) for an ISO instant — matches the format of the backend's `dateString`. */
function istDateString(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Whether a call was squared off (or, if still open, is running) within the
 * same IST trading day it was entered on ("INTRADAY"), or has carried past
 * that day into another session ("DELIVERY") — this bot has no forced
 * end-of-day square-off, so a signal that never hits its target/stop-loss
 * before market close simply stays ACTIVE and rolls over. Derived purely
 * from `dateString` (the entry day) vs. `resolvedAt` (or "now" while
 * ACTIVE) — no separate field needed.
 */
export function callType(signal: TradeSignal): CallType {
  const referenceIso = signal.resolvedAt ?? new Date().toISOString();
  return istDateString(referenceIso) === signal.dateString ? 'INTRADAY' : 'DELIVERY';
}

const MARKET_CLOSE_MINUTES_IST = 15 * 60 + 30; // 15:30 IST
/** How far ahead of the close a carry/square-off call actually starts being worth making. */
const CARRY_DECISION_WINDOW_MINUTES = 60;

/** Minutes since IST midnight for `date`, via the browser's own (always-full-ICU) Intl support. */
function istMinutesSinceMidnight(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

export type CarryAction = 'LEAN_CARRY' | 'LEAN_SQUARE_OFF' | 'ALREADY_CARRIED';

export interface CarryRecommendation {
  action: CarryAction;
  headline: string;
  reason: string;
}

/**
 * A heuristic, explainable suggestion — never an instruction the app acts
 * on itself — for whether an ACTIVE position is worth carrying into the
 * next session or better squared off before today's close. This bot has no
 * auto square-off, so a position that never hits target/stop-loss simply
 * stays open; this just surfaces a read on current market conditions once
 * the close is actually near, using the same live spot/SMA(9)/RSI(14) the
 * strategy itself trades off of:
 *   - trend still aligned with the trade's direction (spot vs SMA9, RSI
 *     on the right side of 50), and
 *   - price sitting closer to target than to stop-loss
 * both leaning toward "worth carrying"; either one failing leans toward
 * "square off" instead, since overnight/next-session gap risk is added on
 * top of an already-weakening setup. Returns null outside the decision
 * window (there's no carry call to make yet — plenty of the day is left).
 */
export function carryRecommendation(
  signal: TradeSignal,
  live: Pick<SignalData, 'spot' | 'sma9' | 'rsi14' | 'marketOpen'> | null,
): CarryRecommendation | null {
  if (signal.currentStatus !== 'ACTIVE' || live === null) return null;

  const minutesToClose = MARKET_CLOSE_MINUTES_IST - istMinutesSinceMidnight(new Date());

  if (!live.marketOpen && minutesToClose <= 0) {
    return {
      action: 'ALREADY_CARRIED',
      headline: 'Carried to the next session',
      reason:
        "Market closed with this position still open — it's now effectively a delivery position and will keep tracking against the live spot when trading resumes.",
    };
  }

  if (minutesToClose > CARRY_DECISION_WINDOW_MINUTES) {
    return null; // Plenty of the session left — too early for a carry call.
  }

  const isCall = signal.direction === 'CALL';
  const distanceToTarget = Math.abs(signal.targetSpot - live.spot);
  const distanceToStopLoss = Math.abs(signal.stopLossSpot - live.spot);
  const trendAligned = isCall ? live.spot > live.sma9 && live.rsi14 >= 50 : live.spot < live.sma9 && live.rsi14 <= 50;
  const closerToStopLoss = distanceToStopLoss < distanceToTarget;

  if (closerToStopLoss || !trendAligned) {
    return {
      action: 'LEAN_SQUARE_OFF',
      headline: 'Leaning toward squaring off',
      reason: closerToStopLoss
        ? `Price is closer to the stop-loss (${distanceToStopLoss.toFixed(1)}pts away) than the target (${distanceToTarget.toFixed(1)}pts away) with the close near — carrying adds overnight gap risk to a setup already trending the wrong way.`
        : `Spot/SMA(9)/RSI(14) no longer align with this ${signal.direction} — momentum has weakened — closing out avoids holding a fading setup overnight.`,
    };
  }

  return {
    action: 'LEAN_CARRY',
    headline: "Reasonable to carry if it doesn't resolve today",
    reason: `Trend still aligns with this ${signal.direction} and price is closer to target (${distanceToTarget.toFixed(1)}pts away) than stop-loss (${distanceToStopLoss.toFixed(1)}pts away) as the close approaches — carrying into the next session is defensible if it doesn't hit target in the next ${minutesToClose}m.`,
  };
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
