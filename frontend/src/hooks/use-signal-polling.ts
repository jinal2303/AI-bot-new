'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchLatestSignal } from '@/lib/api';
import { requestNotificationPermission } from '@/lib/notifications';
import { SignalData } from '@/lib/types';

const POLL_INTERVAL_MS = 30_000;

export interface UseSignalPollingResult {
  signal: SignalData | null;
  isLoading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  notificationPermission: NotificationPermission | null;
}

/**
 * Polls GET /api/signals/latest every 30 seconds for the live spot/SMA/RSI
 * snapshot, chart series, and daily-throttle state, and requests desktop
 * notification permission on mount. Entry-signal desktop notifications are
 * handled separately by useTodaySignals — that hook watches the persisted
 * TradeSignal rows (GET /api/signals/today), which is the actual source of
 * truth for "a new signal was created", rather than this ephemeral snapshot.
 */
export function useSignalPolling(): UseSignalPollingResult {
  const [signal, setSignal] = useState<SignalData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | null>(
    null,
  );

  const poll = useCallback(async () => {
    try {
      const latest = await fetchLatestSignal();

      if (!latest) {
        setError('Unable to reach the signal API. Retrying on the next poll…');
        return;
      }

      setError(null);
      setSignal(latest);
      setLastUpdated(new Date());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error while polling signals.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    requestNotificationPermission()
      .then((permission) => {
        if (isMounted) setNotificationPermission(permission);
      })
      .catch(() => {
        /* Permission prompt failures are non-fatal — dashboard still works. */
      });

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, [poll]);

  return { signal, isLoading, error, lastUpdated, notificationPermission };
}
