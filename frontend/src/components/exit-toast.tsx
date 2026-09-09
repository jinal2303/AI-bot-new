'use client';

import { useEffect } from 'react';
import { Clock, ShieldAlert, ShieldCheck, Target, X } from 'lucide-react';
import { ExitToastItem } from '@/hooks/use-trade-socket';
import { cn } from '@/lib/utils';

const EXIT_COPY: Record<ExitToastItem['signal']['currentStatus'], { title: string; icon: typeof Target }> = {
  ACTIVE: { title: 'POSITION UPDATE', icon: Target }, // never actually rendered (toasts only fire on resolution) — exhaustiveness only.
  TARGET_HIT: { title: '🎯 TARGET ACHIEVED!', icon: Target },
  TRAIL_STOP_HIT: { title: '🛡️ TRAILING STOP HIT', icon: ShieldCheck },
  STOPLOSS_HIT: { title: '⚠️ STOP-LOSS TRIGGERED', icon: ShieldAlert },
  TIME_EXIT: { title: '⏱️ TIME-DECAY EXIT', icon: Clock },
};

interface ExitToastStackProps {
  toasts: ExitToastItem[];
  onDismiss: (toastId: string) => void;
}

const AUTO_DISMISS_MS = 8000;

/** Fixed top-right stack of live exit popups — the in-app half of the "Live Exit Popup Engine" (the other half is the native desktop notification). */
export function ExitToastStack({ toasts, onDismiss }: ExitToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-full max-w-sm flex-col gap-3">
      {toasts.map((toast) => (
        <ExitToastCard key={toast.toastId} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ExitToastCard({ toast, onDismiss }: { toast: ExitToastItem; onDismiss: (toastId: string) => void }) {
  // "Win" styling is by realized P&L sign, not a hardcoded status — a
  // TRAIL_STOP_HIT is always a locked-in win/scratch, and a TIME_EXIT can
  // land on either side of entry.
  const isWin = toast.netCashINR >= 0;
  const { title, icon: Icon } = EXIT_COPY[toast.signal.currentStatus];

  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.toastId), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [toast.toastId, onDismiss]);

  return (
    <div
      className={cn(
        'pointer-events-auto animate-in slide-in-from-right-4 fade-in rounded-lg border-2 bg-card p-4 shadow-2xl',
        isWin ? 'border-emerald-500 shadow-emerald-500/20' : 'border-red-700 shadow-red-700/20',
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
            isWin ? 'bg-emerald-500/15 text-emerald-500' : 'bg-red-700/15 text-red-500',
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className={cn('font-semibold', isWin ? 'text-emerald-500' : 'text-red-500')}>{title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            NIFTY {toast.signal.strikePrice} {toast.signal.direction === 'CALL' ? 'CE' : 'PE'} · exit spot{' '}
            {toast.livePrice.toLocaleString('en-IN')}
          </p>
          <p className={cn('mt-1 text-sm font-semibold tabular-nums', isWin ? 'text-emerald-500' : 'text-red-500')}>
            Net: {isWin ? '+' : '-'}₹{Math.abs(toast.netCashINR).toLocaleString('en-IN')} per lot
          </p>
        </div>
        <button
          onClick={() => onDismiss(toast.toastId)}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
