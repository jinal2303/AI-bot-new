# How a CALL/PUT signal gets picked and managed

This documents the actual logic in `signals.service.ts` (entry) and
`position-monitor.service.ts` (exit/trade management), with the current live
`.env` values as of 2026-09-17 (last major revision: added the market-regime
gate, the total/consecutive daily-loss circuit breakers, the global loss
cooldown, and the 8-minute stale-position soft exit). It is a description of
what the code does today, not a specification — if you change a `.env`
value, this doc goes stale for that value; re-check the source file cited
next to each rule.

## 1. Entry pipeline (`SignalsService.refreshSignal()`, runs every 60s)

A signal must clear **every** gate below, in order, to actually open a
position. Any gate failing downgrades the read to `NO_SIGNAL` for that tick —
nothing is queued or retried, the next 60s tick starts over from scratch.

| # | Gate | Rule | Current value |
|---|------|------|----------------|
| 1 | Daily halt | Daily signal count / stop-loss / total-loss / consecutive-loss circuit breakers | **disabled** (`ENABLE_DAILY_LIMIT=false`) — counts still shown on dashboard, never halts. When enabled, trips on ANY of: signal count ≥10, STOPLOSS_HIT count ≥4, total losing trades ≥3 (`MAX_DAILY_LOSSES`), or a consecutive STOPLOSS_HIT streak ≥2 (`MAX_CONSECUTIVE_LOSSES`) |
| 2 | Directional read | `spot` vs `SMA9` trend + RSI(14) band agreement | CALL: spot>SMA9 & RSI∈[52,85]. PUT: spot<SMA9 & RSI∈[15,48]. Dead zone RSI 48-52 = no read |
| 3 | ATR expansion | ATR14 must be expanding OR already high | ratio ≥ **1.05** OR ATR14 ≥ **18** pts (raised from 12 on 2026-09-18 — ATR's been running 15-21pts lately, so 12 was almost always cleared regardless of real expansion) |
| 4 | Market regime / chop filter (added 2026-09-17, tightened to AND 2026-09-18) | Must show real trend strength AND low chop — not either alone | ADX(14) ≥ **20** (`ADX_THRESHOLD`) **AND** Choppiness Index(14) ≤ **60** (`CHOPPINESS_INDEX_MAX`). Was OR — a real trade slipped through on adx14=12.4 (failed) alone passing via chop14=58.8, barely under 60; it peaked only 1.5pts favorable before reversing. Each side still fails open (passes) on insufficient history. A volume-based gate was considered and skipped — see the caveat below the table |
| 5 | Structural reaction | Must breakout/breakdown, or bounce/reject, off a real level | Requires **PIVOT/FALLBACK-only** confirmation in **every** session window (daily pivot, session VWAP, or morning high/low — not a plain intraday swing) — tightened 2026-09-16, previously Mid-Day only |
| 5b | ↳ Sustained-trend bypass | If #5 fails: ≥3 consecutive trend-agreement 5m bars AND ATR14 ≥ 15 still passes | `SUSTAINED_TREND_MIN_BARS=3`, `SUSTAINED_TREND_ATR_BASELINE=15` |
| 6 | Min-profit filter | Projected target payoff (1 lot) must clear a floor | `max(₹650, ATR14 × 0.5 × 65 × 0.5)` → **₹650 floor = 10 CE/PE option points minimum target** |
| 7 | Global loss cooldown (refactored 2026-09-17) | ANY loss (negative netCashINR, any status/direction) blocks new entries in BOTH directions | **15 min** (`REENTRY_COOLDOWN_MINUTES`) — a WIN no longer triggers any cooldown; a loss now blocks both CALL and PUT, not just same-direction re-entry |
| 8 | Same-strike loss blacklist | Exact strike+direction blocked after a `STOPLOSS_HIT` | **45 min** (`STRIKE_BLACKLIST_MINUTES`) — only stop-loss losses blacklist, not target/trail/time exits |
| 9 | Session window cap | Max new entries per named window | Morning **4** / Mid-Day **2** / Afternoon **4** (09:15-**14:30** IST only — cut off early per desk request 2026-09-17, was 15:15. No new trades for the rest of the day past 14:30; existing open positions still tracked/exited normally, including the 15:15 EOD square-off) |
| 10 | One position at a time | No new entry while a position is `ACTIVE` | hard rule, not configurable |

**Why there's no volume filter**: Yahoo Finance reports `volume: 0` for
every candle on the `^NSEI` index (confirmed live 2026-09-17) — indices
have no traded volume of their own, only their constituent stocks do. A
"current volume ≥ 1.5× its 20-period SMA" gate would therefore always
compare 0 against 0, making it a permanent silent no-op rather than a real
filter — so it was deliberately left out instead of shipped as dead code
that looks like protection but isn't.

**Target/stop-loss sizing** (`buildTradeRules()`, `signals.service.ts:823`):
- `stopLossPoints = ATR14 × 1` (`ATR_STOPLOSS_MULTIPLIER=1`)
- `targetPoints = ATR14 × 2` (`ATR_TARGET_MULTIPLIER=2`), **unless** a structural
  level sits ≥ `2× ATR14` away in the favorable direction (`STRUCTURE_MIN_TARGET_ATR_MULT=2`)
  — then the target snaps to that level instead (`targetBasis: 'PIVOT'`).

This means every trade enters with a **2:1 reward:risk ratio at best**
(sometimes wider if pivot-snapped). Under a no-edge random-walk assumption,
2:1 R:R implies roughly a **33% win rate** is "expected" — the strategy is
designed around fewer, bigger wins rather than a high hit rate.

## 2. Exit / trade-management pipeline (`PositionMonitorService`, runs every 10s)

Checked in this order for every ACTIVE position, each step short-circuits
the rest once it resolves the trade:

1. **Target/stop-loss hit** — plain boundary check against the *current*
   (possibly already-trailed) `targetSpot`/`stopLossSpot`.
2. **Target-progress milestones** — notification-only, 30/40/.../90% of the
   original target distance. Never triggers an exit.
3. **Mandatory EOD square-off** — forced exit 15 min before close (15:15 IST), unconditional.
3.5. **Stale-position SOFT exit** (added 2026-09-17, extended 2026-09-18) —
   two independent conditions, either force-exits (`TIME_EXIT`):
   - **No-momentum deadline**: position open ≥ **8 min**
     (`STALE_POSITION_MINUTES`) with peak favorable move still **under 0.3×
     ATR** (`STALE_POSITION_MIN_FAVORABLE_ATR_MULT`). 0.3× is intentionally
     below the 0.4× trailing-breakeven trigger, so this never fires for a
     trade that got close to arming real protection.
   - **Early adverse drift** (fixes a gap in the deadline check above —
     that one only looks ONCE, at 8 minutes, so a trade that stalls early
     and then quietly drifts against you rides the whole adverse move
     before anything reacts): checked continuously during the same
     8-minute proving window — if CURRENT unfavorable movement reaches
     **0.3× ATR** (`STALE_POSITION_ADVERSE_ATR_MULT`) against the trade,
     exit immediately rather than waiting for the deadline. Real example
     that motivated this: a trade lost ₹351 in 8m5s despite peaking at
     only +1.5pts favorable — price had already drifted ~11pts unfavorable
     by the time the old deadline-only check fired.

   See `evaluateStalePositionSoftExit()`.
4. **Trailing stop (Dynamic Profit Protection)** — see table below. Only
   ever tightens the stop, never loosens it.
5. **Target revision / peak-giveback exit** — if peak favorable move reached
   50-70% of the original target (scaled by payoff size) or 30 pts flat,
   AND price has since given back ≥ 0.5× ATR from that peak → lock in
   what's left and exit now (`TRAIL_STOP_HIT`).
6. **Stale-position handling** (the original, 30-minute rule) — after 30 min
   open: pull target in 30% once (if still in profit), and force-exit if
   favorable move has slipped below 0.5× ATR. Distinct from 3.5 above: this
   one only fires for a position that WAS in profit and gave it back; 3.5
   fires much earlier, for a position that never got going at all.

### Trailing-stop stages (`applyTrailingStop()`, `position-monitor.service.ts:322`)

| Stage | Trigger (off **peak**, not current price) | New stop level |
|---|---|---|
| Breakeven | peak favorable move ≥ **1.0× ATR** | stop → entry (flat ₹0) |
| Min-lock floor | peak ≥ **1.3× ATR** OR ≥ **20 pts** flat | stop → entry ± 0.5× ATR guaranteed profit |
| Profit lock | peak ≥ **1.5× ATR** | stop → entry ± 0.75× ATR guaranteed profit |

**This is the mechanism behind most of your realized losses.** A position
that peaks at, say, 0.6-0.9× ATR favorable (a real, meaningful move) but
never reaches the full 1.0× ATR breakeven trigger gets **zero protection**
— if it reverses, it rides all the way back down to the original
un-trailed stop-loss and books a full loss, even though it was genuinely
in profit moments earlier.

## 3. Reading "Peak Pts (CE/PE)" in the Signal Archive

This column is `peak favorable index-point move × deltaProxy (0.5)` — it's
a **realized market outcome**, not a setting. It reflects how far price
actually traveled in your favor before the trade resolved. No entry filter
can *guarantee* a minimum realized peak, because that requires knowing the
future; entry filters (section 1) can only raise the odds of picking
setups likely to run further. What trade-*management* logic (section 2) can
do is make sure a real partial move that already happened doesn't fully
give itself back into a loss — that's the trailing-stop timing question,
addressed below.
