import { Activity, CalendarClock, TrendingDown, TrendingUp } from 'lucide-react';
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
          <div className="flex items-baseline gap-3">
            <span className="text-5xl font-bold tracking-tight tabular-nums">
              {signal ? signal.spot.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}
            </span>
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
        )}

        <div className="mt-6 grid grid-cols-3 gap-4 border-t border-border pt-4">
          <IndicatorStat label="SMA (9)" value={signal?.sma9} />
          <IndicatorStat label="RSI (14)" value={signal?.rsi14} highlight={rsiHighlight(signal?.rsi14)} />
          <IndicatorStat label="ATM Strike" value={signal?.atmStrike} decimals={0} />
        </div>

        {signal && (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarClock className="h-3.5 w-3.5" />
            Expiry target: {signal.expiry.label}
          </p>
        )}
      </CardContent>
      <Activity className="pointer-events-none absolute -bottom-6 -right-6 h-32 w-32 text-primary/5" />
    </Card>
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
