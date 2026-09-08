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
