'use client';

import { useMemo } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SeriesPoint, TradeRules } from '@/lib/types';

const BULLISH_COLOR = 'hsl(142 71% 45%)';
const BEARISH_COLOR = 'hsl(0 72% 51%)';
const SMA_COLOR = 'hsl(217 91% 60%)';
const RSI_COLOR = 'hsl(38 92% 55%)';
const GRID_COLOR = 'hsl(240 6% 20%)';
const AXIS_COLOR = 'hsl(215 15% 65%)';

interface ChartPoint extends SeriesPoint {
  index: number;
  range: [number, number];
}

interface NiftyChartProps {
  series: SeriesPoint[];
  tradeRules: TradeRules | null;
}

export function NiftyChart({ series, tradeRules }: NiftyChartProps) {
  const data = useMemo<ChartPoint[]>(() => {
    // Drop the initial warm-up bars where SMA(9)/RSI(14) don't have enough
    // lookback yet, so the overlays don't start with a jarring empty gap.
    const startIndex = series.findIndex((point) => point.sma9 !== null && point.rsi14 !== null);
    const trimmed = startIndex === -1 ? series : series.slice(startIndex);

    return trimmed.map((point, index) => ({
      ...point,
      index,
      range: [point.low, point.high],
    }));
  }, [series]);

  const formatTime = (index: number) => {
    const point = data[index];
    if (!point) return '';
    return new Date(point.timestamp).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Kolkata',
    });
  };

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            5-MIN CHART · SMA(9) · RSI(14)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
            Waiting for enough candle history to chart…
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          5-MIN CHART · SMA(9) · RSI(14)
        </CardTitle>
        <Legend />
      </CardHeader>
      <CardContent className="space-y-1">
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="index"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={formatTime}
              stroke={AXIS_COLOR}
              tick={{ fontSize: 11 }}
              allowDecimals={false}
              minTickGap={40}
            />
            <YAxis
              domain={['auto', 'auto']}
              stroke={AXIS_COLOR}
              tick={{ fontSize: 11 }}
              width={64}
              tickFormatter={(value: number) => value.toLocaleString('en-IN')}
            />
            <Tooltip content={<PriceTooltip />} />
            {tradeRules && (
              <>
                <ReferenceLine y={tradeRules.entryPrice} stroke={AXIS_COLOR} strokeDasharray="2 2" />
                <ReferenceLine y={tradeRules.indexTarget} stroke={BULLISH_COLOR} strokeDasharray="4 4" />
                <ReferenceLine y={tradeRules.indexStopLoss} stroke={BEARISH_COLOR} strokeDasharray="4 4" />
              </>
            )}
            <Bar dataKey="range" shape={<CandleShape />} isAnimationActive={false} />
            <Line
              type="monotone"
              dataKey="sma9"
              stroke={SMA_COLOR}
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>

        <ResponsiveContainer width="100%" height={140}>
          <ComposedChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="index"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={formatTime}
              stroke={AXIS_COLOR}
              tick={{ fontSize: 11 }}
              allowDecimals={false}
              minTickGap={40}
            />
            <YAxis domain={[0, 100]} stroke={AXIS_COLOR} tick={{ fontSize: 11 }} width={64} ticks={[0, 35, 45, 55, 65, 100]} />
            <Tooltip content={<RsiTooltip />} />
            <ReferenceLine y={65} stroke={BULLISH_COLOR} strokeDasharray="4 4" label={{ value: '65', fontSize: 10, fill: BULLISH_COLOR, position: 'right' }} />
            <ReferenceLine y={55} stroke={BULLISH_COLOR} strokeDasharray="2 2" label={{ value: '55', fontSize: 10, fill: BULLISH_COLOR, position: 'right' }} />
            <ReferenceLine y={45} stroke={BEARISH_COLOR} strokeDasharray="2 2" label={{ value: '45', fontSize: 10, fill: BEARISH_COLOR, position: 'right' }} />
            <ReferenceLine y={35} stroke={BEARISH_COLOR} strokeDasharray="4 4" label={{ value: '35', fontSize: 10, fill: BEARISH_COLOR, position: 'right' }} />
            <Line
              type="monotone"
              dataKey="rsi14"
              stroke={RSI_COLOR}
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

/**
 * Custom candlestick body+wick, drawn from the [low, high] "range" the Bar
 * is plotted against. Recharts hands the shape the pixel geometry for that
 * range (`y` = pixel for `high`, `y + height` = pixel for `low`) plus the
 * full data payload, so open/close are interpolated linearly within it.
 */
function CandleShape(props: unknown) {
  const { x, y, width, height, payload } = props as {
    x: number;
    y: number;
    width: number;
    height: number;
    payload: ChartPoint;
  };
  const { open, close, high, low } = payload;

  const isBullish = close >= open;
  const color = isBullish ? BULLISH_COLOR : BEARISH_COLOR;
  const priceRange = high - low || 1;
  const scaleY = (price: number) => y + height * (1 - (price - low) / priceRange);

  const openY = scaleY(open);
  const closeY = scaleY(close);
  const bodyTop = Math.min(openY, closeY);
  const bodyHeight = Math.max(Math.abs(closeY - openY), 1);

  const wickX = x + width / 2;
  const bodyWidth = Math.max(width * 0.6, 1);
  const bodyX = x + (width - bodyWidth) / 2;

  return (
    <g>
      <line x1={wickX} x2={wickX} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect x={bodyX} y={bodyTop} width={bodyWidth} height={bodyHeight} fill={color} />
    </g>
  );
}

function PriceTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartPoint }> }) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 text-muted-foreground">
        {new Date(point.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}
      </p>
      <p>O: <span className="tabular-nums">{point.open.toFixed(2)}</span></p>
      <p>H: <span className="tabular-nums">{point.high.toFixed(2)}</span></p>
      <p>L: <span className="tabular-nums">{point.low.toFixed(2)}</span></p>
      <p>C: <span className="tabular-nums">{point.close.toFixed(2)}</span></p>
      {point.sma9 !== null && (
        <p className="mt-1" style={{ color: SMA_COLOR }}>
          SMA9: <span className="tabular-nums">{point.sma9.toFixed(2)}</span>
        </p>
      )}
    </div>
  );
}

function RsiTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartPoint }> }) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 text-muted-foreground">
        {new Date(point.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}
      </p>
      <p style={{ color: RSI_COLOR }}>
        RSI(14): <span className="tabular-nums">{point.rsi14 !== null ? point.rsi14.toFixed(2) : '—'}</span>
      </p>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <LegendItem color={BULLISH_COLOR} label="Bullish" />
      <LegendItem color={BEARISH_COLOR} label="Bearish" />
      <LegendItem color={SMA_COLOR} label="SMA(9)" />
      <LegendItem color={RSI_COLOR} label="RSI(14)" />
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
