# Nifty 50 Options Signal Tracker

A production-ready, automated Nifty 50 options-signal system: a NestJS backend ticks
every 60 seconds during Indian market hours, pulls live Nifty 50 (`^NSEI`) 5-minute
candles, computes a 9-period SMA and 14-period RSI, picks the weekly options-expiry
cycle by day-of-week, and emits a single directional signal with a hardcoded 1-lot
risk protocol. A Next.js dashboard polls that signal every 30 seconds, charts it
(candlesticks + SMA overlay, RSI sub-panel), and fires a native desktop alert the
instant a fresh signal appears.

```
boat/
├── backend/    NestJS (TypeScript) — 60s cron, indicators, expiry logic, risk math
└── frontend/   Next.js App Router + Tailwind CSS + Shadcn/ui — dashboard, charts, notifications
```

## Strategy rules

| Condition                                                | Signal            |
|-----------------------------------------------------------|--------------------|
| Spot > SMA(9) **and** 55 ≤ RSI(14) ≤ 65                    | `BUY CALL (CE)`    |
| Spot < SMA(9) **and** 35 ≤ RSI(14) ≤ 45                    | `BUY PUT (PE)`     |
| Otherwise (choppy / overextended)                          | `NO_SIGNAL`         |

Only one signal is active at a time. **ATM strike** = spot rounded to the nearest 50.

### Expiry-cycle selection (day of week, IST)

| Day                          | Expiry target  |
|-------------------------------|----------------|
| Friday, Monday, Tuesday       | `CURRENT_WEEK` |
| Wednesday, Thursday           | `NEXT_WEEK` (dodges the terminal Theta cliff) |

### Risk protocol — fixed to 1 lot (65 units), ATM delta proxy 0.5

- Index target: **60 pts** → option premium proxy **30 pts** → **+₹1,900** cash target
- Index stop-loss: **30 pts** → option premium proxy **15 pts** → **-₹975** max cash risk

---

## 1. Backend — NestJS (`/backend`)

**Stack:** NestJS 10, `@nestjs/schedule` (`@Cron(CronExpression.EVERY_MINUTE)`),
`yahoo-finance2` (no API key), `technicalindicators` (SMA/RSI), fully typed TypeScript.

### Setup

```bash
cd backend
npm install
cp .env.example .env      # adjust CORS_ORIGIN / risk constants if needed
npm run start:dev         # http://localhost:4000/api
```

### Key files
- [src/signals/signals.service.ts](backend/src/signals/signals.service.ts) — the 60s cron job, strategy evaluation, 1-lot risk math, signal-event id stability.
- [src/market-data/market-data.service.ts](backend/src/market-data/market-data.service.ts) — `yahoo-finance2` 5m candle fetch, try/catch wrapped.
- [src/indicators/indicators.service.ts](backend/src/indicators/indicators.service.ts) — SMA(9)/RSI(14) via `technicalindicators`, ATM strike rounding, chart-ready series (trimmed to the latest trading session).
- [src/expiry/expiry.service.ts](backend/src/expiry/expiry.service.ts) — CURRENT_WEEK / NEXT_WEEK day-of-week logic.
- [src/common/ist-time.util.ts](backend/src/common/ist-time.util.ts) / [market-hours.util.ts](backend/src/common/market-hours.util.ts) — IST date math and the 09:15–15:30 Mon–Fri trading-hours guard.
- [src/signals/signals.controller.ts](backend/src/signals/signals.controller.ts) — `GET /api/signals/latest`.

### Endpoint

```
GET /api/signals/latest
```

```json
{
  "id": "uuid",
  "generatedAt": "2026-09-08T07:11:31.052Z",
  "symbol": "^NSEI",
  "spot": 23720.5,
  "sma9": 23695.1,
  "rsi14": 58.4,
  "atmStrike": 23700,
  "optionType": "CE",
  "signal": "BUY CALL (CE)",
  "expiry": { "cycle": "CURRENT_WEEK", "date": "2026-09-10", "label": "10 Sep 2026 (Current Week)" },
  "tradeRules": {
    "entryPrice": 23720.5, "indexTarget": 23780.5, "indexStopLoss": 23690.5,
    "indexTargetPoints": 60, "indexStopLossPoints": 30,
    "optionTargetPoints": 30, "optionStopLossPoints": 15,
    "deltaProxy": 0.5, "lotSize": 65,
    "maxRiskCashINR": 975, "targetCashINR": 1900
  },
  "marketOpen": true,
  "series": [ { "timestamp": "...", "open": 0, "high": 0, "low": 0, "close": 0, "sma9": 0, "rsi14": 0 } ]
}
```

