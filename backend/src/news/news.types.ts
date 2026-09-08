/** One headline from the free Google News RSS feed. */
export interface NewsHeadline {
  title: string;
  link: string;
  source: string;
  /** ISO 8601 publish time. */
  publishedAt: string;
}
