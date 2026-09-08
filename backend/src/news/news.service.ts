import { Injectable, Logger } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import { NewsHeadline } from './news.types';

const FEED_URL = 'https://news.google.com/rss/search?q=Nifty%2050%20OR%20Sensex%20OR%20NSE%20India&hl=en-IN&gl=IN&ceid=IN:en';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — headlines don't need to be fresher than that
const MAX_HEADLINES = 15;

interface RawRssItem {
  title?: string;
  link?: string;
  pubDate?: string;
  source?: string | { '#text'?: string };
}

/**
 * Pulls market headlines from Google News' public RSS search endpoint —
 * no API key, no registration, just a URL. This is the "external factors
 * like news" input: an informational panel for the trader's own judgment,
 * not a signal that feeds back into the strategy engine.
 */
@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);
  private readonly parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

  private cache: NewsHeadline[] | null = null;
  private cachedAt = 0;

  async fetchHeadlines(): Promise<NewsHeadline[]> {
    const isCacheFresh = this.cache !== null && Date.now() - this.cachedAt < CACHE_TTL_MS;
    if (isCacheFresh) {
      return this.cache as NewsHeadline[];
    }

    try {
      const response = await fetch(FEED_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NiftySignalTracker/1.0)' },
      });

      if (!response.ok) {
        throw new Error(`Google News RSS responded with status ${response.status}`);
      }

      const xml = await response.text();
      const headlines = this.parseFeed(xml);

      this.cache = headlines;
      this.cachedAt = Date.now();
      this.logger.debug(`Fetched ${headlines.length} headlines from Google News RSS`);
      return headlines;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to fetch news headlines: ${message}`);
      // Serve the last known-good cache (even if stale) rather than an
      // empty panel; if we've never succeeded, return an empty list —
      // the frontend renders that as "no headlines available" rather than
      // erroring the whole dashboard.
      return this.cache ?? [];
    }
  }

  private parseFeed(xml: string): NewsHeadline[] {
    const parsed = this.parser.parse(xml);
    const rawItems: RawRssItem | RawRssItem[] | undefined = parsed?.rss?.channel?.item;
    if (!rawItems) return [];

    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    return items.slice(0, MAX_HEADLINES).map((item) => ({
      title: this.stripSourceSuffix(item.title ?? 'Untitled'),
      link: item.link ?? '',
      source: this.extractSource(item),
      publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
    }));
  }

  /** Google News titles are formatted "Headline - Source Name"; the source is shown separately, so trim the suffix. */
  private stripSourceSuffix(title: string): string {
    const lastDash = title.lastIndexOf(' - ');
    return lastDash === -1 ? title : title.slice(0, lastDash);
  }

  private extractSource(item: RawRssItem): string {
    if (typeof item.source === 'string') return item.source;
    return item.source?.['#text'] ?? 'Unknown source';
  }
}
