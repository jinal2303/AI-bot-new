'use client';

import { ExternalLink, Newspaper } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useNewsHeadlines } from '@/hooks/use-news-headlines';

function timeAgo(isoDate: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(isoDate).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Latest market headlines, pulled from Google News' free RSS search — the
 * "external factors like news" input this dashboard offers. Purely
 * informational: it never feeds back into the strategy engine, it's here
 * so you can sanity-check a signal against what's actually moving the
 * market before acting on it.
 */
export function NewsPanel() {
  const { headlines, isLoading, error } = useNewsHeadlines();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <Newspaper className="h-3.5 w-3.5" />
          MARKET HEADLINES
        </CardTitle>
        <span className="text-xs text-muted-foreground">Informational only — not a signal input</span>
      </CardHeader>
      <CardContent>
        {isLoading && headlines.length === 0 ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : error && headlines.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{error}</p>
        ) : headlines.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No headlines available right now.</p>
        ) : (
          <ul className="divide-y divide-border">
            {headlines.map((headline) => (
              <li key={headline.link}>
                <a
                  href={headline.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-foreground group-hover:text-primary">{headline.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {headline.source} · {timeAgo(headline.publishedAt)}
                    </p>
                  </div>
                  <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
