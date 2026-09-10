'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react';
import { Nav } from '@/components/nav';
import { ArchiveFiltersBar } from '@/components/archive-filters';
import { SignalsTable } from '@/components/signals-table';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useArchive } from '@/hooks/use-archive';
import { ArchiveFilters, todayIsoDate } from '@/lib/trade-signal';

const PAGE_SIZE = 25;

export default function ArchivePage() {
  // Defaults to today's IST date — "today's calls" — rather than the full
  // all-time history; the date pickers in ArchiveFiltersBar let the user
  // widen or change the range from there.
  const [filters, setFilters] = useState<ArchiveFilters>({
    limit: PAGE_SIZE,
    offset: 0,
    dateFrom: todayIsoDate(),
    dateTo: todayIsoDate(),
  });
  const { result, isLoading, error } = useArchive(filters);

  const total = result?.total ?? 0;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? PAGE_SIZE;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + limit, total);

  return (
    <main className="container max-w-screen-2xl py-10">
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Signal Archive</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every signal ever generated, filterable by outcome, direction, and expiry window — defaults to today.
          </p>
        </div>
        <Nav />
      </header>

      <div className="mb-6">
        <ArchiveFiltersBar filters={filters} onChange={setFilters} />
      </div>

      {error && (
        <div className="mb-6 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {total > 0 ? `Showing ${rangeStart}–${rangeEnd} of ${total}` : 'HISTORICAL SIGNALS'}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || isLoading}
              onClick={() => setFilters((prev) => ({ ...prev, offset: Math.max(0, (prev.offset ?? 0) - limit) }))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + limit >= total || isLoading}
              onClick={() => setFilters((prev) => ({ ...prev, offset: (prev.offset ?? 0) + limit }))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <SignalsTable
            signals={result?.items ?? []}
            emptyMessage={isLoading ? 'Loading…' : 'No signals match these filters.'}
          />
        </CardContent>
      </Card>
    </main>
  );
}
