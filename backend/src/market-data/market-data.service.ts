import { Injectable, Logger } from '@nestjs/common';
import YahooFinance from 'yahoo-finance2';
import { CandleBar } from '../signals/signals.types';

type ChartInterval = '1m' | '5m' | '15m' | '30m' | '60m' | '1d';

/**
 * Thin, defensive wrapper around `yahoo-finance2` responsible for fetching
 * intraday candlestick bars for the Nifty 50 index. No API key is required
 * — yahoo-finance2 scrapes Yahoo's public chart endpoints directly.
 */
@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);

  // Silences yahoo-finance2's startup survey/notice noise in server logs.
  private readonly yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

  /**
   * Fetches the most recent 5-minute OHLCV candles for the given symbol —
   * the bar size the strategy's SMA(9)/RSI(14) pipeline runs on.
   *
   * @param symbol       Yahoo Finance ticker, e.g. "^NSEI" for Nifty 50.
   * @param lookbackDays How many calendar days of history to request. Yahoo
   *                     only serves 5-minute data for a limited trailing
   *                     window (well under a year), so this stays small.
   */
  async fetchFiveMinuteCandles(symbol: string, lookbackDays = 5): Promise<CandleBar[]> {
    return this.fetchCandles(symbol, '5m', lookbackDays);
  }

  /** Generic candle fetch, reused by any interval the strategy might need. */
  private async fetchCandles(symbol: string, interval: ChartInterval, lookbackDays: number): Promise<CandleBar[]> {
    try {
      const period2 = new Date();
      const period1 = new Date(period2.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

      const result = await this.yahooFinance.chart(symbol, {
        period1,
        period2,
        interval,
      });

      const quotes = result?.quotes ?? [];

      const candles: CandleBar[] = quotes
        .filter(
          (quote) =>
            quote.close !== null &&
            quote.close !== undefined &&
            quote.open !== null &&
            quote.high !== null &&
            quote.low !== null,
        )
        .map((quote) => ({
          timestamp: new Date(quote.date),
          open: quote.open as number,
          high: quote.high as number,
          low: quote.low as number,
          close: quote.close as number,
          volume: quote.volume ?? 0,
        }));

      if (candles.length === 0) {
        throw new Error(`Yahoo Finance returned no usable candles for symbol ${symbol}`);
      }

      this.logger.debug(`Fetched ${candles.length} x ${interval} candles for ${symbol}`);
      return candles;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to fetch candles for ${symbol}: ${message}`);
      // Re-throw as a well-typed error so callers can decide how to degrade
      // instead of crashing the cron tick or the request that triggered it.
      throw new Error(`MarketDataService: unable to fetch candles for ${symbol} — ${message}`);
    }
  }
}
