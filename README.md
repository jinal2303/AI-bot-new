# Nifty 50 Options Signal Tracker

A production-ready, automated Nifty 50 options-signal system with a persisted trade
ledger: a NestJS backend ticks every 60 seconds during Indian market hours, pulls live
Nifty 50 (`^NSEI`) 5-minute candles, computes a 9-period SMA, 14-period RSI, and 14-period
ATR (volatility), picks the weekly options-expiry cycle by day-of-week, and — subject to
a daily overtrading throttle and a one-position-at-a-time guard — persists a new signal
to PostgreSQL, its exit levels sized off ATR rather than a fixed point count. A second,
fast 10-second ticker independently re-evaluates every open position against the live
spot price and flips it to `TARGET_HIT` / `STOPLOSS_HIT` the instant its boundary is
crossed, broadcasting the change over WebSockets. The Next.js frontend has two screens: a
live daily dashboard (today's signals, stats, chart) and a filterable all-time archive —
with native desktop popups (and distinct win/loss audio chimes) firing the moment a
signal opens or resolves.

```
boat/
├── backend/    NestJS (TypeScript) — 60s strategy cron, 10s position monitor,
│               Prisma/PostgreSQL, WebSocket gateway, REST API
└── frontend/   Next.js App Router + Tailwind CSS + Shadcn/ui — /dashboard, /archive,
                live chart, desktop notifications, in-app exit popups
```

## Strategy rules

| Condition                                                | Signal            |
|-----------------------------------------------------------|--------------------|
| Spot > SMA(9) **and** 55 ≤ RSI(14) ≤ 65                    | `BUY CALL (CE)`    |
| Spot < SMA(9) **and** 35 ≤ RSI(14) ≤ 45                    | `BUY PUT (PE)`     |
| Otherwise (choppy / overextended)                          | `NO_SIGNAL`         |

The bot holds **exactly one open position at a time** — a new signal is only persisted
when nothing is currently `ACTIVE`. **ATM strike** = spot rounded to the nearest 50.

### Expiry-cycle selection (day of week, IST)

| Day                          | Expiry target  |
|-------------------------------|----------------|
| Friday, Monday, Tuesday       | `CURRENT_WEEK` |
| Wednesday, Thursday           | `NEXT_WEEK` (dodges the terminal Theta cliff) |

### Risk protocol — fixed to 1 lot (65 units), ATM delta proxy 0.5

Exit distances are **not** a fixed point count — they scale with the market's own recent
volatility:

```
indexStopLossPoints = ATR(14) × ATR_STOPLOSS_MULTIPLIER  (default 1)
```

**Target** prefers a real support/resistance pivot over a symmetric ATR distance — the
nearest resistance above entry for a CALL, nearest support below for a PUT — computed from
the previous session's floor-trader pivot points (`Pivot = (H+L+C)/3`, R1/R2/S1/S2; see
[Day Range & Pivots](#day-range--support-resistance) below). It's used directly when that
pivot offers at least a 1:1 reward:risk versus the stop-loss; otherwise the target falls
back to `ATR(14) × ATR_TARGET_MULTIPLIER` (default 2, a 2:1 reward:risk) so a good setup
is never skipped just because pivots happen to be badly placed. Which basis was used is
recorded on the row as `targetBasis: 'PIVOT' | 'ATR'`.

A choppy, high-ATR session naturally gets a wider stop; a quiet one gets pulled in
tighter. Option-premium points and cash P&L (`optionPoints × lotSize`) are then fully
derived from these distances — no separate fixed rupee figure to keep in sync. Once a
position is open, its exact levels (and the ATR reading + target basis they were sized
from) are
persisted on the row and never recomputed — the "Active Trade Setup" card always shows
the real levels the position monitor is watching, immune to ATR moving on later ticks.

### Day Range & Support/Resistance

Computed each tick from the already-fetched multi-day candle history (grouped by IST
calendar date — no extra market-data fetch): today's running **High**/**Low**, plus
classic floor-trader pivot points from the *previous* session's high/low/close —
`Pivot = (H+L+C)/3`, `R1 = 2P−L`, `S1 = 2P−H`, `R2 = P+range`, `S2 = P−range`. These feed
the target-basis logic above and render as a color-coded R2/R1/Pivot/S1/S2 ladder on the
dashboard's spot card — reference levels, not guarantees.

### Market headlines (the "external factors" input)

A small, deliberately unambitious feature: [NewsService](backend/src/news/news.service.ts)
pulls the latest Nifty/Sensex/NSE headlines from Google News' free public RSS search
endpoint (`news.google.com/rss/search`) — no API key, no registration — cached 10 minutes,
and served at `GET /api/news/headlines`. It's purely informational (the dashboard's Market
Headlines panel, linking out to each article) and **never feeds back into the strategy
engine** — a real sentiment/event-driven filter would need a paid or key-gated API, which
breaks this project's keyless design.

### Daily overtrading throttle

Before doing any indicator work, the 60s cron counts today's persisted signals. At
**`MAX_DAILY_SIGNALS`** (clamped to **[5, 10]** regardless of what's configured, default
10) it halts entirely — no more Yahoo Finance calls — until the next calendar day.

---

## 1. Backend — NestJS (`/backend`)

**Stack:** NestJS 10, Prisma 5 + PostgreSQL, `@nestjs/websockets` (socket.io),
`@nestjs/event-emitter`, `@nestjs/schedule` (`@Cron` + `@Interval`), `yahoo-finance2`
(no API key), `technicalindicators`, fully typed TypeScript.

### Setup

```bash
cd backend
npm install                 # also runs `prisma generate` (postinstall)
cp .env.example .env        # set DATABASE_URL to your Postgres instance
npm run db:migrate          # creates the TradeSignal table + indexes
npm run dev                 # http://localhost:4000/api  (alias for start:dev)
```

`DATABASE_URL` defaults to `postgresql://postgres:postgres@localhost:5432/ai-bot?schema=public`
in `.env.example` — point it at your own Postgres server/credentials, then create the
database once (`CREATE DATABASE "ai-bot";`) before running `db:migrate`.

### Data model — `TradeSignal` ([prisma/schema.prisma](backend/prisma/schema.prisma))

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `timestamp` | `timestamptz` | absolute instant — see the timezone note below |
| `dateString` | `YYYY-MM-DD` (IST) | denormalized for O(1) daily-throttle/today queries |
| `direction` | `CALL` \| `PUT` | |
| `strikePrice`, `expiryType` | | |
| `entrySpotPrice`, `stopLossSpot`, `targetSpot` | | absolute levels, fixed at creation |
| `atr14` | nullable | the ATR(14) reading these levels were sized from |
| `targetBasis` | nullable | `PIVOT` \| `ATR` — which basis `targetSpot` came from |
| `currentStatus` | `ACTIVE` \| `TARGET_HIT` \| `STOPLOSS_HIT` | |
| `resolvedAt`, `resolvedSpot` | nullable | set by the position monitor on exit |
| `peakSpot` | nullable | best-favorable price seen since entry (highest for CALL, lowest for PUT), updated every 10s tick it improves |

Indexed on `dateString`, `currentStatus`, `direction`, `expiryType`, the
`[dateString, currentStatus]` composite (the hot "today's active positions" path), and
`timestamp` (archive sort/range) — every query on the hot paths hits an index.

> **Timezone note:** this dev box's Postgres session timezone is `Asia/Kolkata`. A plain
> (tz-naive) `timestamp` column would have silently stored IST wall-clock digits that
> then get *re-interpreted* as UTC on read, double-shifting every displayed time forward
> by 5:30 — caught live during development. Both time columns are `@db.Timestamptz(3)`,
> which stores an absolute instant immune to the session timezone, however the DB server
> is configured.

### Key files
- [src/signals/signals.service.ts](backend/src/signals/signals.service.ts) — the 60s cron: daily-throttle check, indicators, strategy, persists a new `TradeSignal` when the active-position guard allows it.
- [src/trades/trades.service.ts](backend/src/trades/trades.service.ts) — all TradeSignal reads/writes (throttle count, active-position check, create, today, filtered archive).
- [src/trades/position-monitor.service.ts](backend/src/trades/position-monitor.service.ts) — the **10s** `@Interval` ticker: fetches a live quote, resolves ACTIVE positions, emits an internal event.
- [src/realtime/signals.gateway.ts](backend/src/realtime/signals.gateway.ts) — WebSocket gateway; re-broadcasts that event as `signal-status-changed` to every connected dashboard.
- [src/market-data/market-data.service.ts](backend/src/market-data/market-data.service.ts) — `yahoo-finance2` 5m candle fetch (strategy) + a lightweight live-quote fetch (position monitor), both try/catch wrapped.
- [src/expiry/expiry.service.ts](backend/src/expiry/expiry.service.ts) — CURRENT_WEEK / NEXT_WEEK day-of-week logic.

### REST endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/signals/latest` | Live spot/SMA/RSI snapshot, chart series, current strategy read, daily-throttle state — recomputed every 60s. |
| `GET /api/signals/today` | Every `TradeSignal` generated on the current IST date (append-only feed — the Screen 1 table). |
| `GET /api/signals/archive?status=&direction=&expiryType=&dateFrom=&dateTo=&limit=&offset=` | Filtered, paginated historical signals — `{ items, total, limit, offset }`. |
| `GET /api/news/headlines` | Latest Nifty/Sensex/NSE headlines from Google News RSS, cached 10 min — informational only. |

### WebSocket

Connect to the backend's root namespace (e.g. `io('http://localhost:4000')`) and listen
for `signal-status-changed`:

```json
{
  "signal": { "id": "...", "direction": "CALL", "strikePrice": 23650, "currentStatus": "TARGET_HIT", "resolvedSpot": 23712.4, "...": "..." },
  "livePrice": 23712.4,
  "netCashINR": 1950
}
```

### Production build

```bash
npm run build
npm run db:deploy   # applies migrations without the interactive dev prompt
npm run start:prod
```

---

## 2. Frontend — Next.js (`/frontend`)

**Stack:** Next.js 14 (App Router), Tailwind CSS, Shadcn/ui-style components, Recharts,
`socket.io-client`, native browser `Notification` + `AudioContext` APIs.

### Setup

```bash
cd frontend
npm install
cp .env.local.example .env.local   # point NEXT_PUBLIC_API_BASE_URL at the backend
npm run dev                        # http://localhost:3000 → redirects to /dashboard
```

### Screen 1 — `/dashboard`
Live spot/SMA/RSI hero card, active-trade-setup card, the candlestick+SMA/RSI chart,
a **Today's Stats** row (total/active/target-hit/stop-loss-hit/win-rate, computed from
the today list), and a **Today's Signals** table — append-only, never wiped mid-day —
with a status [Badge](frontend/src/components/ui/badge.tsx): amber + `animate-pulse` for
`ACTIVE`, emerald for `TARGET_HIT`, deep crimson for `STOPLOSS_HIT`.

