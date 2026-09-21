import { Injectable, Logger } from '@nestjs/common';
import { SMA, RSI, ATR, ADX, TrueRange } from 'technicalindicators';
import { CandleBar, DailyLevels, IndicatorSnapshot, ReactionLevel, SeriesPoint } from '../signals/signals.types';
import { toISTIsoDate, getISTDateParts } from '../common/ist-time.util';
import { SESSION_WINDOW_BOUNDS } from '../common/market-hours.util';

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
  // MARKET REGIME / CHOP FILTER — ADX needs roughly 2x its period of bars
  // before the double-smoothed reading stabilizes (unlike SMA/RSI/ATR,
  // which only need `period` bars) — see computeADX()'s fail-open guard.
  private static readonly ADX_PERIOD = 14;
  private static readonly CHOPPINESS_PERIOD = 14;

  // --- PIVOT & STRUCTURE REACTION ANALYSIS ------------------------------------
  /** Bars on each side that must be less-extreme for a candle's high/low to confirm as a local swing point. */
  private static readonly SWING_WINDOW_BARS = 2;
  /** Two swing points within this many x ATR(14) of each other merge into one reaction-level cluster. */
  private static readonly SWING_CLUSTER_TOLERANCE_ATR_MULT = 0.3;

  // --- MARKET-MOVEMENT-FIRST SIGNAL ENGINE ------------------------------------
  /** How many 5m bars back `atrExpanding` compares the latest ATR(14) against — 6 bars ≈ 30 minutes. */
  private static readonly ATR_EXPANSION_LOOKBACK_BARS = 6;

  /**
   * Computes the latest SMA(9) / RSI(14) / ATR(14) snapshot from a series
   * of candles, plus the MARKET-MOVEMENT-FIRST `atrExpanding` read (is
   * volatility actually expanding, i.e. is there real movement underway,
   * not just a flat chop that happens to satisfy the SMA/RSI corridor?).
   * Throws if there is not enough history to seed SMA/RSI/ATR themselves.
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

    // MARKET-MOVEMENT-FIRST — ATR expansion check. Compares the latest
    // ATR(14) to its reading ATR_EXPANSION_LOOKBACK_BARS bars ago as a
    // RATIO rather than a strict boolean — a sharp move that has already
    // happened and is now consolidating (ATR flattening or dipping a few
    // percent off its peak) shouldn't read identically to a genuinely flat
    // chop (ATR at half its recent level or less). SignalsService applies
    // its own softened pass/fail threshold against this ratio; `atrExpanding`
    // is kept as the plain >1 boolean for any caller that just wants a
    // quick read. Fails open (ratio = 1, atrExpanding = true) when there's
    // not yet enough ATR history for the lookback — e.g. right after a
    // fresh boot — rather than blocking every signal until that history
    // accumulates.
    const lookbackIndex = atrSeries.length - 1 - IndicatorsService.ATR_EXPANSION_LOOKBACK_BARS;
    const lookbackAtr = lookbackIndex >= 0 ? atrSeries[lookbackIndex] : null;
    const atrExpansionRatio = lookbackAtr !== null && lookbackAtr > 0 ? atr14 / lookbackAtr : 1;
    const atrExpanding = atrExpansionRatio > 1;

    this.logger.debug(
      `Computed indicators — spot: ${latestCandle.close}, SMA9: ${sma9.toFixed(2)}, RSI14: ${rsi14.toFixed(2)}, ATR14: ${atr14.toFixed(2)}, atrExpansionRatio: ${atrExpansionRatio.toFixed(2)}`,
    );

    return {
      spot: latestCandle.close,
      sma9,
      rsi14,
      atr14,
      atrExpanding,
      atrExpansionRatio,
      candleTimestamp: latestCandle.timestamp,
    };
  }

  /**
   * MARKET REGIME / CHOP FILTER — Average Directional Index(14), the
   * classic Wilder trend-strength read (direction-agnostic: a strong
   * downtrend reads just as high as a strong uptrend). Returns `null`
   * rather than throwing when there isn't yet enough history for the
   * double-smoothed calculation to have stabilized (needs roughly 2x
   * ADX_PERIOD bars, unlike the single-smoothed SMA/RSI/ATR above) — the
   * caller (SignalsService) treats `null` as "fail open, don't block on
   * cold-start history" the same way `atrExpanding` already does.
   */
  computeADX(candles: CandleBar[]): number | null {
    const minimumBars = IndicatorsService.ADX_PERIOD * 2;
    if (candles.length < minimumBars) return null;

    const high = candles.map((candle) => candle.high);
    const low = candles.map((candle) => candle.low);
    const close = candles.map((candle) => candle.close);

    const result = ADX.calculate({ period: IndicatorsService.ADX_PERIOD, high, low, close });
    if (result.length === 0) return null;

    return result[result.length - 1].adx;
  }

  /**
   * MARKET REGIME / CHOP FILTER — Choppiness Index(14): 100 x log10(sum of
   * True Range over the period / (highest high - lowest low over the same
   * period)) / log10(period). Ranges 0-100; high readings (>60, the
   * strategy's default ceiling) mean price spent the period oscillating
   * without covering much net ground — textbook chop, the exact condition
   * a directional entry should avoid regardless of what the SMA/RSI read
   * says. Returns `null` (fails open, same convention as computeADX())
   * when there isn't enough history, or when the high-low range is exactly
   * zero (a dead/flat tape — can't divide by it; also not a scenario worth
   * hard-blocking on, since it should never happen on real market data).
   */
  computeChoppinessIndex(candles: CandleBar[]): number | null {
    const period = IndicatorsService.CHOPPINESS_PERIOD;
    if (candles.length < period + 1) return null;

    const recent = candles.slice(-period);
    const trueRanges = TrueRange.calculate({
      high: candles.map((candle) => candle.high),
      low: candles.map((candle) => candle.low),
      close: candles.map((candle) => candle.close),
    });
    const recentTrueRanges = trueRanges.slice(-period);
    if (recentTrueRanges.length < period) return null;

    const sumTrueRange = recentTrueRanges.reduce((sum, tr) => sum + tr, 0);
    const highestHigh = Math.max(...recent.map((candle) => candle.high));
    const lowestLow = Math.min(...recent.map((candle) => candle.low));
    const range = highestHigh - lowestLow;
    if (range <= 0) return null;

    return this.round((100 * Math.log10(sumTrueRange / range)) / Math.log10(period));
  }

  /**
   * SUSTAINED-TREND BYPASS — counts how many consecutive, most-recently-
   * closed 5m bars (today's session only) satisfy a strict trend-agreement
   * condition, walking backward from the latest bar:
   *   bullish bar: close > SMA9 AND RSI14 >= 55
   *   bearish bar: close < SMA9 AND RSI14 <= 45
   * Deliberately the tighter, classic 55/45 threshold — not the widened
   * RSI_MIN/RSI_MAX band `SignalsService.evaluateStrategy()` uses for entry
   * — since this counts confirms a *sustained*, unambiguous trend, not just
   * a single directionally-plausible reading.
   *
   * Recomputed fresh from the candle history every tick rather than an
   * incrementally maintained instance counter, so a process restart, a
   * missed cron tick, or a market-data gap can never leave a stale streak
   * behind — the same "rebuild from source data, don't carry hidden state"
   * approach `computeSnapshot()`'s ATR-expansion lookback already uses.
   * Counting stops at the first bar that breaks the streak, doesn't satisfy
   * its condition, falls outside today's session, or runs out of
   * SMA/RSI warm-up history.
   */
  computeConsecutiveTrendBars(candles: CandleBar[]): { consecutiveBullishBars: number; consecutiveBearishBars: number } {
    if (candles.length === 0) {
      return { consecutiveBullishBars: 0, consecutiveBearishBars: 0 };
    }

    const closes = candles.map((candle) => candle.close);
    const smaValues = SMA.calculate({ period: IndicatorsService.SMA_PERIOD, values: closes });
    const rsiValues = RSI.calculate({ period: IndicatorsService.RSI_PERIOD, values: closes });
    // Same right-alignment offset trick as computeSeries() — technicalindicators
    // drops the initial lookback bars it needs, so its output is shorter
    // than the input candle array.
    const smaOffset = candles.length - smaValues.length;
    const rsiOffset = candles.length - rsiValues.length;

    const latestSessionDate = toISTIsoDate(candles[candles.length - 1].timestamp);

    let consecutiveBullishBars = 0;
    let consecutiveBearishBars = 0;
    let bullishStreakBroken = false;
    let bearishStreakBroken = false;

    for (let i = candles.length - 1; i >= 0; i--) {
      if (toISTIsoDate(candles[i].timestamp) !== latestSessionDate) break; // never count into a prior session

      const sma9 = i >= smaOffset ? smaValues[i - smaOffset] : null;
      const rsi14 = i >= rsiOffset ? rsiValues[i - rsiOffset] : null;
      if (sma9 === null || rsi14 === null) break; // ran out of warmed-up indicator history

      const isBullishBar = candles[i].close > sma9 && rsi14 >= 55;
      const isBearishBar = candles[i].close < sma9 && rsi14 <= 45;

      if (!bullishStreakBroken && isBullishBar) {
        consecutiveBullishBars++;
      } else {
        bullishStreakBroken = true;
      }

      if (!bearishStreakBroken && isBearishBar) {
        consecutiveBearishBars++;
      } else {
        bearishStreakBroken = true;
      }

      if (bullishStreakBroken && bearishStreakBroken) break; // neither streak can extend any further back
    }

    return { consecutiveBullishBars, consecutiveBearishBars };
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

  /**
   * PIVOT & STRUCTURE REACTION ANALYSIS ENGINE (NEW).
   *
   * Builds the dynamic array of structural price levels SignalsService uses
   * for both the entry reaction filter (breakout/breakdown/bounce/rejection
   * confirmation) and the target-snap (see `resolveTargetPoints()` there).
   * Two sources are merged into one sorted array:
   *
   *   1. The classic daily floor-trader pivots (Pivot/R1/R2/S1/S2), passed
   *      in already computed by `computeDailyLevels()` — these are
   *      well-known levels every participant is watching, one touch each.
   *   2. Intraday 5m swing-high/low clusters, detected fresh from *today's*
   *      candles only (yesterday's swings aren't "intraday structure" for
   *      today — same session-boundary filtering as `computeSeries()`). A
   *      bar confirms as a local swing high/low when its high/low is the
   *      most extreme within a `SWING_WINDOW_BARS`-bar window on each side.
   *      Raw swing points are then merged: any two within
   *      `SWING_CLUSTER_TOLERANCE_ATR_MULT` x ATR(14) of each other collapse
   *      into one level (the cluster's average price), with `strength` =
   *      how many touches merged into it — several nearby reactions are a
   *      stronger structural level than a single touch.
   *   3. FALLBACK levels — session VWAP and the morning-window (09:15–10:30)
   *      high/low, both drawn from *today's* candles only. These exist so
   *      Mid-Day's stricter `requirePivotLevel` confirmation rule (see
   *      SignalsService.passesStructuralReactionFilter()) isn't limited to
   *      just the four fixed daily-pivot numbers — VWAP and the opening
   *      range are levels every intraday participant is also watching, just
   *      as "structural" as a floor pivot, but responsive to where *today*
   *      actually traded instead of yesterday's range. See
   *      `computeSessionVWAP()` / `computeMorningRange()`.
   *
   * `atr14` scales the cluster tolerance to the day's actual volatility
   * (tight on a quiet day, wider on a choppy one) rather than a fixed point
   * count that would over- or under-cluster depending on the session.
   */
  computeReactionLevels(candles: CandleBar[], dailyLevels: DailyLevels, atr14: number): ReactionLevel[] {
    const pivotLevels = this.dailyLevelsToReactionLevels(dailyLevels);
    if (candles.length === 0) {
      return pivotLevels;
    }

    const latestSessionDate = toISTIsoDate(candles[candles.length - 1].timestamp);
    const session = candles.filter((candle) => toISTIsoDate(candle.timestamp) === latestSessionDate);

    const window = IndicatorsService.SWING_WINDOW_BARS;
    const rawSwingPoints: number[] = [];
    for (let i = window; i < session.length - window; i++) {
      const neighborhood = session.slice(i - window, i + window + 1);
      if (session[i].high === Math.max(...neighborhood.map((candle) => candle.high))) {
        rawSwingPoints.push(session[i].high);
      }
      if (session[i].low === Math.min(...neighborhood.map((candle) => candle.low))) {
        rawSwingPoints.push(session[i].low);
      }
    }

    // Guard against a zero/near-zero ATR read (e.g. the very first bars of
    // the day) collapsing every swing point into one giant cluster.
    const tolerance = Math.max(atr14 * IndicatorsService.SWING_CLUSTER_TOLERANCE_ATR_MULT, 1);
    const swingLevels = this.clusterSwingPoints(rawSwingPoints, tolerance);
    const fallbackLevels = this.computeFallbackLevels(session);

    return [...pivotLevels, ...swingLevels, ...fallbackLevels].sort((a, b) => a.level - b.level);
  }

  /** Builds the FALLBACK reaction levels (session VWAP + morning high/low) — see `computeReactionLevels()` step 3. */
  private computeFallbackLevels(session: CandleBar[]): ReactionLevel[] {
    const levels: ReactionLevel[] = [];

    const vwap = this.computeSessionVWAP(session);
    if (vwap !== null) {
      levels.push({ level: vwap, kind: 'FALLBACK', strength: 1 });
    }

    const morningRange = this.computeMorningRange(session);
    if (morningRange !== null) {
      levels.push({ level: morningRange.high, kind: 'FALLBACK', strength: 1 });
      levels.push({ level: morningRange.low, kind: 'FALLBACK', strength: 1 });
    }

    return levels;
  }

  /**
   * Session VWAP (volume-weighted average price) from today's candles so
   * far: cumulative(typicalPrice × volume) / cumulative(volume), typical
   * price = (H+L+C)/3. Returns `null` for an empty session.
   *
   * CAVEAT: Yahoo Finance reports `volume: 0` for index symbols like
   * ^NSEI — an index has no traded volume of its own, only its constituent
   * stocks do — so the weighted formula degenerates to 0/0 in practice.
   * Rather than surface that as a level (or throw), this falls back to an
   * unweighted time-average of typical price (equivalent to a "TWAP") once
   * cumulative volume is 0, so the fallback level is still usable on an
   * index feed instead of silently disappearing from every reaction-level
   * set. If a genuine volume-carrying feed is ever wired in instead, the
   * weighted branch takes over automatically.
   */
  private computeSessionVWAP(session: CandleBar[]): number | null {
    if (session.length === 0) return null;

    let cumulativeTypicalVolume = 0;
    let cumulativeVolume = 0;
    let sumTypicalPrice = 0;

    for (const candle of session) {
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativeTypicalVolume += typicalPrice * candle.volume;
      cumulativeVolume += candle.volume;
      sumTypicalPrice += typicalPrice;
    }

    if (cumulativeVolume > 0) {
      return this.round(cumulativeTypicalVolume / cumulativeVolume);
    }

    return this.round(sumTypicalPrice / session.length); // TWAP fallback — see CAVEAT above.
  }

  /**
   * Today's high/low over just the Morning session window (09:15–10:30
   * IST, reused from `SESSION_WINDOW_BOUNDS` so it can't drift out of sync
   * with SignalsService's own window boundaries). Returns `null` before
   * any Morning-window candle exists yet (e.g. evaluating at 09:15 sharp).
   */
  private computeMorningRange(session: CandleBar[]): { high: number; low: number } | null {
    const { startMinutes, endMinutes } = SESSION_WINDOW_BOUNDS.MORNING;
    const morningCandles = session.filter((candle) => {
      const { hour, minute } = getISTDateParts(candle.timestamp);
      const minutesSinceMidnight = hour * 60 + minute;
      return minutesSinceMidnight >= startMinutes && minutesSinceMidnight < endMinutes;
    });

    if (morningCandles.length === 0) return null;

    return {
      high: Math.max(...morningCandles.map((candle) => candle.high)),
      low: Math.min(...morningCandles.map((candle) => candle.low)),
    };
  }

  private dailyLevelsToReactionLevels(levels: DailyLevels): ReactionLevel[] {
    return [
      { level: levels.support2, kind: 'PIVOT', strength: 1 },
      { level: levels.support1, kind: 'PIVOT', strength: 1 },
      { level: levels.pivot, kind: 'PIVOT', strength: 1 },
      { level: levels.resistance1, kind: 'PIVOT', strength: 1 },
      { level: levels.resistance2, kind: 'PIVOT', strength: 1 },
    ];
  }

  /** Merges raw swing-high/low prices within `tolerance` of each other into single-level clusters, sorted ascending before merging so only adjacent points are ever compared. */
  private clusterSwingPoints(rawPoints: number[], tolerance: number): ReactionLevel[] {
    if (rawPoints.length === 0) return [];

    const sorted = [...rawPoints].sort((a, b) => a - b);
    const clusters: { sum: number; count: number }[] = [];

    for (const point of sorted) {
      const current = clusters[clusters.length - 1];
      if (current && point - current.sum / current.count <= tolerance) {
        current.sum += point;
        current.count += 1;
      } else {
        clusters.push({ sum: point, count: 1 });
      }
    }

    return clusters.map((cluster) => ({
      level: this.round(cluster.sum / cluster.count),
      kind: 'SWING' as const,
      strength: cluster.count,
    }));
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
