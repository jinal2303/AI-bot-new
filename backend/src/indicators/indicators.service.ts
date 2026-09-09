import { Injectable, Logger } from '@nestjs/common';
import { SMA, RSI, ATR } from 'technicalindicators';
import { CandleBar, DailyLevels, IndicatorSnapshot, SeriesPoint } from '../signals/signals.types';
import { toISTIsoDate } from '../common/ist-time.util';

/**
 * Wraps the `technicalindicators` library to compute the exact indicator
 * set the strategy needs: a 9-period SMA and a 14-period RSI (direction),
 * plus a 14-period ATR (volatility, used to size the exit distances instead
 * of a fixed point count) — all derived from candle OHLC.
 */
@Injectable()
export class IndicatorsService {
  private readonly logger = new Logger(IndicatorsService.name);

  private static readonly SMA_PERIOD = 9;
  private static readonly RSI_PERIOD = 14;
  private static readonly ATR_PERIOD = 14;

  /**
   * Computes the latest SMA(9) / RSI(14) / ATR(14) snapshot from a series
   * of candles. Throws if there is not enough history to seed all three.
   */
  computeSnapshot(candles: CandleBar[]): IndicatorSnapshot {
    const minimumBars =
      Math.max(IndicatorsService.SMA_PERIOD, IndicatorsService.RSI_PERIOD, IndicatorsService.ATR_PERIOD) + 1;

    if (candles.length < minimumBars) {
      throw new Error(
        `Not enough candle history to compute indicators: got ${candles.length}, need at least ${minimumBars}`,
      );
    }

    const closes = candles.map((candle) => candle.close);
    const highs = candles.map((candle) => candle.high);
    const lows = candles.map((candle) => candle.low);

    const smaSeries = SMA.calculate({ period: IndicatorsService.SMA_PERIOD, values: closes });
    const rsiSeries = RSI.calculate({ period: IndicatorsService.RSI_PERIOD, values: closes });
    const atrSeries = ATR.calculate({ period: IndicatorsService.ATR_PERIOD, high: highs, low: lows, close: closes });

    if (smaSeries.length === 0 || rsiSeries.length === 0 || atrSeries.length === 0) {
      throw new Error('Indicator calculation produced an empty series');
    }

    const latestCandle = candles[candles.length - 1];
    const sma9 = smaSeries[smaSeries.length - 1];
    const rsi14 = rsiSeries[rsiSeries.length - 1];
    const atr14 = atrSeries[atrSeries.length - 1];

    this.logger.debug(
      `Computed indicators — spot: ${latestCandle.close}, SMA9: ${sma9.toFixed(2)}, RSI14: ${rsi14.toFixed(2)}, ATR14: ${atr14.toFixed(2)}`,
    );

    return {
      spot: latestCandle.close,
      sma9,
      rsi14,
      atr14,
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

  /**
   * Today's running high/low plus classic floor-trader pivot points
   * (Pivot, R1/R2, S1/S2), computed from the *previous* trading day's
   * high/low/close — the standard convention, since today's session is
   * still in progress and its own H/L/C aren't final yet. Both days are
   * found by grouping the already-fetched multi-day candle history by IST
   * calendar date, so no extra market-data fetch is needed.
   */
  computeDailyLevels(candles: CandleBar[]): DailyLevels {
    const byDate = new Map<string, CandleBar[]>();
    for (const candle of candles) {
      const dateKey = toISTIsoDate(candle.timestamp);
      const bucket = byDate.get(dateKey);
      if (bucket) {
        bucket.push(candle);
      } else {
        byDate.set(dateKey, [candle]);
      }
    }

    const sortedDates = [...byDate.keys()].sort();
    const todayKey = sortedDates[sortedDates.length - 1];
    const todayCandles = byDate.get(todayKey)!;
    const dayHigh = Math.max(...todayCandles.map((candle) => candle.high));
    const dayLow = Math.min(...todayCandles.map((candle) => candle.low));

    // Previous trading day for the pivot-point base — falls back to today's
    // own (still in-progress) range if less than two distinct sessions are
    // present in the fetched history (e.g. right at the very start of the
    // lookback window), rather than throwing.
    const prevKey = sortedDates.length >= 2 ? sortedDates[sortedDates.length - 2] : todayKey;
    const prevCandles = byDate.get(prevKey)!;
    const prevHigh = Math.max(...prevCandles.map((candle) => candle.high));
    const prevLow = Math.min(...prevCandles.map((candle) => candle.low));
    const prevClose = prevCandles[prevCandles.length - 1].close;

    const pivot = (prevHigh + prevLow + prevClose) / 3;
    const range = prevHigh - prevLow;

    return {
      dayHigh,
      dayLow,
      prevClose,
      pivot,
      resistance1: 2 * pivot - prevLow,
      resistance2: pivot + range,
      support1: 2 * pivot - prevHigh,
      support2: pivot - range,
    };
  }
}
