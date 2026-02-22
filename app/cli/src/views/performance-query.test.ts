import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql, count, avg, sum } from "drizzle-orm";
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

function insertCalibration(
  db: ReturnType<typeof createTestDb>,
  overrides: Partial<{
    id: string;
    ticker: string;
    realizedPnl: number | null;
    traded: boolean;
    actualOutcome: number;
    predictedProb: number;
    marketPrice: number;
  }> = {},
) {
  const id = overrides.id ?? crypto.randomUUID();
  return db.insert(calibration).values({
    id,
    ticker: overrides.ticker ?? `TICKER-${id.slice(0, 6)}`,
    seriesTicker: "KXHIGHNY",
    category: "high_temp",
    predictedProb: overrides.predictedProb ?? 0.6,
    actualOutcome: overrides.actualOutcome ?? 1,
    marketPrice: overrides.marketPrice ?? 0.5,
    edge: 0.1,
    realizedPnl: overrides.realizedPnl ?? null,
    traded: overrides.traded ?? false,
    forecastHorizon: null,
    resolvedAt: new Date().toISOString(),
  });
}

/**
 * This is the EXACT query from performance.tsx (the current code).
 * We test it to see if count(sql`CASE WHEN ... THEN 1 END`) works.
 */
async function queryWinRateOriginal(db: ReturnType<typeof createTestDb>) {
  const calAgg = await db
    .select({
      settledCount: count(),
      wins: count(
        sql`CASE WHEN ${calibration.realizedPnl} > 0 THEN 1 END`,
      ),
    })
    .from(calibration)
    .where(sql`${calibration.traded} = 1`);

  const settledCount = Number(calAgg[0]?.settledCount ?? 0);
  const wins = Number(calAgg[0]?.wins ?? 0);
  return { settledCount, wins, winRate: settledCount > 0 ? wins / settledCount : 0 };
}

/**
 * Fixed version: use sql<number> for the full aggregate expression.
 */
async function queryWinRateFixed(db: ReturnType<typeof createTestDb>) {
  const calAgg = await db
    .select({
      settledCount: count(),
      wins: sql<number>`SUM(CASE WHEN ${calibration.realizedPnl} > 0 THEN 1 ELSE 0 END)`,
    })
    .from(calibration)
    .where(sql`${calibration.traded} = 1`);

  const settledCount = Number(calAgg[0]?.settledCount ?? 0);
  const wins = Number(calAgg[0]?.wins ?? 0);
  return { settledCount, wins, winRate: settledCount > 0 ? wins / settledCount : 0 };
}

describe("performance win rate query", () => {
  test("original query: 3 traded, 2 wins → wins should be 2", async () => {
    const db = createTestDb();
    await insertCalibration(db, { traded: true, realizedPnl: 150 });
    await insertCalibration(db, { traded: true, realizedPnl: -50 });
    await insertCalibration(db, { traded: true, realizedPnl: 200 });
    // Non-traded should be excluded
    await insertCalibration(db, { traded: false, realizedPnl: 100 });

    const result = await queryWinRateOriginal(db);
    expect(result.settledCount).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.winRate).toBeCloseTo(0.6667, 3);
  });

  test("fixed query: 3 traded, 2 wins → wins should be 2", async () => {
    const db = createTestDb();
    await insertCalibration(db, { traded: true, realizedPnl: 150 });
    await insertCalibration(db, { traded: true, realizedPnl: -50 });
    await insertCalibration(db, { traded: true, realizedPnl: 200 });
    await insertCalibration(db, { traded: false, realizedPnl: 100 });

    const result = await queryWinRateFixed(db);
    expect(result.settledCount).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.winRate).toBeCloseTo(0.6667, 3);
  });

  test("no traded records → winRate 0", async () => {
    const db = createTestDb();
    await insertCalibration(db, { traded: false, realizedPnl: 100 });

    const original = await queryWinRateOriginal(db);
    expect(original.settledCount).toBe(0);
    expect(original.winRate).toBe(0);

    const fixed = await queryWinRateFixed(db);
    expect(fixed.settledCount).toBe(0);
    expect(fixed.winRate).toBe(0);
  });

  test("all losses → winRate 0", async () => {
    const db = createTestDb();
    await insertCalibration(db, { traded: true, realizedPnl: -50 });
    await insertCalibration(db, { traded: true, realizedPnl: -100 });

    const original = await queryWinRateOriginal(db);
    const fixed = await queryWinRateFixed(db);

    expect(original.settledCount).toBe(2);
    expect(fixed.settledCount).toBe(2);
    expect(fixed.wins).toBe(0);
    expect(fixed.winRate).toBe(0);
  });

  test("realizedPnl = 0 does not count as win", async () => {
    const db = createTestDb();
    await insertCalibration(db, { traded: true, realizedPnl: 0 });
    await insertCalibration(db, { traded: true, realizedPnl: 100 });

    const fixed = await queryWinRateFixed(db);
    expect(fixed.settledCount).toBe(2);
    expect(fixed.wins).toBe(1);
    expect(fixed.winRate).toBe(0.5);
  });

  test("realizedPnl = null does not count as win", async () => {
    const db = createTestDb();
    await insertCalibration(db, { traded: true, realizedPnl: null });
    await insertCalibration(db, { traded: true, realizedPnl: 50 });

    const fixed = await queryWinRateFixed(db);
    expect(fixed.settledCount).toBe(2);
    expect(fixed.wins).toBe(1);
    expect(fixed.winRate).toBe(0.5);
  });
});
