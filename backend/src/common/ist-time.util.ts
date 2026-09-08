/**
 * Shared IST (Asia/Kolkata, UTC+5:30, no DST) date/time helpers. India has a
 * single fixed offset year-round, so a plain millisecond shift is enough —
 * no ICU/Intl timezone database lookups needed, and it's immune to the host
 * server's own timezone.
 */

const IST_OFFSET_MINUTES = 330; // UTC+5:30
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ISTDateParts {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 0 = Sunday ... 6 = Saturday
  hour: number;
  minute: number;
}

/** Breaks a UTC instant down into its IST wall-clock calendar/time parts. */
export function getISTDateParts(date: Date = new Date()): ISTDateParts {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/**
 * Builds the UTC instant corresponding to IST midnight on the given
 * (year, month, day), optionally offset by `addDays`.
 */
export function buildISTMidnight(year: number, month: number, day: number, addDays = 0): Date {
  const utcMidnightForISTDate = Date.UTC(year, month - 1, day) + addDays * MS_PER_DAY;
  return new Date(utcMidnightForISTDate - IST_OFFSET_MS);
}

/** Returns the ISO calendar date (YYYY-MM-DD) `date` falls on in IST. */
export function toISTIsoDate(date: Date): string {
  const { year, month, day } = getISTDateParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Returns a human-readable IST calendar date, e.g. "11 Sep 2026". */
export function toISTLabel(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}
