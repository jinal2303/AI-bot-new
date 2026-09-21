/**
 * Utilities to determine whether the NSE (National Stock Exchange of India)
 * cash/derivatives market is currently open. Indian market hours are
 * 09:15 - 15:30 IST, Monday to Friday (holidays are not accounted for here;
 * plug in a holiday calendar feed if strict accuracy is required).
 */
import { getISTDateParts } from './ist-time.util';

const MARKET_OPEN_MINUTES = 9 * 60 + 15; // 09:15
const MARKET_CLOSE_MINUTES = 15 * 60 + 30; // 15:30

/**
 * Returns true when `date` (defaults to now) falls within Indian market
 * trading hours on a weekday.
 */
export function isIndianMarketOpen(date: Date = new Date()): boolean {
  const { weekday, hour, minute } = getISTDateParts(date);
  const minutesSinceMidnight = hour * 60 + minute;

  const isWeekday = weekday >= 1 && weekday <= 5;
  const isTradingWindow =
    minutesSinceMidnight >= MARKET_OPEN_MINUTES && minutesSinceMidnight <= MARKET_CLOSE_MINUTES;

  return isWeekday && isTradingWindow;
}

/**
 * Minutes remaining until the 15:30 IST close (negative once past it) —
 * lets a caller derive its own "N minutes before close" cutoff (e.g. the
 * position monitor's mandatory EOD square-off) directly off the single
 * source of truth for the close time, instead of hardcoding a second clock
 * that could drift out of sync if the exchange ever revises market hours.
 */
export function minutesUntilMarketClose(date: Date = new Date()): number {
  const { hour, minute } = getISTDateParts(date);
  return MARKET_CLOSE_MINUTES - (hour * 60 + minute);
}

// --- SESSION WINDOW UPPER LIMITS (caps, not goals) ---------------------------
// SignalsService caps how many NEW positions may be *opened* within each
// named intraday window — a supplementary throttle to the overall daily
// cap, independent of it. Deliberately named/scoped separately from
// MARKET_OPEN_MINUTES/MARKET_CLOSE_MINUTES above: the three windows span
// 09:15-14:30 (cut off early, per desk request 2026-09-17 — no new trades
// in the final ~an-hour stretch into close), not the full 09:15-15:30
// market-open range. See SignalsService's session-window-cap filter.
export type SessionWindow = 'MORNING' | 'MIDDAY' | 'AFTERNOON';

/** [startInclusive, endExclusive) minutes-since-midnight IST boundaries for each named window. */
export const SESSION_WINDOW_BOUNDS: Record<SessionWindow, { startMinutes: number; endMinutes: number }> = {
  MORNING: { startMinutes: 9 * 60 + 15, endMinutes: 10 * 60 + 30 }, // 09:15–10:30
  MIDDAY: { startMinutes: 10 * 60 + 30, endMinutes: 13 * 60 + 15 }, // 10:30–13:15
  AFTERNOON: { startMinutes: 13 * 60 + 15, endMinutes: 14 * 60 + 30 }, // 13:15–14:30
};

/**
 * Which named session window `date` (defaults to now) falls in, or `null`
 * outside all three — pre-open, or past 14:30 IST (no new entries for the
 * rest of the day, regardless of any window's remaining headroom; existing
 * open positions are still tracked and squared off as usual at EOD).
 */
export function getSessionWindow(date: Date = new Date()): SessionWindow | null {
  const { hour, minute } = getISTDateParts(date);
  const minutesSinceMidnight = hour * 60 + minute;

  for (const window of Object.keys(SESSION_WINDOW_BOUNDS) as SessionWindow[]) {
    const { startMinutes, endMinutes } = SESSION_WINDOW_BOUNDS[window];
    if (minutesSinceMidnight >= startMinutes && minutesSinceMidnight < endMinutes) {
      return window;
    }
  }
  return null;
}
