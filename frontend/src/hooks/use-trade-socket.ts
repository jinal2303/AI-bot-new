'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { WS_BASE_URL } from '@/lib/api';
import { notifyExit, notifyNewEntry } from '@/lib/notifications';
import { SignalStatusChangedPayload, TradeSignal } from '@/lib/trade-signal';

export interface ExitToastItem extends SignalStatusChangedPayload {
  toastId: string;
}

export interface UseTradeSocketOptions {
  /** Called the instant a fresh signal is persisted, so the caller can upsert it into its today's-signals list. */
  onSignalCreated?: (signal: TradeSignal) => void;
  /** Called the instant an ACTIVE position resolves, so the caller can upsert the update into its list. */
  onStatusChange?: (payload: SignalStatusChangedPayload) => void;
}

export interface UseTradeSocketResult {
  connected: boolean;
  toasts: ExitToastItem[];
  dismissToast: (toastId: string) => void;
}

/**
 * Connects to the backend's realtime gateway and listens for both trade
 * lifecycle events:
 *  - 'signal-created' — fired the instant the 60s strategy tick persists a
 *    fresh signal. Fires the "🚨 BOT SIGNAL DETECTED!" desktop notification
 *    immediately, instead of waiting up to 30s for the next /today poll.
 *  - 'signal-status-changed' — fired the instant the 10s position monitor
 *    resolves an ACTIVE trade to TARGET_HIT / STOPLOSS_HIT. Fires the native
 *    desktop exit notification + audio chime and pushes an in-app toast
 *    (the "Live Exit Popup").
 */
export function useTradeSocket({ onSignalCreated, onStatusChange }: UseTradeSocketOptions): UseTradeSocketResult {
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<ExitToastItem[]>([]);
  const onSignalCreatedRef = useRef(onSignalCreated);
  onSignalCreatedRef.current = onSignalCreated;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  useEffect(() => {
    const socket: Socket = io(WS_BASE_URL, { transports: ['websocket'] });

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err: Error) => {
      // eslint-disable-next-line no-console
      console.error('[trade-socket] connection error:', err.message);
    });

    socket.on('signal-created', (payload: { signal: TradeSignal }) => {
      notifyNewEntry(payload.signal);
      onSignalCreatedRef.current?.(payload.signal);
    });

    socket.on('signal-status-changed', (payload: SignalStatusChangedPayload) => {
      notifyExit(payload.signal, payload.netCashINR);
      setToasts((prev) => [...prev, { ...payload, toastId: `${payload.signal.id}-${payload.signal.currentStatus}` }]);
      onStatusChangeRef.current?.(payload);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const dismissToast = useCallback((toastId: string) => {
    setToasts((prev) => prev.filter((toast) => toast.toastId !== toastId));
  }, []);

  return { connected, toasts, dismissToast };
}
