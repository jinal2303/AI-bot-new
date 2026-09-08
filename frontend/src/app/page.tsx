'use client';

import { useEffect, useState } from 'react';
import { RefreshCcw, TriangleAlert } from 'lucide-react';
import { SpotPriceCard } from '@/components/spot-price-card';
import { SignalCard } from '@/components/signal-card';
import { NiftyChart } from '@/components/nifty-chart';
import { NotificationStatus } from '@/components/notification-status';
import { useSignalPolling } from '@/hooks/use-signal-polling';

export default function DashboardPage() {
  const { signal, isLoading, error, lastUpdated, notificationPermission } = useSignalPolling();
  const [permission, setPermission] = useState<NotificationPermission | null>(notificationPermission);

  useEffect(() => {
    setPermission(notificationPermission);
  }, [notificationPermission]);

  return (
    <main className="container max-w-6xl py-10">
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Nifty 50 Options Signal Tracker
          </h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <RefreshCcw className="h-3.5 w-3.5" />
            Polling every 30s
            {lastUpdated && (
              <span>
                · Last updated{' '}
                {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
          </p>
        </div>
        <NotificationStatus permission={permission} onPermissionChange={setPermission} />
      </header>

      {error && (
        <div className="mb-6 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <SpotPriceCard signal={signal} isLoading={isLoading} />
        <SignalCard signal={signal} isLoading={isLoading} />
      </div>

      <div className="mt-6">
        <NiftyChart series={signal?.series ?? []} tradeRules={signal?.tradeRules ?? null} />
      </div>

      <footer className="mt-10 border-t border-border pt-6 text-xs text-muted-foreground">
        <p>
          Strategy: BUY CALL (CE) when Spot &gt; SMA(9) and 55 ≤ RSI(14) ≤ 65. BUY PUT (PE) when Spot
          &lt; SMA(9) and 35 ≤ RSI(14) ≤ 45. Expiry: Fri/Mon/Tue → Current Week, Wed/Thu → Next Week.
          Risk (1 lot, 65 units, Δ 0.5 proxy): index target 60 pts / SL 30 pts → +₹1,900 / -₹975 cash.
          Data source: Yahoo Finance (^NSEI, 5m candles). Educational use only — not investment advice.
        </p>
      </footer>
    </main>
  );
}
