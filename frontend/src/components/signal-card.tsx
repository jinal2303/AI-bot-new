import type { ReactNode } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, CalendarClock, CircleSlash, Clock, Layers, Target, TriangleAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SignalData, TradeRules } from '@/lib/types';
import { TradeSignal } from '@/lib/trade-signal';
import { cn } from '@/lib/utils';

interface SignalCardProps {
  signal: SignalData | null;
  isLoading: boolean;
  /** The persisted TradeSignal row backing the current open position, if any. */
  activeEntry?: TradeSignal | null;
}

interface DisplayTrade {
  signalLabel: string;
  optionLabel: 'CE' | 'PE';
  isBullish: boolean;
  atmStrike: number;
  rules: TradeRules;
  entryTimestamp: string | null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Builds the exact levels the currently-open position was actually created
 * with — never a fresh recomputation. Since exit distances are ATR-sized,
 * ATR keeps moving on every later 60s tick; reconstructing "live" trade
 * rules for an already-open trade would show numbers that drift away from
 * what the backend's 10s monitor is really watching for exit. `deltaProxy`
 * and `lotSize` are static config (not time-varying), so it's safe to reuse
 * them from the current /latest snapshot even here.
 */
function deriveFromActiveEntry(entry: TradeSignal, deltaProxy: number, lotSize: number): DisplayTrade {
  const isBullish = entry.direction === 'CALL';
  const indexTargetPoints = round(Math.abs(entry.targetSpot - entry.entrySpotPrice));
  const indexStopLossPoints = round(Math.abs(entry.stopLossSpot - entry.entrySpotPrice));
  const optionTargetPoints = round(indexTargetPoints * deltaProxy);
  const optionStopLossPoints = round(indexStopLossPoints * deltaProxy);

  return {
    signalLabel: isBullish ? 'BUY CALL (CE)' : 'BUY PUT (PE)',
    optionLabel: isBullish ? 'CE' : 'PE',
    isBullish,
    atmStrike: entry.strikePrice,
    entryTimestamp: entry.timestamp,
    rules: {
      entryPrice: entry.entrySpotPrice,
      indexTarget: entry.targetSpot,
      indexStopLoss: entry.stopLossSpot,
      indexTargetPoints,
      indexStopLossPoints,
      optionTargetPoints,
      optionStopLossPoints,
      deltaProxy,
      lotSize,
      maxRiskCashINR: round(optionStopLossPoints * lotSize),
      targetCashINR: round(optionTargetPoints * lotSize),
      // Legacy rows created before these fields were persisted fall back to
      // reasonable approximations, used only for display.
      atr14: entry.atr14 ?? indexStopLossPoints,
      targetBasis: entry.targetBasis ?? 'ATR',
    },
  };
}

function formatCallTime(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

export function SignalCard({ signal, isLoading, activeEntry }: SignalCardProps) {
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

  // Only feature a position here while the market is actually open — once
  // it closes (15:30 IST), the position monitor stops re-evaluating it
  // until tomorrow, so it would otherwise sit here indefinitely, hours
  // stale, still badged "LIVE SIGNAL". Once closed, it stays visible in
  // the Today's Signals table below — this card just stops re-featuring it.
  const marketOpen = signal?.marketOpen ?? false;

  // Prefer the real persisted position's own levels — immune to ATR moving
  // on later ticks — falling back to the live snapshot's fresh computation
  // only in the brief window before `activeEntry` has propagated to this
  // page (it's created from the exact same read, so it matches exactly).
  const display: DisplayTrade | null = !marketOpen
    ? null
    : activeEntry
      ? deriveFromActiveEntry(activeEntry, signal?.tradeRules?.deltaProxy ?? 0.5, signal?.tradeRules?.lotSize ?? 65)
      : signal?.tradeRules && signal.optionType
        ? {
            signalLabel: signal.signal,
            optionLabel: signal.optionType,
            isBullish: signal.signal === 'BUY CALL (CE)',
            atmStrike: signal.atmStrike,
            entryTimestamp: null,
            rules: signal.tradeRules,
          }
        : null;

  const isActive = display !== null;
  // Distinguishes "market's shut, nothing to show here" from "market's
  // open but there's a real open position we're just not featuring" —
  // only the latter should point the viewer at the table below.
  const hasStalePosition = !marketOpen && activeEntry !== null && activeEntry !== undefined;
  const isBullish = display?.isBullish ?? false;
  const rules = display?.rules ?? null;

  return (
    <Card
      className={cn(
        'relative overflow-hidden border-2 transition-colors',
        isActive && isBullish && 'border-bullish/60 shadow-[0_0_40px_-15px_hsl(var(--bullish)/0.6)]',
        isActive && !isBullish && 'border-bearish/60 shadow-[0_0_40px_-15px_hsl(var(--bearish)/0.6)]',
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
        {!display || !signal || !rules ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-muted-foreground">
            <CircleSlash className="h-8 w-8" />
            <p className="text-lg font-semibold">{!marketOpen ? 'MARKET CLOSED' : 'NO_SIGNAL'}</p>
            {hasStalePosition ? (
              <p className="text-sm">
                {activeEntry!.direction} {activeEntry!.strikePrice} from{' '}
                {formatCallTime(activeEntry!.timestamp)} IST is still open — see Today&apos;s Signals below.
              </p>
            ) : !marketOpen ? (
              <p className="text-sm">Evaluation resumes at 09:15 AM IST on the next trading day.</p>
            ) : (
              <p className="text-sm">Market choppy or overextended — waiting for a clean SMA/RSI breakout.</p>
            )}
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
                  {display.signalLabel}
                </p>
                <p className="text-sm text-muted-foreground">
                  NIFTY {display.atmStrike} {display.optionLabel} · {signal.expiry.label}
                </p>
                {display.entryTimestamp && (
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    Call given at {formatCallTime(display.entryTimestamp)} IST
                  </p>
                )}
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

            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Activity className="h-3 w-3" />
              Stop-loss sized off ATR(14) = {rules.atr14} pts (SL {(rules.indexStopLossPoints / rules.atr14).toFixed(1)}×)
              {rules.targetBasis === 'PIVOT'
                ? ' — target set at the nearest support/resistance pivot, not ATR'
                : ` — target ${(rules.indexTargetPoints / rules.atr14).toFixed(1)}× ATR (no qualifying pivot nearby)`}
            </p>
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
