import { TradeSignal } from '@prisma/client';

/** Internal event name SignalsService emits right after persisting a new signal. */
export const TRADE_CREATED_EVENT = 'trade.created';

/** Payload carried by that event — just the freshly-created row. */
export interface TradeCreatedPayload {
  signal: TradeSignal;
}

/** Internal event name the position monitor emits on a status change. */
export const TRADE_STATUS_CHANGED_EVENT = 'trade.status-changed';

/** Payload carried by that event — consumed by the realtime WebSocket gateway. */
export interface TradeStatusChangedPayload {
  signal: TradeSignal;
  livePrice: number;
  /**
   * Exact realized cash P&L for 1 lot (positive for TARGET_HIT/TRAIL_STOP_HIT,
   * negative for STOPLOSS_HIT, either for TIME_EXIT) — optionPoints × lotSize,
   * not the desk's rounded pre-trade estimate quoted on entry.
   */
  netCashINR: number;
  /**
   * Human-readable exit reason, when this wasn't a plain target/stop-loss
   * boundary hit — e.g. "mandatory EOD square-off", "Target Revised &
   * Profit Locked at 62%", "stale position — profit decayed below the
   * giveback floor". Undefined for an ordinary TARGET_HIT/STOPLOSS_HIT.
   */
  reason?: string;
}

/** Internal event name the position monitor emits on every newly-crossed target-progress milestone. */
export const TARGET_MILESTONE_EVENT = 'trade.target-milestone';

/**
 * Payload carried by that event — one per milestone crossed (a fast move
 * that jumps over more than one 10% band between two 10s ticks fires one of
 * these per band, oldest first), consumed by the realtime WebSocket gateway.
 */
export interface TargetMilestonePayload {
  signal: TradeSignal;
  /** The 10%-band milestone just crossed: one of 30/40/50/60/70/80/90. */
  milestonePct: number;
  /** The exact computed progress at this tick — may be ahead of `milestonePct` (e.g. 47.3% when the 40% band fired). */
  progressPct: number;
  livePrice: number;
}
