import { ArrowDownRight, ArrowUpRight, CalendarClock, Radio, Timer, TrendingUp, Zap } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusBadge } from '@/components/status-badge';
import { callType, formatDuration, holdDurationMs, liveUnrealizedCashINR, peakPoints, TradeSignal } from '@/lib/trade-signal';
import { cn } from '@/lib/utils';

interface SignalsTableProps {
  signals: TradeSignal[];
  emptyMessage: string;
  /** Latest polled Nifty spot price, used to estimate live unrealized P&L on the ACTIVE row. Omit (or null) where no live price is available — e.g. the Archive page, which is purely historical. */
  livePrice?: number | null;
}

export function SignalsTable({ signals, emptyMessage, livePrice = null }: SignalsTableProps) {
  if (signals.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Direction</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Strike</TableHead>
          <TableHead>Expiry</TableHead>
          <TableHead className="text-right">Entry</TableHead>
          <TableHead className="text-right">Stop-Loss</TableHead>
          <TableHead className="text-right">Target</TableHead>
          <TableHead className="text-right">Current</TableHead>
          <TableHead className="text-right">Peak Pts</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Live P&amp;L</TableHead>
          <TableHead className="text-right">Net P&amp;L</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {signals.map((row) => (
          <SignalRow key={row.id} row={row} livePrice={livePrice} />
        ))}
      </TableBody>
    </Table>
  );
}

function SignalRow({ row, livePrice }: { row: TradeSignal; livePrice: number | null }) {
  const isCall = row.direction === 'CALL';
  const peak = peakPoints(row);
  const targetPoints = Math.abs(row.targetSpot - row.entrySpotPrice);
  const reachedTarget = peak !== null && peak >= targetPoints;
  const livePnl = liveUnrealizedCashINR(row, livePrice);
  const type = callType(row);
  const isIntraday = type === 'INTRADAY';

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {new Date(row.timestamp).toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Kolkata',
        })}
      </TableCell>
      <TableCell>
        <span className={cn('flex items-center gap-1 font-medium', isCall ? 'text-bullish' : 'text-bearish')}>
          {isCall ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
          {row.direction} ({isCall ? 'CE' : 'PE'})
        </span>
      </TableCell>
      <TableCell>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
            isIntraday ? 'bg-sky-500/10 text-sky-400' : 'bg-purple-500/10 text-purple-400',
          )}
          title={isIntraday ? 'Entered and (so far) held within the same trading day' : 'Carried over past the entry day — no target/stop-loss hit before market close'}
        >
          {isIntraday ? <Zap className="h-3 w-3" /> : <CalendarClock className="h-3 w-3" />}
          {isIntraday ? 'Intraday' : 'Delivery'}
        </span>
      </TableCell>
      <TableCell className="tabular-nums">{row.strikePrice.toLocaleString('en-IN')}</TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {row.expiryType === 'CURRENT_WEEK' ? 'Current Week' : 'Next Week'}
      </TableCell>
      <TableCell className="text-right tabular-nums">{row.entrySpotPrice.toLocaleString('en-IN')}</TableCell>
      <TableCell className="text-right tabular-nums text-bearish">{row.stopLossSpot.toLocaleString('en-IN')}</TableCell>
      <TableCell className="text-right tabular-nums text-bullish">{row.targetSpot.toLocaleString('en-IN')}</TableCell>
      <TableCell className="text-right">
        {row.currentStatus === 'ACTIVE' && livePrice !== null ? (
          <span
            className={cn(
              'inline-flex items-center justify-end gap-1 font-semibold tabular-nums',
              (isCall ? livePrice >= row.entrySpotPrice : livePrice <= row.entrySpotPrice)
                ? 'text-emerald-500'
                : 'text-red-500',
            )}
          >
            <Radio className="h-3 w-3 animate-pulse" />
            {livePrice.toLocaleString('en-IN')}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {row.resolvedSpot !== null ? row.resolvedSpot.toLocaleString('en-IN') : '—'}
          </span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {peak !== null ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 tabular-nums',
              reachedTarget ? 'text-emerald-500' : 'text-muted-foreground',
            )}
          >
            <TrendingUp className="h-3 w-3" />+{peak.toFixed(1)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <span className={cn('flex items-center gap-1 tabular-nums', row.currentStatus === 'ACTIVE' ? 'text-amber-400' : 'text-muted-foreground')}>
          <Timer className="h-3 w-3" />
          {formatDuration(holdDurationMs(row))}
          {row.currentStatus === 'ACTIVE' && <span className="text-muted-foreground">…</span>}
        </span>
      </TableCell>
      <TableCell>
        <StatusBadge status={row.currentStatus} />
      </TableCell>
      <TableCell className="text-right">
        {livePnl !== null ? (
          <span
            className={cn(
              'inline-flex items-center justify-end gap-1 tabular-nums',
              livePnl >= 0 ? 'text-emerald-500' : 'text-red-500',
            )}
          >
            <Radio className="h-3 w-3 animate-pulse" />
            {livePnl >= 0 ? '+' : '-'}₹{Math.abs(livePnl).toLocaleString('en-IN')}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {row.netCashINR !== null ? (
          <span
            className={cn(
              'font-semibold tabular-nums',
              row.netCashINR >= 0 ? 'text-emerald-500' : 'text-red-500',
            )}
          >
            {row.netCashINR >= 0 ? '+' : '-'}₹{Math.abs(row.netCashINR).toLocaleString('en-IN')}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}
