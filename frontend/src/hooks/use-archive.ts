'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchArchive } from '@/lib/api';
import { ArchiveFilters, ArchiveResult } from '@/lib/trade-signal';

export interface UseArchiveResult {
  result: ArchiveResult | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/** One-shot (re-run on filter change) fetch of the filtered historical archive — no polling, since past trades never change. */
export function useArchive(filters: ArchiveFilters): UseArchiveResult {
  const [result, setResult] = useState<ArchiveResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    const data = await fetchArchive(filters);
    if (!data) {
      setError('Unable to load the archive right now.');
    } else {
      setError(null);
      setResult(data);
    }
    setIsLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters)]);

  useEffect(() => {
    void load();
  }, [load]);

  return { result, isLoading, error, refetch: load };
}
