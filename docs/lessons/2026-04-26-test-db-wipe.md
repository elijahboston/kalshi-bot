# Production DB Wipe Incident (2026-04-26)

**Date of incident:** 2026-04-26
**Authors:** Elijah Boston
**Status:** Closed

## TL;DR

The 6:03 AM log-review LaunchAgent ran `bun test` against the production SQLite DB on 2026-04-26 and silently wiped most trading state, including the historical calibration data that the Apr 22 historical-prior blend depended on. Root cause was test files calling `runMigrations()` with no path (defaults to `./data/kalshi-bot.db`) followed by `db.delete(table).run()` cleanup hooks. Fixed by `bunfig.toml` test preload that forces `DB_PATH=:memory:` for all test runs.

## Timeline

| Time (local) | Event |
|---|---|
| 2026-04-24 ~14:00 | Paper-trading feature shipped (commit 680a6d2) — added `dry_run` columns, API filters, web UI banner; included new `db.delete(...)` cleanup hooks in `routes.test.ts`. |
| 2026-04-24 ~12:00 | User seeded `runtime_config.dry_run=true` and a `balance_history` row at $500. Bot restarted, paper run began. |
| 2026-04-26 06:03 | LaunchAgent `com.climatebot.log-review` fired (cron). |
| 2026-04-26 ~06:25 | Agent ran `bun test` per its prompt step 3 ("Run `bun test` to verify all tests pass"). Tests called `runMigrations()` → defaults to `./data/kalshi-bot.db`. `beforeEach` hooks ran `db.delete(signals \| orders \| balance_history \| calibration).run()` against production. |
| 2026-04-26 06:30:37 | Agent committed `0cff812` (unrelated WebSocket fix) and tried to push (failed: SSH agent had no key). |
| 2026-04-26 07:35 | Bot's first post-wipe tick wrote new `signals` and `balance_history` rows on the empty DB. |
| 2026-04-26 ~15:55 | User noticed dashboard win rate stuck at 0.0% and balance unchanged — symptoms of the wipe. |
| 2026-04-26 ~16:00 | Investigation, cause confirmed, fix applied (`bunfig.toml` + `test-setup.ts` preload). |

## Root cause

`packages/db/src/client.ts:10` uses this path resolution:

```ts
const path = dbPath || process.env.DB_PATH || "./data/kalshi-bot.db";
```

Test files call `runMigrations()` with no argument. When tests run from the repo root (e.g. via `bun test`), `process.env.DB_PATH` is unset and `./data/kalshi-bot.db` is the production file.

Several test files then perform table-clearing cleanup in `beforeEach` hooks. The new `dryRun query filter` describe block in `routes.test.ts` was the most aggressive (cleared 4 tables) but other files (`ensemble.test.ts`, `backtest.test.ts`) had similar patterns affecting `weather_forecasts` — which is why `weather_forecasts` was already chronically empty before this incident (see [post-sharpening-regression.md](post-sharpening-regression.md), the "external wipes" we'd been blaming on DB recreations were tests all along).

## Impact

| Table | Before | After | Recoverable? |
|---|---|---|---|
| `signals` | ~679,746 | 3,024 (post-wipe activity only) | No — reasoning traces cannot be reconstructed |
| `calibration` | 459 | 2 (test fixture leakage from 2026-04-20) | No — requires (predicted_prob, actual_outcome) pairs that depended on signals |
| `balance_history` | many months | post-wipe only | No — Kalshi has no portfolio history endpoint we use |
| `orders` | many months | post-wipe only | **Yes** — `syncHistoricalOrders` re-fetches from Kalshi |
| `trades` | many months | post-wipe only | **Yes** — derived from orders via fills |
| `weather_forecasts` | already chronically wiped | 24 rows | Partial — going forward, `actual_value` backfill on resolution synthesizes new rows |
| `station_bias` | 0 | 0 | No, but rebuilds from `weather_forecasts` |

**Strategic impact**: the Apr 22 historical-prior blend (`historical_prior_weight=0.3`) relies on `getHistoricalHitRate` which needs ≥5 same-station/category resolutions in a 30-day window. With calibration wiped, the blend returns `null` for every bracket and the estimator silently falls back to its pre-Apr-22 behavior. Per the [post-sharpening regression analysis](post-sharpening-regression.md), that's the configuration that lost -$352.73 on the `pred<10%` bucket.

The Apr 23 retention-resilient backfill (`synthesizeForecastFromSignal`) still helps: every paper market that resolves now seeds `weather_forecasts` + `station_bias` from the signal trace, so empirical sigma activates as soon as a single station hits 10 resolutions per horizon.

The 2-day paper run (Apr 24 → Apr 26) is also gone. Paper-run clock effectively restarts.

## Fix

Two new files at the repo root:

`bunfig.toml`:
```toml
[test]
preload = ["./test-setup.ts"]
```

`test-setup.ts`:
```ts
process.env.DB_PATH = ":memory:";
```

The preload runs before any test imports `@kcb/db`, so the `getDb()` singleton is initialized with an in-memory database. All 391 tests pass with the new isolation. Verified: a full `bun test` run after the fix did not modify the production DB (signals went from 3024 to 3120 from continued bot operation; no decrement).

Shipped in commit 8370471.

## Recommended additional hardening

**Not yet done — needs user approval**:

1. **Disable or rewrite the log-review LaunchAgent prompt.** Step 3 still instructs "Run `bun test` to verify all tests pass". With the `bunfig.toml` preload that's safe, but a defense-in-depth check should be added:
   ```
   Before running `bun test`, verify that `bunfig.toml` exists at the repo root and contains a `[test]` section with a `preload` entry. If not, ABORT and report the missing safety guard. Never run tests against the production DB.
   ```
   Until updated, suggest disabling: `launchctl unload ~/Library/LaunchAgents/com.climatebot.log-review.plist`.

2. **Make `runMigrations()` refuse the production DB by default** when invoked from a test context. Could require an explicit `DB_PATH` env or pass `:memory:` explicitly. This is belt-and-suspenders on top of the preload, but would make individual test files safe to run in isolation (e.g. `bun test app/engine/...`) without depending on the global config.

3. **Snapshot backups**. The DB is 528MB and not backed up anywhere. A periodic `cp data/kalshi-bot.db data/kalshi-bot.db.daily.bak` (rotated weekly) would have made this incident a 24-hour data-loss instead of a multi-month one.

## Post-mortem follow-ups

- Re-evaluate the historical-prior blend's effectiveness after the paper run rebuilds calibration. The original 5-day window resets to 2026-05-01 at the earliest.
- The "weather_forecasts external wipes" theory in [post-sharpening-regression.md](post-sharpening-regression.md) was correct — they were tests. Update that doc when the post-mortem is read.
