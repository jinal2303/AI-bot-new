# Nifty 50 Options Signal Tracker

A production-ready, automated Nifty 50 options-signal system with a persisted trade
ledger and **dynamic, in-flight risk management**: a NestJS backend ticks every 60
seconds during Indian market hours, pulls live Nifty 50 (`^NSEI`) 5-minute candles,
computes a 9-period SMA, 14-period RSI, and 14-period ATR (volatility), picks the
weekly options-expiry cycle by day-of-week, and — subject to a minimum-payoff filter, a
daily overtrading throttle, and a one-position-at-a-time guard — persists a new signal
to PostgreSQL, its exit levels sized off ATR rather than a fixed point count. A second,
fast 10-second ticker independently re-evaluates every open position against the live
spot price: it **ratchets the stop-loss into breakeven and then into locked-in profit**
as the trade moves favorably, **force-exits a stalled position** that's gone quiet after
30 minutes, and resolves the position the instant its (possibly-since-moved) boundary is
crossed — broadcasting every adjustment and exit over WebSockets and, optionally,
Telegram. The Next.js frontend has two screens: a live daily dashboard (today's active
call, stats, chart) and a filterable all-time archive — with native desktop popups
(distinct win/loss audio chimes), a live unrealized-P&L readout, and a heuristic
carry-to-next-session suggestion once the close is near.

```
boat/
├── backend/    NestJS (TypeScript) — 60s strategy cron, 10s position monitor,
│               Prisma/PostgreSQL, WebSocket gateway, Telegram hook, REST API
└── frontend/   Next.js App Router + Tailwind CSS + Shadcn/ui — /dashboard, /archive,
                live chart, desktop notifications, in-app exit popups
```

## Strategy rules

| Condition                                                | Signal            |
|-----------------------------------------------------------|--------------------|
| Spot > SMA(9) **and** 55 ≤ RSI(14) ≤ 65                    | `BUY CALL (CE)`    |
| Spot < SMA(9) **and** 35 ≤ RSI(14) ≤ 45                    | `BUY PUT (PE)`     |
| Otherwise (choppy / overextended)                          | `NO_SIGNAL`         |

Evaluated in [signals.service.ts → `evaluateStrategy()`](backend/src/signals/signals.service.ts).
The bot holds **exactly one open position at a time** — a new signal is only persisted
when nothing is currently `ACTIVE`. **ATM strike** = spot rounded to the nearest 50
(`STRIKE_STEP`).

### Expiry-cycle selection (day of week, IST)

| Day                          | Expiry target  |
|-------------------------------|----------------|
| Friday, Monday, Tuesday       | `CURRENT_WEEK` |
| Wednesday, Thursday           | `NEXT_WEEK` (dodges the terminal Theta cliff) |

[expiry.service.ts](backend/src/expiry/expiry.service.ts) — a pure day-of-week lookup, no
external data needed.

---

## Risk & exit sizing — entry-time

### 1. ATR-based stop-loss and target (not a fixed point count)

```
indexStopLossPoints = ATR(14) × ATR_STOPLOSS_MULTIPLIER   (default 1×)
atrTargetPoints      = ATR(14) × ATR_TARGET_MULTIPLIER     (default 2×)
```

A choppy, high-ATR session naturally gets a wider stop/target; a quiet one gets pulled in
tighter. `atrTargetPoints` is the **2:1 reward:risk default**.

### 2. Pivot-aware target selection