### Screen 2 — `/archive`
[ArchiveFiltersBar](frontend/src/components/archive-filters.tsx) — Shadcn-style Select
fields (Outcome / Direction / Expiry Window) plus native date-range pickers — driving a
paginated table over `GET /api/signals/archive`.

### Chart module
[src/components/nifty-chart.tsx](frontend/src/components/nifty-chart.tsx) — a dual-panel
Recharts view: candlesticks (custom shape, drawn from a `[low, high]` range bar) with the
SMA(9) line overlaid and entry/target/stop-loss reference lines when a signal is active,
plus a separate RSI(14) sub-panel with dashed boundary lines at 35/45/55/65.

### Live updates & notifications

- [use-signal-polling.ts](frontend/src/hooks/use-signal-polling.ts) polls `/latest` every 30s for the live snapshot/chart, and requests `Notification.requestPermission()` on mount.
- [use-today-signals.ts](frontend/src/hooks/use-today-signals.ts) polls `/today` every 30s. A row with an `id` never seen before is a genuinely new signal event (each row is created exactly once) — it fires:
  - **Title:** `🚨 BOT SIGNAL DETECTED!`
  - **Body:** `BUY NIFTY [Strike] [CE/PE] ([CURRENT/NEXT] Expiry) | 1 Lot (65 units)` / `Max Risk: -₹[X] | Target: +₹[Y]` (both ATR-derived, varying per signal)
