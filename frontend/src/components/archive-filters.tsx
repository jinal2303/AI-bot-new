import type { ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ArchiveFilters, todayIsoDate } from '@/lib/trade-signal';

interface ArchiveFiltersBarProps {
  filters: ArchiveFilters;
  onChange: (next: ArchiveFilters) => void;
}

/** Shadcn-style Select fields + native date pickers for the /archive screen's filter header. */
export function ArchiveFiltersBar({ filters, onChange }: ArchiveFiltersBarProps) {
  const set = <K extends keyof ArchiveFilters>(key: K, value: ArchiveFilters[K]) => {
    onChange({ ...filters, [key]: value, offset: 0 });
  };

  const today = todayIsoDate();
  // "Default" is today's date range with no other filters — not empty dates
  // — since the page itself now opens scoped to today rather than all time.
  const isDefault =
    !filters.status && !filters.direction && !filters.expiryType && filters.dateFrom === today && filters.dateTo === today;

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
      <Field label="Outcome">
        <Select
          value={filters.status ?? ''}
          onChange={(e) => set('status', (e.target.value || undefined) as ArchiveFilters['status'])}
        >
          <option value="">All outcomes</option>
          <option value="ACTIVE">Active</option>
          <option value="TARGET_HIT">Target Hit</option>
          <option value="STOPLOSS_HIT">Stop-Loss Hit</option>
          <option value="TRAIL_STOP_HIT">Trailing Stop Hit</option>
          <option value="TIME_EXIT">Time Exit</option>
        </Select>
      </Field>

      <Field label="Direction">
        <Select
          value={filters.direction ?? ''}
          onChange={(e) => set('direction', (e.target.value || undefined) as ArchiveFilters['direction'])}
        >
          <option value="">Calls &amp; Puts</option>
          <option value="CALL">Calls (CE)</option>
          <option value="PUT">Puts (PE)</option>
        </Select>
      </Field>

      <Field label="Expiry Window">
        <Select
          value={filters.expiryType ?? ''}
          onChange={(e) => set('expiryType', (e.target.value || undefined) as ArchiveFilters['expiryType'])}
        >
          <option value="">Current &amp; Next Week</option>
          <option value="CURRENT_WEEK">Current Week</option>
          <option value="NEXT_WEEK">Next Week</option>
        </Select>
      </Field>

      <Field label="From">
        <input
          type="date"
          value={filters.dateFrom ?? ''}
          onChange={(e) => set('dateFrom', e.target.value || undefined)}
          className="h-9 rounded-md border border-input bg-secondary px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </Field>

      <Field label="To">
        <input
          type="date"
          value={filters.dateTo ?? ''}
          onChange={(e) => set('dateTo', e.target.value || undefined)}
          className="h-9 rounded-md border border-input bg-secondary px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </Field>

      <Button
        variant="outline"
        size="sm"
        disabled={isDefault}
        onClick={() => onChange({ limit: filters.limit, offset: 0, dateFrom: today, dateTo: today })}
        className="gap-1.5"
        title="Back to today, all outcomes/directions/expiries — clear the date fields by hand for full all-time history"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Reset
      </Button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-[9rem] flex-1 flex-col gap-1.5 sm:flex-none">
      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
