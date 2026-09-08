'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLatestSignal } from '@/lib/api';
import { notifyNewSignal, requestNotificationPermission } from '@/lib/notifications';
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
 * Polls GET /api/signals/latest every 30 seconds, requests desktop
 * notification permission on mount, and fires a native notification the
 * moment a fresh BUY CALL / BUY PUT signal (a new signal `id`) is detected
 * that's actionable and different from whatever we last processed.
 */
export function useSignalPolling(): UseSignalPollingResult {
  const [signal, setSignal] = useState<SignalData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | null>(
    null,
  );

  // Tracks the last signal id/timestamp we've already reacted to, so we
  // never fire a duplicate notification for the same signal on re-render.
  const lastProcessedSignalId = useRef<string | null>(null);
  // The very first successful fetch establishes a baseline — we don't want
  // to fire a desktop notification for a signal that was already active
  // before the dashboard was opened.
  const hasEstablishedBaseline = useRef(false);

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

      const isFreshSignal = latest.id !== lastProcessedSignalId.current;
      const isActionable = latest.signal !== 'NO_SIGNAL';

      if (isFreshSignal && isActionable && hasEstablishedBaseline.current) {
        notifyNewSignal(latest);
      }

      lastProcessedSignalId.current = latest.id;
      hasEstablishedBaseline.current = true;
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
