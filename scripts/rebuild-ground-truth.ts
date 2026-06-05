/**
 * One-time ground-truth rebuild (win-rate-80-addendum-2026-06-05.md N1 step 5).
 *
 * Finding 1: `weather_forecasts.actual_value` was backfilled as the max of
 * hourly NWS observations over a UTC day window. It lands inside the
 * Kalshi-settled YES bracket only ~30% of the time (KNYC −1.07°F, KORD +0.78°F
 * off), and `recomputeStationBias` trained `mean_bias`/`std_bias` on those
 * corrupted actuals — mis-anchoring the estimator by ~1°F at the worst stations
 * and generating the contra-market book that loses ~80% of its bets.
 *
 * Kalshi settlement is the authoritative truth. This script:
 *   1. Recomputes actual_value from the settled YES bracket (actual_source =
 *      'settlement') for every forecast row that has a settled YES market on its
 *      (station_id, target_date) with a matching forecast_type → category.
 *   2. Wipes station_bias.
 *   3. Re-runs the bias recomputation from the repaired actuals.
 *   4. Prints before/after "pct actuals inside YES bracket" and the new
 *      station_bias table.
 *
 * Usage:
 *   bun scripts/rebuild-ground-truth.ts [--db ./data/kalshi-bot.db] [--dry-run]
 *
 * The main thread runs this against the real DB — do NOT auto-run it.
 */

import {
  getDb,
  markets,
  weatherForecasts,
  stationBias,
  eq,
  and,
  sql,
} from "@kcb/db";
import { KalshiClient } from "@kcb/kalshi-client";
import { ReconciliationService } from "../app/engine/services/reconciliation";

// ── arg parsing ────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const dbIdx = argv.indexOf("--db");
const dbPath = dbIdx >= 0 ? argv[dbIdx + 1] : undefined;

// getDb caches the first instance — pass the override path here so every
// downstream @kcb/db consumer (including ReconciliationService) shares it.
const db = getDb(dbPath);

console.log(
  `[rebuild-ground-truth] db=${dbPath ?? process.env.DB_PATH ?? "./data/kalshi-bot.db"}${dryRun ? "  (DRY RUN)" : ""}`,
);

// ── settlement derivation (mirrors ReconciliationService.deriveSettlementActual) ──
// Kept inline so the script is self-contained and prints the per-row arithmetic.
function settlementActual(m: {
  marketType: string;
  bracketLow: number | null;
  bracketHigh: number | null;
}): number | null {
  if (m.bracketLow == null) return null;
  if (m.marketType === "upper_tail") return m.bracketLow + 0.5;
  if (m.marketType === "lower_tail") return m.bracketLow - 0.5;
  if (m.bracketHigh == null) return null;
  return (m.bracketLow + m.bracketHigh) / 2;
}

/** Bracket center for the inside-bracket offset metric (bracket markets only). */
function bracketCenter(m: { bracketLow: number | null; bracketHigh: number | null }): number | null {
  if (m.bracketLow == null || m.bracketHigh == null) return null;
  return (m.bracketLow + m.bracketHigh) / 2;
}

// ── metric: pct of forecast rows whose actual lands inside the settled YES bracket ──
async function pctInsideYesBracket(): Promise<{
  pct: number;
  n: number;
  perStation: Map<string, { inside: number; total: number; offsetSum: number }>;
}> {
  const rows = await db
    .select({
      stationId: markets.stationId,
      bracketLow: markets.bracketLow,
      bracketHigh: markets.bracketHigh,
      actualValue: weatherForecasts.actualValue,
    })
    .from(markets)
    .innerJoin(
      weatherForecasts,
      and(
        eq(weatherForecasts.stationId, markets.stationId),
        eq(weatherForecasts.targetDate, markets.targetDate),
      ),
    )
    .where(
      and(
        eq(markets.result, "yes"),
        eq(markets.marketType, "bracket"),
        sql`${weatherForecasts.actualValue} IS NOT NULL`,
        sql`${markets.bracketLow} IS NOT NULL`,
        sql`${markets.bracketHigh} IS NOT NULL`,
      ),
    );

  const perStation = new Map<string, { inside: number; total: number; offsetSum: number }>();
  let inside = 0;
  for (const r of rows) {
    const st = r.stationId ?? "unknown";
    const center = bracketCenter(r)!;
    const within = r.actualValue! >= r.bracketLow! && r.actualValue! < r.bracketHigh!;
    const s = perStation.get(st) ?? { inside: 0, total: 0, offsetSum: 0 };
    s.total += 1;
    s.offsetSum += r.actualValue! - center; // signed: + = recorded too hot
    if (within) {
      s.inside += 1;
      inside += 1;
    }
    perStation.set(st, s);
  }

  return {
    pct: rows.length > 0 ? (inside / rows.length) * 100 : 0,
    n: rows.length,
    perStation,
  };
}

function printPerStation(
  label: string,
  perStation: Map<string, { inside: number; total: number; offsetSum: number }>,
) {
  console.log(`  ${label}:`);
  const stations = [...perStation.keys()].sort();
  for (const st of stations) {
    const s = perStation.get(st)!;
    const pct = ((s.inside / s.total) * 100).toFixed(0);
    const avgOff = (s.offsetSum / s.total).toFixed(2);
    console.log(
      `    ${st.padEnd(6)} ${pct.padStart(3)}% inside (${s.inside}/${s.total})  avg offset vs center ${avgOff.padStart(6)}°F`,
    );
  }
}

