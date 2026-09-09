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
