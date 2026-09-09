import { ArrowDownRight, ArrowUpRight, Timer, TrendingUp } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusBadge } from '@/components/status-badge';
import { formatDuration, holdDurationMs, peakPoints, TradeSignal } from '@/lib/trade-signal';
import { cn } from '@/lib/utils';

interface SignalsTableProps {
  signals: TradeSignal[];
  emptyMessage: string;
}

export function SignalsTable({ signals, emptyMessage }: SignalsTableProps) {
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
          <TableHead>Strike</TableHead>
          <TableHead>Expiry</TableHead>
          <TableHead className="text-right">Entry</TableHead>
          <TableHead className="text-right">Stop-Loss</TableHead>
          <TableHead className="text-right">Target</TableHead>
          <TableHead className="text-right">Peak Pts</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Net P&amp;L</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {signals.map((row) => (
          <SignalRow key={row.id} row={row} />
        ))}
      </TableBody>
    </Table>
  );
}

function SignalRow({ row }: { row: TradeSignal }) {
  const isCall = row.direction === 'CALL';
  const peak = peakPoints(row);
  const targetPoints = Math.abs(row.targetSpot - row.entrySpotPrice);
  const reachedTarget = peak !== null && peak >= targetPoints;

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
      <TableCell className="tabular-nums">{row.strikePrice.toLocaleString('en-IN')}</TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {row.expiryType === 'CURRENT_WEEK' ? 'Current Week' : 'Next Week'}
      </TableCell>
      <TableCell className="text-right tabular-nums">{row.entrySpotPrice.toLocaleString('en-IN')}</TableCell>
      <TableCell className="text-right tabular-nums text-bearish">{row.stopLossSpot.toLocaleString('en-IN')}</TableCell>
      <TableCell className="text-right tabular-nums text-bullish">{row.targetSpot.toLocaleString('en-IN')}</TableCell>
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
