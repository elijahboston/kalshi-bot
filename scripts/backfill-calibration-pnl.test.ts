import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import { calibration } from "@kcb/db";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE calibration (
      id TEXT PRIMARY KEY NOT NULL,
      ticker TEXT NOT NULL,
      series_ticker TEXT NOT NULL,
      category TEXT NOT NULL,
      station_id TEXT,
      predicted_prob REAL NOT NULL,
      actual_outcome INTEGER NOT NULL,
      market_price REAL NOT NULL,
      edge REAL NOT NULL,
      realized_pnl REAL,
      traded INTEGER DEFAULT 0 NOT NULL,
      forecast_horizon INTEGER,
      resolved_at TEXT NOT NULL
    );
  `);
  return drizzle(sqlite, { schema: { calibration } });
}

function insertRow(
  db: ReturnType<typeof createTestDb>,
  overrides: { id: string; traded: boolean; realizedPnl: number | null },
) {
  return db.insert(calibration).values({
    id: overrides.id,
    ticker: `TICKER-${overrides.id}`,
    seriesTicker: "KXHIGHNY",
    category: "high_temp",
    predictedProb: 0.6,
    actualOutcome: 1,
    marketPrice: 0.5,
    edge: 0.1,
    realizedPnl: overrides.realizedPnl,
    traded: overrides.traded,
    forecastHorizon: null,
    resolvedAt: new Date().toISOString(),
  });
}

describe("backfill-calibration-pnl migration logic", () => {
  test("deletes only traded records with realizedPnl = 0", async () => {
    const db = createTestDb();

    // Stale: traded=true, pnl=0 (should be deleted)
    await insertRow(db, { id: "stale-1", traded: true, realizedPnl: 0 });
    await insertRow(db, { id: "stale-2", traded: true, realizedPnl: 0 });

    // Good: traded=true, pnl != 0 (should be kept)
    await insertRow(db, { id: "good-1", traded: true, realizedPnl: 150 });
    await insertRow(db, { id: "good-2", traded: true, realizedPnl: -50 });

    // Not traded: traded=false, pnl=0 (should be kept)
    await insertRow(db, { id: "untraded", traded: false, realizedPnl: 0 });

    // Null PnL: traded=true, pnl=null (should be kept — not the same bug)
    await insertRow(db, { id: "null-pnl", traded: true, realizedPnl: null });

    // Run the same DELETE query as the migration script
    await db
      .delete(calibration)
      .where(sql`${calibration.traded} = 1 AND ${calibration.realizedPnl} = 0`);

    const remaining = await db.select({ id: calibration.id }).from(calibration);
    const ids = remaining.map((r) => r.id).sort();

    expect(ids).toEqual(["good-1", "good-2", "null-pnl", "untraded"]);
  });

  test("no-op when no stale records exist", async () => {
    const db = createTestDb();

    await insertRow(db, { id: "ok-1", traded: true, realizedPnl: 200 });
    await insertRow(db, { id: "ok-2", traded: false, realizedPnl: 0 });

    await db
      .delete(calibration)
      .where(sql`${calibration.traded} = 1 AND ${calibration.realizedPnl} = 0`);

    const remaining = await db.select({ id: calibration.id }).from(calibration);
    expect(remaining.length).toBe(2);
  });
});