The very first request (before the first cron tick) triggers an on-demand refresh, so
the endpoint never returns empty. `id` (and `generatedAt`) stay stable across ticks as
long as the same signal setup (direction + strike) persists — a fresh id is minted only
when the trade setup actually changes, so the frontend fires exactly one desktop alert
per signal event, not one every poll. If Yahoo Finance is temporarily unreachable, the
service logs the error and keeps serving the last known-good signal instead of crashing
(verified live against a real transient network failure during development).

### Production build

```bash
npm run build
npm run start:prod
```

---

## 2. Frontend — Next.js (`/frontend`)

**Stack:** Next.js 14 (App Router), Tailwind CSS, Shadcn/ui-style components, Recharts
(candlestick + SMA overlay, RSI sub-panel), native browser `Notification` API.

### Setup

```bash
cd frontend
npm install
cp .env.local.example .env.local   # point NEXT_PUBLIC_API_BASE_URL at the backend
npm run dev                        # http://localhost:3000
```

### Chart module
[src/components/nifty-chart.tsx](frontend/src/components/nifty-chart.tsx) — a dual-panel
Recharts view: candlesticks (custom shape, drawn from a `[low, high]` range bar) with the
SMA(9) line overlaid and entry/target/stop-loss reference lines when a signal is active,
plus a separate RSI(14) sub-panel with dashed boundary lines at 35/45/55/65.

### Desktop notifications

- On mount, the dashboard calls `Notification.requestPermission()`.
- [src/hooks/use-signal-polling.ts](frontend/src/hooks/use-signal-polling.ts) polls `GET /api/signals/latest` every 30 seconds and tracks the last processed signal `id` in React state.
- The moment a **new** signal id arrives with `signal !== "NO_SIGNAL"`, [src/lib/notifications.ts](frontend/src/lib/notifications.ts) fires:
  - **Title:** `🚨 BOT SIGNAL DETECTED!`
  - **Body:** `BUY NIFTY [Strike] [CE/PE] ([CURRENT/NEXT] Expiry) | 1 Lot (65 units)` / `Max Risk: -₹975 | Target: +₹1,900`
  - `silent` is left at its default (`false`), so the OS plays its standard notification sound.
- The signal active *when the dashboard is first opened* is treated as a baseline and does not fire a notification — only genuinely new signal events do (backed by the id-stability guarantee above, so an unchanged signal never re-fires on every poll).

### Production build

```bash
npm run build
npm run start   # http://localhost:3000
```

---

## Zero-setup local run (two terminals)

```bash
# Terminal 1
cd backend && npm install && cp .env.example .env && npm run start:dev

# Terminal 2
cd frontend && npm install && cp .env.local.example .env.local && npm run dev
```

Open `http://localhost:3000`, allow notification permission when prompted, and leave it
running during market hours (09:15–15:30 IST, Mon–Fri) to receive live signal alerts.

## Notes & caveats

- No trading/broker API keys are required — Yahoo Finance is queried anonymously via `yahoo-finance2`.
- The ₹1,900 target and ₹975 max-risk cash figures are the desk's rounded, hardcoded risk-sheet constants (per spec) rather than a live `optionPoints × lotSize` recomputation each tick — see the comment in `signals.service.ts` for the ~₹50 rounding note.
- NSE's weekly-expiry weekday (`EXPIRY_WEEKDAY` in `expiry.service.ts`, default Thursday) is a single named constant — update it in one place if the exchange revises it again.
- Indian market-holiday calendars are not accounted for in `isIndianMarketOpen()`; the cron simply skips non-market hours/weekends.
- This is an educational/demo signal engine, not investment advice — validate independently before trading on it.
