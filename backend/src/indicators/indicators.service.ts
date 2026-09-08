import { Injectable, Logger } from '@nestjs/common';
import { SMA, RSI } from 'technicalindicators';
import { CandleBar, IndicatorSnapshot, SeriesPoint } from '../signals/signals.types';
import { toISTIsoDate } from '../common/ist-time.util';

/**
 * Wraps the `technicalindicators` library to compute the exact indicator
 * set the strategy needs: a 9-period SMA and a 14-period RSI, both derived
 * from candle close prices.
 */
@Injectable()
export class IndicatorsService {
  private readonly logger = new Logger(IndicatorsService.name);

  private static readonly SMA_PERIOD = 9;
  private static readonly RSI_PERIOD = 14;

  /**
   * Computes the latest SMA(9) / RSI(14) snapshot from a series of candles.
   * Throws if there is not enough history to seed both indicators.
   */
  computeSnapshot(candles: CandleBar[]): IndicatorSnapshot {
    const minimumBars = Math.max(IndicatorsService.SMA_PERIOD, IndicatorsService.RSI_PERIOD) + 1;

    if (candles.length < minimumBars) {
      throw new Error(
        `Not enough candle history to compute indicators: got ${candles.length}, need at least ${minimumBars}`,
      );
    }

    const closes = candles.map((candle) => candle.close);

    const smaSeries = SMA.calculate({ period: IndicatorsService.SMA_PERIOD, values: closes });
    const rsiSeries = RSI.calculate({ period: IndicatorsService.RSI_PERIOD, values: closes });

    if (smaSeries.length === 0 || rsiSeries.length === 0) {
      throw new Error('Indicator calculation produced an empty series');
    }

    const latestCandle = candles[candles.length - 1];
    const sma9 = smaSeries[smaSeries.length - 1];
    const rsi14 = rsiSeries[rsiSeries.length - 1];

    this.logger.debug(
      `Computed indicators — spot: ${latestCandle.close}, SMA9: ${sma9.toFixed(2)}, RSI14: ${rsi14.toFixed(2)}`,
    );

    return {
      spot: latestCandle.close,
      sma9,
      rsi14,
      candleTimestamp: latestCandle.timestamp,
    };
  }

  /**
   * Rounds a spot price to the closest At-The-Money strike, stepped in
   * increments of `strikeStep` (defaults to 50, standard for Nifty 50).
   */
  computeAtmStrike(spot: number, strikeStep = 50): number {
    return Math.round(spot / strikeStep) * strikeStep;
  }

  /**
   * Builds a charting-ready series: every candle paired with its SMA(9) /
   * RSI(14) value where available (`null` for the initial bars that don't
   * yet have enough lookback history). Indicators are computed over the
   * *full* multi-day candle history passed in (so they stay continuous
   * across the session boundary), but the returned series is trimmed down
   * to just the most recent trading session — otherwise an intraday chart
   * spanning a weekend/holiday gap makes the time-of-day x-axis look like
   * it jumps backwards. Also capped at `maxPoints` so the payload stays
   * small.
   */
  computeSeries(candles: CandleBar[], maxPoints = 150): SeriesPoint[] {
    if (candles.length === 0) return [];

    const closes = candles.map((candle) => candle.close);

    const smaValues = SMA.calculate({ period: IndicatorsService.SMA_PERIOD, values: closes });
    const rsiValues = RSI.calculate({ period: IndicatorsService.RSI_PERIOD, values: closes });

    // technicalindicators drops the initial `period - 1` (SMA) / `period`
    // (RSI) bars it needs as lookback, so its output is shorter than the
    // input and right-aligned to it — offset back in to re-align by index.
    const smaOffset = candles.length - smaValues.length;
    const rsiOffset = candles.length - rsiValues.length;

    const points: SeriesPoint[] = candles.map((candle, index) => ({
      timestamp: candle.timestamp.toISOString(),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      sma9: index >= smaOffset ? smaValues[index - smaOffset] : null,
      rsi14: index >= rsiOffset ? rsiValues[index - rsiOffset] : null,
    }));

    const latestSessionDate = toISTIsoDate(candles[candles.length - 1].timestamp);
    const latestSession = points.filter((point) => toISTIsoDate(new Date(point.timestamp)) === latestSessionDate);

    return latestSession.slice(-maxPoints);
  }
}
