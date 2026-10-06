'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTodaySignals } from '@/lib/api';
import { notifyNewEntry } from '@/lib/notifications';
import { TradeSignal } from '@/lib/trade-signal';

const POLL_INTERVAL_MS = 10;

export interface UseTodaySignalsResult {
  signals: TradeSignal[];
  isLoading: boolean;
  error: string | null;
  /** Upserts a WebSocket-delivered row (a new signal, or a status update) into the list immediately, without waiting for the next poll. */
  upsertSignal: (updated: TradeSignal) => void;
}

/**
 * Polls GET /api/signals/today every 5 seconds. Today's signals never get
 * deleted mid-day (the backend only ever appends), so the returned list is
 * always the full, persistent, append-only feed the "Today" screen renders.
 *
 * Fires the "🚨 BOT SIGNAL DETECTED!" entry notification the moment a row
 * with an id we haven't seen yet appears — since each TradeSignal row is
 * created exactly once, a new id unambiguously means a new signal event.
 */
export function useTodaySignals(): UseTodaySignalsResult {
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seenIds = useRef<Set<string>>(new Set());
  // The first successful fetch establishes a baseline — rows already on the
  // board when the dashboard opens shouldn't fire a "new" notification.
  const hasBaseline = useRef(false);

  const poll = useCallback(async () => {
    try {
      const data = await fetchTodaySignals();
      if (!data) {
        setError("Unable to reach the signal API. Retrying on the next poll…");
        return;
      }

      setError(null);

      if (hasBaseline.current) {
        const freshRows = data.filter((row) => !seenIds.current.has(row.id));
        freshRows.forEach((row) => notifyNewEntry(row));
      }

      data.forEach((row) => seenIds.current.add(row.id));
      hasBaseline.current = true;
      setSignals(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error while polling today\'s signals.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void poll();
    const intervalId = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [poll]);

  const upsertSignal = useCallback((updated: TradeSignal) => {
    setSignals((prev) => {
      const exists = prev.some((row) => row.id === updated.id);
      // A signal that both opens AND resolves between two 5s polls would
      // otherwise never have been in `prev` for a plain .map() to find — the
      // WS event carries the full row either way, so insert it fresh
      // (newest-first) rather than dropping the update.
      return exists ? prev.map((row) => (row.id === updated.id ? updated : row)) : [updated, ...prev];
    });
    seenIds.current.add(updated.id);
  }, []);

  return { signals, isLoading, error, upsertSignal };
}