- Also fired **instantly** (no 30s poll wait) via [use-trade-socket.ts](frontend/src/hooks/use-trade-socket.ts)'s `signal-created` WebSocket listener — the poll is a resilience fallback only.
- [use-trade-socket.ts](frontend/src/hooks/use-trade-socket.ts) connects to the WebSocket gateway. On `signal-status-changed` it instantly upserts the row into the today table/stats, pushes an in-app **[exit toast](frontend/src/components/exit-toast.tsx)**, and fires the native exit notification (net cash computed from the *actual* resolved index-point move, not a fixed distance):
  - **Target:** `🎯 TARGET ACHIEVED!` / `NIFTY [Strike] [CE/PE] hit profit target! Net: +₹[X] per lot.`
  - **Stop-Loss:** `⚠️ STOP-LOSS TRIGGERED` / `NIFTY [Strike] [CE/PE] exited at protection risk limit. Net: -₹[X] per lot.`
  - Plus a distinct synthesized win/loss audio chime ([lib/sound.ts](frontend/src/lib/sound.ts), pure Web Audio oscillators — no external sound assets) alongside the OS's own default notification ping.
- The signal active *when the dashboard is first opened* is treated as a baseline and doesn't re-fire a notification.

### Production build

```bash
npm run build
npm run start   # http://localhost:3000
```

---

## Zero-setup local run (two terminals)

```bash
# Terminal 1 — needs a running PostgreSQL instance
cd backend && npm install && cp .env.example .env
# edit DATABASE_URL in .env, then: createdb ai-bot (or CREATE DATABASE "ai-bot";)
npm run db:migrate && npm run dev

# Terminal 2
cd frontend && npm install && cp .env.local.example .env.local && npm run dev
```

Open `http://localhost:3000`, allow notification permission when prompted, and leave it
running during market hours (09:15–15:30 IST, Mon–Fri) to receive live signal + exit
alerts.

## Notes & caveats

- The only non-npm dependency is a PostgreSQL server — no trading/broker API keys are needed, Yahoo Finance is queried anonymously via `yahoo-finance2`.
- Exit sizing is volatility-based (`ATR_TARGET_MULTIPLIER` / `ATR_STOPLOSS_MULTIPLIER` in `.env`, default 2:1), not a fixed point count — see `signals.service.ts`. The exit notification's cash figure is computed from the *actual* resolved index-point move (`position-monitor.service.ts`), not a re-derivation of the entry estimate.
- `MAX_DAILY_SIGNALS` is clamped to [5, 10] in code regardless of `.env` — a misconfiguration can't silently disable the overtrading guard.
- NSE's weekly-expiry weekday (`EXPIRY_WEEKDAY` in `expiry.service.ts`, default Thursday) and market hours (`market-hours.util.ts`) are single named constants to update if the exchange revises them; Indian market holidays are not accounted for.
- This is an educational/demo signal engine, not investment advice — validate independently before trading on it.
