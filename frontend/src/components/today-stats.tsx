import { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { TradeSignal } from '@/lib/trade-signal';
import { cn } from '@/lib/utils';

interface TodayStatsProps {
  signals: TradeSignal[];
  maxDailySignals: number;
}

export function TodayStats({ signals, maxDailySignals }: TodayStatsProps) {
  const stats = useMemo(() => {
    const total = signals.length;
    const active = signals.filter((s) => s.currentStatus === 'ACTIVE').length;
    const targetHit = signals.filter((s) => s.currentStatus === 'TARGET_HIT').length;
    const trailStopHit = signals.filter((s) => s.currentStatus === 'TRAIL_STOP_HIT').length;
    const stoplossHit = signals.filter((s) => s.currentStatus === 'STOPLOSS_HIT').length;
    const timeExit = signals.filter((s) => s.currentStatus === 'TIME_EXIT').length;

    // "Win" = a profitable-or-scratch resolved trade, by realized P&L —
    // not a hardcoded status list. TARGET_HIT/TRAIL_STOP_HIT always land
    // here (they only ever fire on the favorable side); TIME_EXIT can
    // legitimately go either way, so its sign decides it.
    const resolved = signals.filter((s) => s.currentStatus !== 'ACTIVE');
    const wins = resolved.filter((s) => (s.netCashINR ?? 0) >= 0).length;
    const winRate = resolved.length > 0 ? Math.round((wins / resolved.length) * 100) : null;

    return { total, active, targetHit, trailStopHit, stoplossHit, timeExit, winRate };
  }, [signals]);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      <StatTile label="Today" value={`${stats.total} / ${maxDailySignals}`} />
      <StatTile label="Active" value={stats.active} tone="active" />
      <StatTile label="Target Hit" value={stats.targetHit} tone="target" />
      <StatTile label="Trail Stop" value={stats.trailStopHit} tone="trailstop" />
      <StatTile label="Stop-Loss Hit" value={stats.stoplossHit} tone="stoploss" />
      <StatTile label="Time Exit" value={stats.timeExit} tone="timeexit" />
      <StatTile label="Win Rate" value={stats.winRate !== null ? `${stats.winRate}%` : '—'} />
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'active' | 'target' | 'stoploss' | 'trailstop' | 'timeexit';
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p
          className={cn(
            'mt-1 text-2xl font-bold tabular-nums',
            tone === 'active' && 'text-amber-400',
            tone === 'target' && 'text-emerald-500',
            tone === 'stoploss' && 'text-red-500',
            tone === 'trailstop' && 'text-sky-400',
            tone === 'timeexit' && 'text-slate-400',
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
