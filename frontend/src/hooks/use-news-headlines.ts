'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchNewsHeadlines } from '@/lib/api';
import { NewsHeadline } from '@/lib/news';

const POLL_INTERVAL_MS = 5 * 60_000; // Headlines don't need the fast cadence the trading data does.

export interface UseNewsHeadlinesResult {
  headlines: NewsHeadline[];
  isLoading: boolean;
  error: string | null;
}

/** Polls GET /api/news/headlines every 5 minutes — purely informational, no effect on signal logic. */
export function useNewsHeadlines(): UseNewsHeadlinesResult {
  const [headlines, setHeadlines] = useState<NewsHeadline[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    const data = await fetchNewsHeadlines();
    if (!data) {
      setError('Unable to load headlines right now.');
    } else {
      setError(null);
      setHeadlines(data);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void poll();
    const intervalId = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [poll]);

  return { headlines, isLoading, error };
}
