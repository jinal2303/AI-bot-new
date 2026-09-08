import { Injectable } from '@nestjs/common';
import { buildISTMidnight, getISTDateParts, toISTIsoDate, toISTLabel } from '../common/ist-time.util';
import { ExpiryCycle, ExpiryInfo } from '../signals/signals.types';

/**
 * NSE's weekly options-expiry weekday. Historically Thursday for Nifty;
 * exchanges have revised this more than once, so it's kept as a single
 * named constant to update in one place if/when it changes again.
 */
const EXPIRY_WEEKDAY = 4; // 0 = Sun ... 4 = Thu ... 6 = Sat

/**
 * Chooses which weekly options-expiry cycle to trade, purely from the day
 * of the week (IST):
 *  - Friday, Monday, Tuesday -> CURRENT_WEEK  (fresh premium, ample runway)
 *  - Wednesday, Thursday     -> NEXT_WEEK     (skip this week's expiry to
 *                                              dodge the terminal Theta cliff)
 */
@Injectable()
export class ExpiryService {
  computeExpiryTarget(date: Date = new Date()): ExpiryInfo {
    const parts = getISTDateParts(date);
    const cycle = this.resolveCycle(parts.weekday);

    const daysUntilCurrentExpiry = (EXPIRY_WEEKDAY - parts.weekday + 7) % 7;
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

  private resolveCycle(weekday: number): ExpiryCycle {
    // weekday: 0 Sun, 1 Mon, 2 Tue, 3 Wed, 4 Thu, 5 Fri, 6 Sat
    if (weekday === 5 || weekday === 1 || weekday === 2) return 'CURRENT_WEEK';
    if (weekday === 3 || weekday === 4) return 'NEXT_WEEK';
    // Weekend fallback — the live cron never runs here since the market is
    // closed, but keep the function total for direct/manual/test calls.
    return 'CURRENT_WEEK';
  }
}
