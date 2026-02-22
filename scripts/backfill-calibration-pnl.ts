/**
 * One-off migration: delete calibration records with realizedPnl = 0
 * that were inserted by syncSettlements before the PnL computation fix.
 *
 * The next reconciliation cycle will re-import them from Kalshi with
 * correctly computed PnL (revenue - yes_total_cost - no_total_cost).
 *
 * Usage: bun scripts/backfill-calibration-pnl.ts [--dry-run]
 */

import { getDb, calibration, sql } from "@kcb/db";

const dryRun = process.argv.includes("--dry-run");

const db = getDb();

// Find calibration records that were affected:
// traded = 1 (came from syncSettlements) AND realizedPnl = 0
const staleRecords = await db
  .select({
    id: calibration.id,
    ticker: calibration.ticker,
    actualOutcome: calibration.actualOutcome,
    resolvedAt: calibration.resolvedAt,
  })
  .from(calibration)
  .where(sql`${calibration.traded} = 1 AND ${calibration.realizedPnl} = 0`);

if (staleRecords.length === 0) {
  console.log("No stale calibration records found. Nothing to do.");
  process.exit(0);
}

console.log(`Found ${staleRecords.length} calibration record(s) with traded=1 and realizedPnl=0:\n`);

for (const r of staleRecords) {
  const outcome = r.actualOutcome === 1 ? "YES" : "NO";
  console.log(`  ${r.ticker}  resolved=${outcome}  at=${r.resolvedAt}`);
}

if (dryRun) {
  console.log("\n[dry-run] Would delete these records. Run without --dry-run to apply.");
  process.exit(0);
}

console.log("\nDeleting stale records...");

const deleted = await db
  .delete(calibration)
  .where(sql`${calibration.traded} = 1 AND ${calibration.realizedPnl} = 0`);

console.log(`Deleted ${staleRecords.length} record(s).`);
console.log("Run the bot or trigger reconciliation to re-import with correct PnL.");
