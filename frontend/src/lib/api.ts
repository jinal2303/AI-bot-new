import { SignalData } from './types';
import { ArchiveFilters, ArchiveResult, TradeSignal } from './trade-signal';
import { NewsHeadline } from './news';

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
/** Derived from API_BASE_URL (strip the trailing /api) for the WebSocket gateway. */
export const WS_BASE_URL = API_BASE_URL.replace(/\/api\/?$/, '');

/**
 * Fetches the latest signal snapshot from the NestJS backend. Wrapped in a
 * try/catch so transient network hiccups against the backend never crash
 * the polling loop — callers get `null` and can decide how to degrade.
 */
export async function fetchLatestSignal(): Promise<SignalData | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/signals/latest`, {
      // Always hit the network — this is a live trading dashboard.
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Backend responded with status ${response.status}`);
    }

    return (await response.json()) as SignalData;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // eslint-disable-next-line no-console
    console.error(`[api] Failed to fetch latest signal: ${message}`);
    return null;
  }
}

/** Fetches every signal generated on the current IST calendar date. */
export async function fetchTodaySignals(): Promise<TradeSignal[] | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/signals/today`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Backend responded with status ${response.status}`);
    }
    return (await response.json()) as TradeSignal[];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // eslint-disable-next-line no-console
    console.error(`[api] Failed to fetch today's signals: ${message}`);
    return null;
  }
}

/** Fetches filtered, paginated historical signals for the archive screen. */
export async function fetchArchive(filters: ArchiveFilters): Promise<ArchiveResult | null> {
  try {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.direction) params.set('direction', filters.direction);
    if (filters.expiryType) params.set('expiryType', filters.expiryType);
    if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) params.set('dateTo', filters.dateTo);
    if (filters.limit) params.set('limit', String(filters.limit));
    if (filters.offset) params.set('offset', String(filters.offset));

    const response = await fetch(`${API_BASE_URL}/signals/archive?${params.toString()}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`Backend responded with status ${response.status}`);
    }
    return (await response.json()) as ArchiveResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // eslint-disable-next-line no-console
    console.error(`[api] Failed to fetch archive: ${message}`);
    return null;
  }
}

/** Fetches the latest market headlines — informational only, doesn't affect signal logic. */
export async function fetchNewsHeadlines(): Promise<NewsHeadline[] | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/news/headlines`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Backend responded with status ${response.status}`);
    }
    return (await response.json()) as NewsHeadline[];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // eslint-disable-next-line no-console
    console.error(`[api] Failed to fetch news headlines: ${message}`);
    return null;
  }
}
