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
    const stoplossHit = signals.filter((s) => s.currentStatus === 'STOPLOSS_HIT').length;
    const resolved = targetHit + stoplossHit;
    const winRate = resolved > 0 ? Math.round((targetHit / resolved) * 100) : null;

    return { total, active, targetHit, stoplossHit, winRate };
  }, [signals]);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      <StatTile label="Today" value={`${stats.total} / ${maxDailySignals}`} />
      <StatTile label="Active" value={stats.active} tone="active" />
      <StatTile label="Target Hit" value={stats.targetHit} tone="target" />
      <StatTile label="Stop-Loss Hit" value={stats.stoplossHit} tone="stoploss" />
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
  tone?: 'active' | 'target' | 'stoploss';
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
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