The target prefers a real support/resistance pivot over the symmetric ATR distance — the
nearest resistance above entry for a CALL, nearest support below for a PUT (see
[Day Range & Pivots](#day-range--supportresistance) below) — but **only when that pivot is
at least as far away as `atrTargetPoints`**:

```
if pivotDistance >= atrTargetPoints:
    target = pivot                       # targetBasis = 'PIVOT'
else:
    target = entry ± atrTargetPoints     # targetBasis = 'ATR'
```

This guarantees `indexTargetPoints` is **never less than `atrTargetPoints`**, whichever
branch fires — i.e. the reward:risk ratio can never silently degrade below the configured
default (2:1), no matter where pivots happen to sit. *(Earlier versions of this logic
qualified the pivot against the 1× ATR **stop-loss** distance instead of the 2× ATR
**target** distance — a bug that let pivots between 1×–2× ATR away slip through and ship
trades with as little as ~1:1 R:R while believing they were 2:1. Fixed in
[`resolveTargetPoints()`](backend/src/signals/signals.service.ts).)* Which basis was used
is recorded on the row as `targetBasis: 'PIVOT' | 'ATR'`.

### 3. Minimum-profit filter

Even a setup that clears the RSI/SMA/R:R bars can pay out too little to be worth the
fixed 1-lot brokerage/slippage overhead (thin ATR, or a target capped by a nearby pivot).
`refreshSignal()` downgrades any signal whose `targetCashINR < MIN_TARGET_CASH_INR`
(default **₹1000**) straight to `NO_SIGNAL` — same as any other disqualified read, so it
never reaches the trade-creation step.

Once a position is open, its exact levels (and the ATR reading + target basis they were
sized from) are persisted on the row at creation — the dashboard's Active Call card
always shows the real levels the position monitor is watching, immune to ATR moving on
later ticks. (`stopLossSpot`/`targetSpot` *do* keep changing after entry, but only via the
trailing-stop and stale-exit rules below — never by re-deriving from a moving ATR.)

---

## Risk management *after* entry — the 10s position monitor

[`position-monitor.service.ts`](backend/src/trades/position-monitor.service.ts) re-checks
every `ACTIVE` position against the live spot price every 10 seconds, independent of the
60s strategy cron. Per position, in order:

### 1. Exit check
Has the position's **current** target/stop-loss (which the rules below may have since
moved) been crossed? If so, resolve it and stop — nothing further applies once a position
is no longer `ACTIVE`.

### 2. Dynamic Profit Protection (trailing stop-loss)

Two one-directional ratchets, both expressed as "only ever *improve* `stopLossSpot`"
(`max()` for a CALL, `min()` for a PUT against the position's current stop) — so they
compose safely and the stop can never be loosened by a later, less-favorable tick. The
*trigger* is evaluated against `peakSpot` (best price ever seen), not just the current
tick, so a brief spike that has since pulled back still locks in what it earned:

| Stage | Trigger (peak favorable move) | New stop-loss |
|---|---|---|
| **Breakeven shield** | ≥ `TRAIL_BREAKEVEN_ATR_MULT` × ATR(14) (default **1.0×**) | entry price — the trade can no longer lose money |
| **Dynamic profit lock** | ≥ `TRAIL_PROFIT_LOCK_ATR_MULT` × ATR(14) (default **1.5×**) | entry ± `TRAIL_PROFIT_LOCK_FRACTION` × ATR(14) (default **0.75×** ATR) of *guaranteed* profit |

Progress is recorded on the row as `trailStage: 'NONE' | 'BREAKEVEN' | 'PROFIT_LOCK'`. A
stop hit while `trailStage !== 'NONE'` resolves as **`TRAIL_STOP_HIT`** (always a
scratch-or-better outcome) instead of `STOPLOSS_HIT` (the original entry-time risk stop).
This is exactly the "ran to +15–20pts against a +30pt target, then reversed into a full
stop-loss" scenario the feature exists to prevent — the stop is pulled up long before that
can happen.

### 3. Stale-position time exit

Once a position has been open ≥ `STALE_EXIT_MINUTES` (default **30 min**) without hitting
target, two independent, idempotent effects:

- **Target reduction (one-time):** if still in profit and not already adjusted, the
  target distance is pulled in by `STALE_TARGET_REDUCTION_PCT` (default **30%**) — a
  stalled move is less likely to still reach the original, more ambitious target.
  Recorded via `staleAdjusted: true` so it only ever fires once per position.
- **Forced market exit:** if the *current* favorable move has slipped back below
  `STALE_MIN_FAVORABLE_ATR_MULT` × ATR(14) (default **0.5×**) — i.e. the position is
  giving back the very edge that made it "stale but in profit" — it's force-closed at
  market as **`TIME_EXIT`** rather than left to round-trip into a full loss.

"Momentum has stalled" is inferred from reaching this rule at all: the exit check above
already confirmed target/stop-loss weren't hit, so a still-`ACTIVE` position past its
stale window has, by definition, neither resolved nor kept running toward target.

### Realized P&L

`netCashINR = |resolvedSpot − entrySpotPrice| × DELTA_PROXY × LOT_SIZE`, signed by the
*actual* favorable/unfavorable move at resolution (not a per-status lookup table) — this
gets all four terminal statuses right without special-casing: `TARGET_HIT`/`TRAIL_STOP_HIT`
only ever fire on the favorable side, `STOPLOSS_HIT` only on the unfavorable side, and
`TIME_EXIT` can legitimately land on either side of entry.

### Every level change is persisted immediately

`stopLossSpot`, `targetSpot`, `trailStage`, `staleAdjusted`, and `peakSpot` are all written
to Postgres the instant they change — not just held in memory — so every trailing/stale
adjustment survives a restart of the backend; the next tick simply re-reads the live state
from `findActivePositions()`.

### Trade outcomes reference

| `currentStatus` | Meaning | Always a win? |
|---|---|---|
| `ACTIVE` | Still open, being tracked | — |
| `TARGET_HIT` | Original or pivot-based target reached | Yes |
| `TRAIL_STOP_HIT` | A trailed stop (breakeven or profit-lock) was hit, not the original risk stop | Yes (scratch-or-better) |
| `STOPLOSS_HIT` | The original entry-time risk stop was hit — `trailStage` was still `NONE` | No |
| `TIME_EXIT` | Forced market exit after `STALE_EXIT_MINUTES` of stalled, decaying profit | Either — sign of `netCashINR` decides |

---

## Day Range & Support/Resistance

Computed each tick from the already-fetched multi-day candle history (grouped by IST
calendar date — no extra market-data fetch): today's running **High**/**Low**, plus
classic floor-trader pivot points from the *previous* session's high/low/close —
`Pivot = (H+L+C)/3`, `R1 = 2P−L`, `S1 = 2P−H`, `R2 = P+range`, `S2 = P−range`
([`computeDailyLevels()`](backend/src/indicators/indicators.service.ts)). These feed the
pivot-aware target logic above and render as a color-coded R2/R1/Pivot/S1/S2 ladder on the
dashboard's spot card, plus the day's point/percent change vs. the previous close.

## Market headlines (backend-only, not currently shown)

[`NewsService`](backend/src/news/news.service.ts) pulls the latest Nifty/Sensex/NSE
headlines from Google News' free public RSS search endpoint — no API key, cached 10
minutes, served at `GET /api/news/headlines`. It's purely informational and **never feeds
back into the strategy engine**. The dashboard's Market Headlines panel that used to
display this was removed by request; the endpoint and service are still live if you want
to re-surface it.

## Daily overtrading throttle

Before doing any indicator work, the 60s cron counts today's persisted signals. At
**`MAX_DAILY_SIGNALS`** (clamped to **[5, 10]** regardless of what's configured, default
10) it halts entirely — no more Yahoo Finance calls — until the next calendar day.

---

## 1. Backend — NestJS (`/backend`)

**Stack:** NestJS 10, Prisma 5 + PostgreSQL, `@nestjs/websockets` (socket.io),
`@nestjs/event-emitter`, `@nestjs/schedule` (`@Cron` + `@Interval`), `yahoo-finance2`
(no API key), `technicalindicators`, native `fetch` (Telegram Bot API), fully typed
TypeScript.

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
| `entrySpotPrice` | | fixed at creation, never changes |
| `stopLossSpot` | | **live** — ratcheted up by the trailing-stop rules |
| `targetSpot` | | **live** — may be pulled in once by the stale-exit rule |
| `atr14` | nullable | the ATR(14) reading these levels were originally sized from |
| `targetBasis` | nullable | `PIVOT` \| `ATR` — which basis the *original* `targetSpot` came from |
| `trailStage` | `NONE` \| `BREAKEVEN` \| `PROFIT_LOCK` | how far the trailing stop has progressed |
| `staleAdjusted` | boolean | whether the one-time stale-exit target reduction has fired |
| `currentStatus` | `ACTIVE` \| `TARGET_HIT` \| `TRAIL_STOP_HIT` \| `STOPLOSS_HIT` \| `TIME_EXIT` | |
| `resolvedAt`, `resolvedSpot` | nullable | set by the position monitor on exit |
| `netCashINR` | nullable | realized cash P&L (1 lot), signed by the actual move — see above |
| `peakSpot` | nullable | best-favorable price seen since entry, updated every 10s tick it improves |

Indexed on `dateString`, `currentStatus`, `direction`, `expiryType`, the
`[dateString, currentStatus]` composite (the hot "today's active positions" path), and
`timestamp` (archive sort/range).

> **Timezone note:** this dev box's Postgres session timezone is `Asia/Kolkata`. A plain
> (tz-naive) `timestamp` column would have silently stored IST wall-clock digits that
> then get *re-interpreted* as UTC on read, double-shifting every displayed time forward
> by 5:30 — caught live during development. Both time columns are `@db.Timestamptz(3)`,
> which stores an absolute instant immune to the session timezone, however the DB server
> is configured.

### Key files
- [src/signals/signals.service.ts](backend/src/signals/signals.service.ts) — the 60s cron: daily-throttle check, indicators, strategy, pivot-aware target sizing, minimum-profit filter, persists a new `TradeSignal` when the active-position guard allows it.
- [src/trades/trades.service.ts](backend/src/trades/trades.service.ts) — all TradeSignal reads/writes (throttle count, active-position check, create, resolve, live-field updates, today, filtered archive).
- [src/trades/position-monitor.service.ts](backend/src/trades/position-monitor.service.ts) — the **10s** `@Interval` ticker: exit check → trailing-stop ratchet → stale-exit rule → resolve, emitting an internal event and a notification on every change.
- [src/notifications/notifications.service.ts](backend/src/notifications/notifications.service.ts) — the Telegram hook (below); always logs, sends only when configured.
- [src/realtime/signals.gateway.ts](backend/src/realtime/signals.gateway.ts) — WebSocket gateway; re-broadcasts internal events as `signal-created` / `signal-status-changed` to every connected dashboard.
- [src/market-data/market-data.service.ts](backend/src/market-data/market-data.service.ts) — `yahoo-finance2` 5m candle fetch (strategy) + a lightweight live-quote fetch (position monitor), both try/catch wrapped.
- [src/expiry/expiry.service.ts](backend/src/expiry/expiry.service.ts) — CURRENT_WEEK / NEXT_WEEK day-of-week logic.
- [src/indicators/indicators.service.ts](backend/src/indicators/indicators.service.ts) — SMA(9)/RSI(14)/ATR(14), chart series, and daily pivot-level computation.

### REST endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/signals/latest` | Live spot/SMA/RSI/ATR snapshot, chart series, current strategy read, daily-throttle state — recomputed every 60s. |
| `GET /api/signals/today` | Every `TradeSignal` generated on the current IST date (append-only feed). |
| `GET /api/signals/archive?status=&direction=&expiryType=&dateFrom=&dateTo=&limit=&offset=` | Filtered, paginated historical signals — `{ items, total, limit, offset }`. `status` accepts any of the five outcomes above. |
| `GET /api/news/headlines` | Latest Nifty/Sensex/NSE headlines from Google News RSS, cached 10 min — informational only, not currently rendered by the frontend. |

### WebSocket

Connect to the backend's root namespace (e.g. `io('http://localhost:4000')`) and listen
for:

- **`signal-created`** — the instant a fresh signal is persisted: `{ signal }`.
- **`signal-status-changed`** — the instant a position resolves (any of the four terminal
  statuses):
  ```json
  {
    "signal": { "id": "...", "direction": "CALL", "strikePrice": 23650, "currentStatus": "TRAIL_STOP_HIT", "resolvedSpot": 23678.1, "trailStage": "PROFIT_LOCK", "...": "..." },
    "livePrice": 23678.1,
    "netCashINR": 1462
  }
  ```

### Telegram notifications (optional)

[`NotificationsService`](backend/src/notifications/notifications.service.ts) is the
trigger hook for outbound alerts, called by the position monitor on every trailing-stop
adjustment and every exit. It **always logs** the message server-side; when
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are both set, it additionally posts to that
chat via the Telegram Bot API (`sendMessage`). A delivery failure is caught and logged,
never allowed to break position monitoring. Leave both env vars blank to run with
logging-only notifications.

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

Live spot/SMA/RSI/day-change hero card, the candlestick+SMA/RSI chart, a **Today's
Stats** row (Today/Active/Target Hit/Trail Stop/Stop-Loss Hit/Time Exit/Win Rate — win
rate computed from realized `netCashINR` sign, not a hardcoded status list, so a
`TRAIL_STOP_HIT` correctly counts as a win), and an **Active Call** card showing only the
current `ACTIVE` position (not the day's full history — that lives on `/archive`), with:

- **Type** badge — `Intraday` vs `Delivery`, derived from whether the position's entry
  day (IST) still matches the resolution/current day (this bot has no forced end-of-day
  square-off, so a position that never hits target/stop-loss simply rolls over).
- **Current** column — live spot, colored by whether it's moved favorably from entry.
- **Live P&L** — client-side estimated unrealized P&L from the live spot price, using the
  same formula the backend applies at resolution.
- **Stop-Loss** cell — a shield icon + color once `trailStage` leaves `NONE` (amber for
  breakeven, emerald for profit-lock), so a trailed stop visually reads as "risk-free",
  not as a loss level.
- **Carry Advisory** banner — a heuristic, always-labeled "Suggestion" read on whether to
  square off or carry into the next session (see below).
- A [status badge](frontend/src/components/status-badge.tsx) per outcome: amber
  `animate-pulse` (`ACTIVE`), emerald (`TARGET_HIT`), sky (`TRAIL_STOP_HIT`), deep crimson
  (`STOPLOSS_HIT`), slate (`TIME_EXIT`).

### Carry-vs-square-off advisory

[`carryRecommendation()`](frontend/src/lib/trade-signal.ts) — only computed (and only
shown) inside the last hour before the 15:30 IST close, since earlier there's no real
carry decision to make yet:

| Condition | Suggestion |
|---|---|
| Market already closed, position still `ACTIVE` | **Carried to the next session** — informational, it already happened |
| Price closer to stop-loss than target, **or** spot/SMA(9)/RSI(14) no longer align with the trade direction | **Lean toward squaring off** — carrying would add gap risk to an already-weakening setup |
| Trend still aligned and price closer to target than stop-loss | **Reasonable to carry if it doesn't resolve today** |

Purely advisory — the app takes no action on its own, and every suggestion is shown with
the actual numbers behind it (points to target/stop-loss, minutes to close).

### Screen 2 — `/archive`

[ArchiveFiltersBar](frontend/src/components/archive-filters.tsx) — Shadcn-style Select
fields (Outcome — all five statuses / Direction / Expiry Window) plus native date-range
pickers — driving a paginated table over `GET /api/signals/archive`, including the same
Type/Duration/Net P&L columns as the dashboard (minus the live-price-dependent ones,
which show `—` since archive rows have no live feed).

### Chart module
[src/components/nifty-chart.tsx](frontend/src/components/nifty-chart.tsx) — a dual-panel
Recharts view: candlesticks (custom shape, drawn from a `[low, high]` range bar) with the
SMA(9) line overlaid and entry/target/stop-loss reference lines when a signal is active,
plus a separate RSI(14) sub-panel with dashed boundary lines at 35/45/55/65.

### Live updates & notifications

- [use-signal-polling.ts](frontend/src/hooks/use-signal-polling.ts) polls `/latest` every 30s for the live snapshot/chart, and requests `Notification.requestPermission()` on mount.
- [use-today-signals.ts](frontend/src/hooks/use-today-signals.ts) polls `/today` every 30s. A row with an `id` never seen before is a genuinely new signal event — it fires:
  - **Title:** `🚨 BOT SIGNAL DETECTED!`
  - **Body:** `BUY NIFTY [Strike] [CE/PE] ([CURRENT/NEXT] Expiry) | 1 Lot (65 units)` / `Max Risk: -₹[X] | Target: +₹[Y]` (both ATR-derived, varying per signal)
- Also fired **instantly** (no 30s poll wait) via [use-trade-socket.ts](frontend/src/hooks/use-trade-socket.ts)'s `signal-created` WebSocket listener — the poll is a resilience fallback only.
- [use-trade-socket.ts](frontend/src/hooks/use-trade-socket.ts) connects to the WebSocket gateway. On `signal-status-changed` it instantly upserts the row into the today table/stats, pushes an in-app **[exit toast](frontend/src/components/exit-toast.tsx)**, and fires the native exit notification — win/loss is decided by the **sign of the realized `netCashINR`**, not the status string, so a `TRAIL_STOP_HIT` correctly shows as a win:
  - `🎯 TARGET ACHIEVED!` / `🛡️ TRAILING STOP HIT` / `⚠️ STOP-LOSS TRIGGERED` / `⏱️ TIME-DECAY EXIT`
  - Plus a distinct synthesized win/loss audio chime ([lib/sound.ts](frontend/src/lib/sound.ts), pure Web Audio oscillators — no external sound assets) alongside the OS's own default notification ping.
- The signal active *when the dashboard is first opened* is treated as a baseline and doesn't re-fire a notification.

### Production build

```bash
npm run build
npm run start   # http://localhost:3000
```

---

## Environment variables (backend `.env`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | API port |
| `CORS_ORIGIN` | `http://localhost:3000` | comma-separated allowed origins (HTTP + WebSocket) |
| `DATABASE_URL` | — | Postgres connection string |
| `MAX_DAILY_SIGNALS` | `10` | clamped to `[5, 10]` regardless of value |
| `NIFTY_SYMBOL` | `^NSEI` | Yahoo Finance ticker |
| `STRIKE_STEP` | `50` | ATM-strike rounding increment |
| `LOT_SIZE` | `65` | contract units per lot |
| `DELTA_PROXY` | `0.5` | index-points → option-premium-points proxy |
| `ATR_TARGET_MULTIPLIER` | `2` | `atrTargetPoints = ATR(14) × this` |
| `ATR_STOPLOSS_MULTIPLIER` | `1` | `indexStopLossPoints = ATR(14) × this` |
| `MIN_TARGET_CASH_INR` | `1000` | minimum 1-lot target payoff to take a setup at all |
| `TRAIL_BREAKEVEN_ATR_MULT` | `1.0` | breakeven-shield trigger, × ATR(14) |
| `TRAIL_PROFIT_LOCK_ATR_MULT` | `1.5` | profit-lock trigger, × ATR(14) |
| `TRAIL_PROFIT_LOCK_FRACTION` | `0.75` | guaranteed-profit fraction of ATR(14) locked in |
| `STALE_EXIT_MINUTES` | `30` | age (minutes) before the stale-position rule engages |
| `STALE_TARGET_REDUCTION_PCT` | `0.30` | one-time target-distance pull-in when stale + in profit |
| `STALE_MIN_FAVORABLE_ATR_MULT` | `0.5` | giveback floor (× ATR) that forces a `TIME_EXIT` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | *(blank)* | optional — leave blank for logging-only notifications |

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
alerts (and Telegram alerts too, if configured).

## Notes & caveats

- The only non-npm dependency is a PostgreSQL server — no trading/broker API keys are needed, Yahoo Finance is queried anonymously via `yahoo-finance2`, and Telegram is optional.
- This bot **never places real orders** — it's a signal generator and paper-tracker. Every "exit" is the position monitor updating a database row, not a broker call.
- Entry-time exit sizing is volatility-based (`ATR_TARGET_MULTIPLIER` / `ATR_STOPLOSS_MULTIPLIER`, default 2:1), not a fixed point count. Post-entry, the trailing-stop and stale-exit rules keep adjusting `stopLossSpot`/`targetSpot` live — see [position-monitor.service.ts](backend/src/trades/position-monitor.service.ts).
- `MAX_DAILY_SIGNALS` is clamped to `[5, 10]` in code regardless of `.env` — a misconfiguration can't silently disable the overtrading guard.
- There is no forced end-of-day square-off — a position that never hits target/stop-loss/trailing-stop simply stays `ACTIVE` and rolls into the next session (the frontend's Intraday/Delivery tag and Carry Advisory reflect this reality rather than hiding it).
- NSE's weekly-expiry weekday (`EXPIRY_WEEKDAY` in `expiry.service.ts`, default Thursday) and market hours (`market-hours.util.ts`) are single named constants to update if the exchange revises them; Indian market holidays are not accounted for.
- This is an educational/demo signal engine, not investment advice — validate independently before trading on it.
