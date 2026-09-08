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
   * Exact realized cash P&L for 1 lot (positive for TARGET_HIT, negative for
   * STOPLOSS_HIT) — optionPoints × lotSize, not the desk's rounded pre-trade
   * estimate quoted on entry.
   */
  netCashINR: number;
}
