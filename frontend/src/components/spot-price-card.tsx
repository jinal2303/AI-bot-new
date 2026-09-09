import type { ReactNode } from 'react';
import { Activity, ArrowDownToLine, ArrowUpToLine, CalendarClock, TrendingDown, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SignalData } from '@/lib/types';
import { cn } from '@/lib/utils';

interface SpotPriceCardProps {
  signal: SignalData | null;
  isLoading: boolean;
}

export function SpotPriceCard({ signal, isLoading }: SpotPriceCardProps) {
  const isAboveSma = signal ? signal.spot > signal.sma9 : null;

  return (
    <Card className="grid-glow relative overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            NIFTY 50 SPOT
          </CardTitle>
          <Badge variant={signal?.marketOpen ? 'bullish' : 'outline'} className="gap-1">
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                signal?.marketOpen ? 'bg-bullish-foreground animate-pulse' : 'bg-muted-foreground',
              )}
            />
            {signal?.marketOpen ? 'Market Open' : 'Market Closed'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && !signal ? (
          <div className="h-12 w-48 animate-pulse rounded-md bg-muted" />
        ) : (
          <>
            <span className="text-5xl font-bold tracking-tight tabular-nums">
              {signal ? signal.spot.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}
            </span>
            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              {signal && <DayChangeStat dayChange={signal.dayChange} dayChangePercent={signal.dayChangePercent} />}
              {isAboveSma !== null && (
                <span
                  className={cn(
                    'flex items-center gap-1 text-sm font-medium',
                    isAboveSma ? 'text-bullish' : 'text-bearish',
                  )}
                >
                  {isAboveSma ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                  {isAboveSma ? 'Above SMA(9)' : 'Below SMA(9)'}
                </span>
              )}
            </div>
          </>
        )}

        <div className="mt-6 grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
          <IndicatorStat label="SMA (9)" value={signal?.sma9} />
          <IndicatorStat label="RSI (14)" value={signal?.rsi14} highlight={rsiHighlight(signal?.rsi14)} />
          <IndicatorStat label="ATR (14)" value={signal?.atr14} />
          <IndicatorStat label="ATM Strike" value={signal?.atmStrike} decimals={0} />
        </div>

        {signal && (
          <>
            <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" />
              Expiry target: {signal.expiry.label}
            </p>

            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4">
              <RangeStat label="Day High" value={signal.dailyLevels.dayHigh} icon={<ArrowUpToLine className="h-3.5 w-3.5" />} tone="bullish" />
              <RangeStat label="Day Low" value={signal.dailyLevels.dayLow} icon={<ArrowDownToLine className="h-3.5 w-3.5" />} tone="bearish" />
            </div>

            <div className="mt-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Support / Resistance <span className="normal-case text-muted-foreground/70">(prev-session pivots)</span>
              </p>
              <div className="mt-2 grid grid-cols-5 gap-1.5 text-center">
                <PivotStat label="R2" value={signal.dailyLevels.resistance2} tone="bearish" />
                <PivotStat label="R1" value={signal.dailyLevels.resistance1} tone="bearish" />
                <PivotStat label="P" value={signal.dailyLevels.pivot} tone="neutral" />
                <PivotStat label="S1" value={signal.dailyLevels.support1} tone="bullish" />
                <PivotStat label="S2" value={signal.dailyLevels.support2} tone="bullish" />
              </div>
            </div>
          </>
        )}
      </CardContent>
      <Activity className="pointer-events-none absolute -bottom-6 -right-6 h-32 w-32 text-primary/5" />
    </Card>
  );
}

function DayChangeStat({ dayChange, dayChangePercent }: { dayChange: number; dayChangePercent: number }) {
  const isUp = dayChange >= 0;
  const sign = isUp ? '+' : '-';

  return (
    <span className={cn('flex items-center gap-1 text-sm font-semibold tabular-nums', isUp ? 'text-bullish' : 'text-bearish')}>
      {isUp ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
      {sign}
      {Math.abs(dayChange).toLocaleString('en-IN', { maximumFractionDigits: 2 })} ({sign}
      {Math.abs(dayChangePercent).toFixed(2)}%) today
    </span>
  );
}

function RangeStat({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  tone: 'bullish' | 'bearish';
}) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-secondary/30 px-3 py-2">
      <span className={cn('flex h-6 w-6 items-center justify-center rounded-full', tone === 'bullish' ? 'bg-bullish/15 text-bullish' : 'bg-bearish/15 text-bearish')}>
        {icon}
      </span>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-semibold tabular-nums">{value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</p>
      </div>
    </div>
  );
}

function PivotStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'bullish' | 'bearish' | 'neutral';
}) {
  return (
    <div
      className={cn(
        'rounded-md border px-1.5 py-1.5',
        tone === 'bullish' && 'border-bullish/30 bg-bullish/5',
        tone === 'bearish' && 'border-bearish/30 bg-bearish/5',
        tone === 'neutral' && 'border-border bg-secondary/30',
      )}
    >
      <p
        className={cn(
          'text-[10px] font-semibold uppercase tracking-wide',
          tone === 'bullish' && 'text-bullish',
          tone === 'bearish' && 'text-bearish',
          tone === 'neutral' && 'text-muted-foreground',
        )}
      >
        {label}
      </p>
      <p className="text-xs font-semibold tabular-nums">{value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
    </div>
  );
}

function rsiHighlight(rsi?: number): 'bullish' | 'bearish' | undefined {
  if (rsi === undefined) return undefined;
  if (rsi >= 55 && rsi <= 65) return 'bullish';
  if (rsi >= 35 && rsi <= 45) return 'bearish';
  return undefined;
}

function IndicatorStat({
  label,
  value,
  decimals = 2,
  highlight,
}: {
  label: string;
  value?: number;
  decimals?: number;
  highlight?: 'bullish' | 'bearish';
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1 text-lg font-semibold tabular-nums',
          highlight === 'bullish' && 'text-bullish',
          highlight === 'bearish' && 'text-bearish',
        )}
      >
        {value !== undefined ? value.toLocaleString('en-IN', { maximumFractionDigits: decimals }) : '—'}
      </p>
    </div>
  );
}
