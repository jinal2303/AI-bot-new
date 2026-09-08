import { SignalData } from './types';

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';

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
