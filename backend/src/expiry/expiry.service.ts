import { Injectable } from '@nestjs/common';
import { buildISTMidnight, getISTDateParts, toISTIsoDate, toISTLabel } from '../common/ist-time.util';
import { ExpiryCycle, ExpiryInfo } from '../signals/signals.types';

/**
 * NSE's weekly options-expiry weekday. Tuesday for Nifty (moved from
 * Thursday in Sept 2025); exchanges have revised this more than once, so
 * it's kept as a single named constant to update in one place if/when it
 * changes again. Everything below — including which cycle to trade — is
 * derived from this constant, not from a per-weekday table.
 */
const EXPIRY_WEEKDAY = 2; // 0 = Sun ... 2 = Tue ... 6 = Sat

/**
 * Minimum calendar days of runway the current-week expiry must still have
 * for it to be worth trading. With less than this, the option sits in its
 * terminal Theta cliff, so the next week's expiry is traded instead.
 */
const MIN_DAYS_TO_TRADE_CURRENT_WEEK = 2;

/**
 * Chooses which weekly options-expiry cycle to trade, from how many days
 * are left until this week's expiry (IST). With the Tuesday expiry:
 *  - Wednesday, Thursday, Friday -> CURRENT_WEEK  (4-6 days of runway)
 *  - Monday, Tuesday             -> NEXT_WEEK     (1 day / expiry day itself —
 *                                                  skip to dodge the Theta cliff)
 */
@Injectable()
export class ExpiryService {
  computeExpiryTarget(date: Date = new Date()): ExpiryInfo {
    const parts = getISTDateParts(date);
    const daysUntilCurrentExpiry = (EXPIRY_WEEKDAY - parts.weekday + 7) % 7;
    const cycle = this.resolveCycle(daysUntilCurrentExpiry);

    const currentWeekExpiry = buildISTMidnight(parts.year, parts.month, parts.day, daysUntilCurrentExpiry);
    const nextWeekExpiry = new Date(currentWeekExpiry.getTime() + 7 * 24 * 60 * 60 * 1000);

    const targetExpiry = cycle === 'CURRENT_WEEK' ? currentWeekExpiry : nextWeekExpiry;
    const cycleLabel = cycle === 'CURRENT_WEEK' ? 'Current Week' : 'Next Week';

    return {
      cycle,
      date: toISTIsoDate(targetExpiry),
      label: `${toISTLabel(targetExpiry)} (${cycleLabel})`,
    };
  }

  private resolveCycle(daysUntilCurrentExpiry: number): ExpiryCycle {
    return daysUntilCurrentExpiry >= MIN_DAYS_TO_TRADE_CURRENT_WEEK ? 'CURRENT_WEEK' : 'NEXT_WEEK';
  }
}