// ── 1. recompute actual_value from settlement ──────────────────
async function repairActuals(): Promise<{ updated: number; stations: Set<string> }> {
  // Every forecast row that has a settled YES market on the same station+date
  // with a matching category. forecast_type (weather) == category (market).
  const candidates = await db
    .select({
      forecastId: weatherForecasts.id,
      stationId: weatherForecasts.stationId,
      targetDate: weatherForecasts.targetDate,
      currentActual: weatherForecasts.actualValue,
      marketType: markets.marketType,
      bracketLow: markets.bracketLow,
      bracketHigh: markets.bracketHigh,
    })
    .from(weatherForecasts)
    .innerJoin(
      markets,
      and(
        eq(markets.stationId, weatherForecasts.stationId),
        eq(markets.targetDate, weatherForecasts.targetDate),
        eq(markets.category, weatherForecasts.forecastType),
        eq(markets.result, "yes"),
      ),
    );

  const stations = new Set<string>();
  let updated = 0;
  for (const c of candidates) {
    const derived = settlementActual(c);
    if (derived == null) continue;
    stations.add(c.stationId);
    if (!dryRun) {
      await db
        .update(weatherForecasts)
        .set({ actualValue: derived, actualSource: "settlement" })
        .where(eq(weatherForecasts.id, c.forecastId));
    }
    updated += 1;
  }

  return { updated, stations };
}

// ── run ────────────────────────────────────────────────────────
const before = await pctInsideYesBracket();
console.log(
  `\nBEFORE: ${before.pct.toFixed(1)}% of forecast rows inside settled YES bracket (n=${before.n})`,
);
printPerStation("per-station (before)", before.perStation);

const { updated, stations } = await repairActuals();
console.log(
  `\n${dryRun ? "[dry-run] would update" : "Updated"} actual_value on ${updated} forecast row(s) from settlement` +
    ` across ${stations.size} station(s).`,
);

if (dryRun) {
  console.log(
    "\n[dry-run] Would then: DELETE FROM station_bias, recompute bias from repaired actuals.",
  );
  // Show what the metric WOULD become by recomputing in-memory from settlement,
  // without writing. Re-derive inside-bracket using the would-be settlement value.
  const wouldRows = await db
    .select({
      stationId: markets.stationId,
      bracketLow: markets.bracketLow,
      bracketHigh: markets.bracketHigh,
      marketType: markets.marketType,
    })
    .from(markets)
    .innerJoin(
      weatherForecasts,
      and(
        eq(weatherForecasts.stationId, markets.stationId),
        eq(weatherForecasts.targetDate, markets.targetDate),
      ),
    )
    .where(
      and(
        eq(markets.result, "yes"),
        eq(markets.marketType, "bracket"),
        sql`${markets.bracketLow} IS NOT NULL`,
        sql`${markets.bracketHigh} IS NOT NULL`,
      ),
    );
  let wouldInside = 0;
  for (const r of wouldRows) {
    const v = settlementActual(r);
    if (v != null && v >= r.bracketLow! && v < r.bracketHigh!) wouldInside += 1;
  }
  const wouldPct = wouldRows.length > 0 ? (wouldInside / wouldRows.length) * 100 : 0;
  console.log(
    `[dry-run] Projected pct inside after settlement repair: ${wouldPct.toFixed(1)}% (n=${wouldRows.length})`,
  );
  console.log("\n[dry-run] No changes written. Run without --dry-run to apply.");
  process.exit(0);
}

// ── 2. wipe station_bias ───────────────────────────────────────
const biasBefore = await db.select().from(stationBias);
await db.delete(stationBias);
console.log(`\nDeleted ${biasBefore.length} station_bias row(s).`);

// ── 3. re-run bias recomputation from repaired actuals ─────────
// ReconciliationService.recomputeStationBias is DB-only (no network); construct
// with a bare KalshiClient (never calling its network methods) per N1 step 5.
const svc = new ReconciliationService(new KalshiClient());
for (const stationId of stations) {
  await svc.recomputeStationBias(stationId);
}
console.log(`Recomputed station_bias for ${stations.size} station(s).`);

// ── 4. print new station_bias + after metric ───────────────────
const biasAfter = await db
  .select()
  .from(stationBias)
  .orderBy(stationBias.stationId, stationBias.category, stationBias.forecastHorizonDays);

console.log("\nNew station_bias table:");
console.log(
  `  ${"station".padEnd(8)}${"category".padEnd(12)}${"h".padStart(2)}  ${"meanBias".padStart(9)} ${"stdBias".padStart(8)} ${"n".padStart(4)}`,
);
for (const b of biasAfter) {
  console.log(
    `  ${b.stationId.padEnd(8)}${b.category.padEnd(12)}${String(b.forecastHorizonDays).padStart(2)}  ` +
      `${b.meanBias.toFixed(3).padStart(9)} ${b.stdBias.toFixed(3).padStart(8)} ${String(b.sampleSize).padStart(4)}`,
  );
}

const after = await pctInsideYesBracket();
console.log(
  `\nAFTER: ${after.pct.toFixed(1)}% of forecast rows inside settled YES bracket (n=${after.n})`,
);
printPerStation("per-station (after)", after.perStation);

console.log(
  `\nDone. pct inside YES bracket: ${before.pct.toFixed(1)}% → ${after.pct.toFixed(1)}%.`,
);
