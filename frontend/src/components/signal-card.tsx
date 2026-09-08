import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, CalendarClock, CircleSlash, Layers, Target, TriangleAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SignalData } from '@/lib/types';
import { cn } from '@/lib/utils';

interface SignalCardProps {
  signal: SignalData | null;
  isLoading: boolean;
}

export function SignalCard({ signal, isLoading }: SignalCardProps) {
  if (isLoading && !signal) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">ACTIVE TRADE SETUP</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-24 animate-pulse rounded-md bg-muted" />
        </CardContent>
      </Card>
    );
  }

  const isBullish = signal?.signal === 'BUY CALL (CE)';
  const isBearish = signal?.signal === 'BUY PUT (PE)';
  const isActive = isBullish || isBearish;
  const rules = signal?.tradeRules ?? null;

  return (
    <Card
      className={cn(
        'relative overflow-hidden border-2 transition-colors',
        isBullish && 'border-bullish/60 shadow-[0_0_40px_-15px_hsl(var(--bullish)/0.6)]',
        isBearish && 'border-bearish/60 shadow-[0_0_40px_-15px_hsl(var(--bearish)/0.6)]',
        !isActive && 'border-border',
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">ACTIVE TRADE SETUP</CardTitle>
        <div className="flex items-center gap-2">
          {signal && (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <CalendarClock className="h-3 w-3" />
              {signal.expiry.cycle === 'CURRENT_WEEK' ? 'Current Week' : 'Next Week'}
            </Badge>
          )}
          {isActive && (
            <Badge variant={isBullish ? 'bullish' : 'bearish'} className="animate-pulse-ring">
              LIVE SIGNAL
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {!isActive || !signal || !rules ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-muted-foreground">
            <CircleSlash className="h-8 w-8" />
            <p className="text-lg font-semibold">NO_SIGNAL</p>
            <p className="text-sm">Market choppy or overextended — waiting for a clean SMA/RSI breakout.</p>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex h-12 w-12 items-center justify-center rounded-full',
                  isBullish ? 'bg-bullish/15 text-bullish' : 'bg-bearish/15 text-bearish',
                )}
              >
                {isBullish ? <ArrowUpRight className="h-6 w-6" /> : <ArrowDownRight className="h-6 w-6" />}
              </div>
              <div>
                <p className={cn('text-2xl font-bold', isBullish ? 'text-bullish' : 'text-bearish')}>
                  {signal.signal}
                </p>
                <p className="text-sm text-muted-foreground">
                  NIFTY {signal.atmStrike} {signal.optionType} · {signal.expiry.label}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 rounded-lg bg-secondary/50 p-4">
              <TradeStat label="Entry" value={rules.entryPrice} icon={<Target className="h-3.5 w-3.5" />} />
              <TradeStat
                label="Index Stop-Loss"
                value={rules.indexStopLoss}
                icon={<TriangleAlert className="h-3.5 w-3.5" />}
                tone="bearish"
                sub={`${rules.indexStopLossPoints} pts`}
              />
              <TradeStat
                label="Index Target"
                value={rules.indexTarget}
                icon={isBullish ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                tone="bullish"
                sub={`${rules.indexTargetPoints} pts`}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Layers className="h-4 w-4" />1 Lot ({rules.lotSize} units) · Δ {rules.deltaProxy} proxy
              </div>
              <div className="flex items-center gap-4 text-sm font-semibold tabular-nums">
                <span className="text-bearish">-₹{rules.maxRiskCashINR.toLocaleString('en-IN')}</span>
                <span className="text-muted-foreground">/</span>
                <span className="text-bullish">+₹{rules.targetCashINR.toLocaleString('en-IN')}</span>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Option premium proxy: SL {rules.optionStopLossPoints} pts · Target {rules.optionTargetPoints} pts
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TradeStat({
  label,
  value,
  icon,
  tone,
  sub,
}: {
  label: string;
  value?: number;
  icon: ReactNode;
  tone?: 'bullish' | 'bearish';
  sub?: string;
}) {
  return (
    <div>
      <p className="flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </p>
      <p
        className={cn(
          'mt-1 text-lg font-semibold tabular-nums',
          tone === 'bullish' && 'text-bullish',
          tone === 'bearish' && 'text-bearish',
        )}
      >
        {value !== undefined ? value.toLocaleString('en-IN') : '—'}
      </p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
