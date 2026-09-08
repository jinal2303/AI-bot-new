'use client';

import { useEffect, useMemo, useState } from 'react';
import { RefreshCcw, TriangleAlert, OctagonAlert } from 'lucide-react';
import { SpotPriceCard } from '@/components/spot-price-card';
import { SignalCard } from '@/components/signal-card';
import { NiftyChart } from '@/components/nifty-chart';
import { NotificationStatus } from '@/components/notification-status';
import { TodayStats } from '@/components/today-stats';
import { SignalsTable } from '@/components/signals-table';
import { ExitToastStack } from '@/components/exit-toast';
import { NewsPanel } from '@/components/news-panel';
import { Nav } from '@/components/nav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useSignalPolling } from '@/hooks/use-signal-polling';
import { useTodaySignals } from '@/hooks/use-today-signals';
import { useTradeSocket } from '@/hooks/use-trade-socket';
import { RiskConfig } from '@/lib/notifications';

export default function DashboardPage() {
  const { signal, isLoading, error, lastUpdated, notificationPermission } = useSignalPolling();
  const [permission, setPermission] = useState<NotificationPermission | null>(notificationPermission);

  useEffect(() => {
    setPermission(notificationPermission);
  }, [notificationPermission]);

  const riskConfig: RiskConfig | null = useMemo(() => {
    if (!signal?.tradeRules) return null;
    const { lotSize, maxRiskCashINR, targetCashINR } = signal.tradeRules;
    return { lotSize, maxRiskCashINR, targetCashINR };
  }, [signal?.tradeRules]);

  const { signals: todaySignals, error: todayError, upsertSignal } = useTodaySignals(riskConfig);
  const { toasts, dismissToast } = useTradeSocket({
    riskConfig,
    onSignalCreated: upsertSignal,
    onStatusChange: (payload) => upsertSignal(payload.signal),
  });

  // The persisted row backing the current LIVE SIGNAL, if any — its own
  // `timestamp` is the true "when was this call given" moment (set once, on
  // creation), unlike the /latest snapshot's `generatedAt` which can shift.
  const activeEntry = useMemo(() => todaySignals.find((row) => row.currentStatus === 'ACTIVE') ?? null, [todaySignals]);

  return (
    <main className="container max-w-6xl py-10">
      <ExitToastStack toasts={toasts} onDismiss={dismissToast} />

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
        <div className="flex items-center gap-3">
          <Nav />
          <NotificationStatus permission={permission} onPermissionChange={setPermission} />
        </div>
      </header>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
      {todayError && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          {todayError}
        </div>
      )}
      {signal?.dailyLimitReached && (
        <div className="mb-6 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
          <OctagonAlert className="h-4 w-4 shrink-0" />
          Daily signal limit reached ({signal.dailySignalCount}/{signal.maxDailySignals}) — evaluation is paused
          until tomorrow to prevent overtrading.
        </div>
      )}

      <div className="mb-6">
        <TodayStats signals={todaySignals} maxDailySignals={signal?.maxDailySignals ?? 10} />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <SpotPriceCard signal={signal} isLoading={isLoading} />
        <SignalCard signal={signal} isLoading={isLoading} activeEntry={activeEntry} />
      </div>

      <div className="mt-6">
        <NiftyChart series={signal?.series ?? []} tradeRules={signal?.tradeRules ?? null} />
      </div>

      <div className="mt-6">
        <NewsPanel />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            TODAY&apos;S SIGNALS
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SignalsTable signals={todaySignals} emptyMessage="No signals generated yet today." />
        </CardContent>
      </Card>

      <footer className="mt-10 border-t border-border pt-6 text-xs text-muted-foreground">
        <p>
          Strategy: BUY CALL (CE) when Spot &gt; SMA(9) and 55 ≤ RSI(14) ≤ 65. BUY PUT (PE) when Spot
          &lt; SMA(9) and 35 ≤ RSI(14) ≤ 45. Expiry: Fri/Mon/Tue → Current Week, Wed/Thu → Next Week.
          Risk (1 lot, 65 units, Δ 0.5 proxy): stop-loss/target scale with ATR(14) volatility, not a fixed
          point count. Max {signal?.maxDailySignals ?? 10} signals/day. Data source: Yahoo Finance (^NSEI, 5m
          candles). Educational use only — not investment advice.
        </p>
      </footer>
    </main>
  );
}
