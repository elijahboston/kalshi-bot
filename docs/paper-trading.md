# Paper Trading Procedure

Context: the [post-sharpening regression diagnostic](improvements/post-sharpening-regression.md) set a ramp-up gate that requires validating the Apr 22 historical-prior-blend fix before depositing more real money. We validate by running the bot in **dry-run mode against a simulated bankroll** for ≥5 days, then flipping back to live only if the prediction-bucket analysis passes.

## Architecture

Same `data/kalshi-bot.db`, with mode-tagging on trading tables:
- `orders.dry_run` — already existed.
- `balance_history.dry_run`, `signals.dry_run` — added in migration `0003_add_dry_run_flags.sql`.
- `calibration` has no `dry_run` column; paper vs. live calibration is determined by joining `orders` on ticker.

Analytical tables (`calibration`, `weather_forecasts`, `station_bias`) accumulate continuously across paper and live phases — they reflect real market outcomes and real weather, not bot execution mode.

Web UI automatically scopes dashboard/calibration/performance views to the bot's current mode via the `?dryRun=true|false` query param threaded through API endpoints. A persistent amber banner appears on every page while the bot is in paper mode.

## Starting a paper run

1. Stop the currently-running bot. (Ctrl-C in the TUI, or kill the `bun --watch app/cli/src/index.tsx` process.)
2. Apply migrations if not already applied:
   ```bash
   bun run db:migrate
   ```
3. Flip runtime config to dry-run. Either via the web UI's **Settings → Trading Parameters → Dry Run** toggle, or via SQL:
   ```bash
   sqlite3 data/kalshi-bot.db \
     "INSERT OR REPLACE INTO runtime_config (key, value, updated_at) \
      VALUES ('dry_run', 'true', datetime('now'));"
   ```
4. Seed the paper bankroll. This gives the bot a simulated $500 to work with:
   ```bash
   sqlite3 data/kalshi-bot.db \
     "INSERT INTO balance_history (id, balance, total_equity, open_positions, realized_pnl, recorded_at, dry_run) \
      VALUES (lower(hex(randomblob(16))), 50000, 50000, 0, 0, datetime('now'), 1);"
   ```
5. Start the bot:
   ```bash
   bun run bot:watch
   ```
6. Verify: the web UI should show the amber "PAPER TRADING MODE" banner on every page, and dashboard stats should reflect paper data only.

## Daily monitoring

Each day of the paper run, spot-check:

- **All new orders are paper**: `sqlite3 data/kalshi-bot.db "SELECT COUNT(*), COUNT(CASE WHEN dry_run=1 THEN 1 END) FROM orders WHERE created_at >= date('now','-1 day');"` — both numbers should match.
- **Signal traces include the historical-prior blend**: `sqlite3 data/kalshi-bot.db "SELECT reasoning FROM signals WHERE created_at >= date('now','-1 day') LIMIT 1;" | grep historicalPriorBlend` — should find a match.
- **`station_bias` row count growing**: `sqlite3 data/kalshi-bot.db "SELECT COUNT(*) FROM station_bias;"` — expected to be >0 within 2 days, validating the Apr 23 backfill fix is firing.
- **Paper equity curve updates**: dashboard should show recent paper trades as the curve advances.

## Gate decision at the 5-day mark

Re-run the prediction-bucket analysis from the regression doc, restricted to calibration rows whose orders were dry-run:

```sql
SELECT
  CASE
    WHEN predicted_prob < 0.10 THEN '<10%'
    WHEN predicted_prob < 0.25 THEN '10-25%'
    WHEN predicted_prob < 0.50 THEN '25-50%'
    ELSE '>50%'
  END AS bucket,
  COUNT(*) AS n,
  AVG(actual_outcome) AS actual_yes_rate,
  AVG(predicted_prob) AS avg_predicted,
  SUM(realized_pnl) / 100.0 AS total_pnl_dollars
FROM calibration c
WHERE c.traded = 1
  AND EXISTS (
    SELECT 1 FROM orders o
    WHERE o.ticker = c.ticker AND o.signal_id IS NOT NULL AND o.dry_run = 1
  )
GROUP BY bucket
ORDER BY
  CASE bucket
    WHEN '<10%' THEN 1
    WHEN '10-25%' THEN 2
    WHEN '25-50%' THEN 3
    ELSE 4
  END;
```

**Pass criteria** (either is sufficient):
- The `<10%` bucket's `actual_yes_rate` drops below 20% (vs. 33.8% in the pre-fix cohort), OR
- The `<10%` bucket's `avg_predicted` rises above 10%.

## Going live

If the gate passes:

1. Stop the bot.
2. Flip back to live via the UI Settings toggle, or SQL:
   ```bash
   sqlite3 data/kalshi-bot.db \
     "UPDATE runtime_config SET value='false', updated_at=datetime('now') WHERE key='dry_run';"
   ```
3. Deposit $100 via Kalshi.
4. Restart the bot. `syncPositionsFromKalshi` picks up the real balance; `snapshotBalance`'s live branch reads Kalshi directly, so paper `balance_history` rows are effectively ignored for live operations. The amber banner disappears and the UI auto-scopes to live data.

## Rollback

If the gate fails (`<10%` bucket still hits YES ≥20%):

1. Do NOT deposit.
2. Flip `dry_run` back to `false`, restart bot at the current $69 live portfolio.
3. Paper rows stay filterable-out by `dry_run=1`, so live reports remain clean.
4. Return to the deferred-items queue in the regression doc (retention root-cause, sigma multiplier, per-category calibration).
