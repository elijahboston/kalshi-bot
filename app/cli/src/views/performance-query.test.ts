import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql, count } from "drizzle-orm";
import { calibration } from "@kcb/db";
import { queryWindowedWinRates } from "./performance";

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
  const db = drizzle(sqlite, { schema: { calibration } });
  return { sqlite, db };
}

function insert(
  sqlite: Database,
  overrides: Partial<{
    realizedPnl: number | null;
    traded: boolean;
    resolvedAt: string;
  }> = {},
) {
  const id = crypto.randomUUID();
  sqlite.run(
    `INSERT INTO calibration (id, ticker, series_ticker, category, predicted_prob, actual_outcome, market_price, edge, realized_pnl, traded, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `TICKER-${id.slice(0, 6)}`,
      "KXHIGHNY",
      "high_temp",
      0.6,
      1,
      0.5,
      0.1,
      overrides.realizedPnl ?? null,
      overrides.traded ? 1 : 0,
      overrides.resolvedAt ?? new Date().toISOString(),
    ],
  );
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

/**
 * Original query from performance.tsx — uses count(CASE WHEN ...).
 */
async function queryWinRateOriginal(db: ReturnType<typeof drizzle>) {
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
 * Fixed version: use SUM(CASE WHEN ...) instead of count(CASE WHEN ...).
 */
async function queryWinRateFixed(db: ReturnType<typeof drizzle>) {
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
    const { sqlite, db } = createTestDb();
    insert(sqlite, { traded: true, realizedPnl: 150 });
    insert(sqlite, { traded: true, realizedPnl: -50 });
    insert(sqlite, { traded: true, realizedPnl: 200 });
    insert(sqlite, { traded: false, realizedPnl: 100 });

    const result = await queryWinRateOriginal(db);
    expect(result.settledCount).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.winRate).toBeCloseTo(0.6667, 3);
  });

  test("fixed query: 3 traded, 2 wins → wins should be 2", async () => {
    const { sqlite, db } = createTestDb();
    insert(sqlite, { traded: true, realizedPnl: 150 });
    insert(sqlite, { traded: true, realizedPnl: -50 });
    insert(sqlite, { traded: true, realizedPnl: 200 });
    insert(sqlite, { traded: false, realizedPnl: 100 });

    const result = await queryWinRateFixed(db);
    expect(result.settledCount).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.winRate).toBeCloseTo(0.6667, 3);
  });

  test("no traded records → winRate 0", async () => {
    const { sqlite, db } = createTestDb();
    insert(sqlite, { traded: false, realizedPnl: 100 });

    const original = await queryWinRateOriginal(db);
    expect(original.settledCount).toBe(0);
    expect(original.winRate).toBe(0);

    const fixed = await queryWinRateFixed(db);
    expect(fixed.settledCount).toBe(0);
    expect(fixed.winRate).toBe(0);
  });

  test("all losses → winRate 0", async () => {
    const { sqlite, db } = createTestDb();
    insert(sqlite, { traded: true, realizedPnl: -50 });
    insert(sqlite, { traded: true, realizedPnl: -100 });

    const original = await queryWinRateOriginal(db);
    const fixed = await queryWinRateFixed(db);

    expect(original.settledCount).toBe(2);
    expect(fixed.settledCount).toBe(2);
    expect(fixed.wins).toBe(0);
    expect(fixed.winRate).toBe(0);
  });

  test("realizedPnl = 0 does not count as win", async () => {
    const { sqlite, db } = createTestDb();
    insert(sqlite, { traded: true, realizedPnl: 0 });
    insert(sqlite, { traded: true, realizedPnl: 100 });

    const fixed = await queryWinRateFixed(db);
    expect(fixed.settledCount).toBe(2);
    expect(fixed.wins).toBe(1);
    expect(fixed.winRate).toBe(0.5);
  });

  test("realizedPnl = null does not count as win", async () => {
    const { sqlite, db } = createTestDb();
    insert(sqlite, { traded: true, realizedPnl: null });
    insert(sqlite, { traded: true, realizedPnl: 50 });

    const fixed = await queryWinRateFixed(db);
    expect(fixed.settledCount).toBe(2);
    expect(fixed.wins).toBe(1);
    expect(fixed.winRate).toBe(0.5);
  });
});

describe("queryWindowedWinRates", () => {
  test("returns 3 windows: 24h, 48h, 7d", async () => {
    const { db } = createTestDb();
    const results = await queryWindowedWinRates(db);
    expect(results.length).toBe(3);
    expect(results.map((r) => r.label)).toEqual(["24h", "48h", "7d"]);
  });

  test("empty table returns 0 for all windows", async () => {
    const { db } = createTestDb();
    const results = await queryWindowedWinRates(db);
    for (const r of results) {
      expect(r.total).toBe(0);
      expect(r.wins).toBe(0);
      expect(r.rate).toBe(0);
    }
  });

  test("recent trades appear in all windows", async () => {
    const { sqlite, db } = createTestDb();
    insert(sqlite, { traded: true, realizedPnl: 100, resolvedAt: hoursAgo(1) });
    insert(sqlite, { traded: true, realizedPnl: 50, resolvedAt: hoursAgo(1) });
    insert(sqlite, { traded: true, realizedPnl: -30, resolvedAt: hoursAgo(1) });

    const results = await queryWindowedWinRates(db);
    for (const r of results) {
      expect(r.total).toBe(3);
      expect(r.wins).toBe(2);
      expect(r.rate).toBeCloseTo(0.6667, 3);
    }
  });

  test("trades outside 24h only appear in wider windows", async () => {
    const { sqlite, db } = createTestDb();
    insert(sqlite, { traded: true, realizedPnl: 100, resolvedAt: hoursAgo(30) });
    insert(sqlite, { traded: true, realizedPnl: 50, resolvedAt: hoursAgo(1) });

    const results = await queryWindowedWinRates(db);
    const r24 = results.find((r) => r.label === "24h")!;
    const r48 = results.find((r) => r.label === "48h")!;
    const r7d = results.find((r) => r.label === "7d")!;

    expect(r24.total).toBe(1);
    expect(r24.wins).toBe(1);

    expect(r48.total).toBe(2);
    expect(r48.wins).toBe(2);

    expect(r7d.total).toBe(2);
    expect(r7d.wins).toBe(2);
  });

  test("trades outside 7d are excluded from all windows", async () => {
    const { sqlite, db } = createTestDb();
    insert(sqlite, { traded: true, realizedPnl: 100, resolvedAt: hoursAgo(200) });

    const results = await queryWindowedWinRates(db);
    for (const r of results) {
      expect(r.total).toBe(0);
    }
  });

  test("non-traded records are excluded", async () => {
    const { sqlite, db } = createTestDb();
    insert(sqlite, { traded: false, realizedPnl: 100, resolvedAt: hoursAgo(1) });
    insert(sqlite, { traded: true, realizedPnl: 50, resolvedAt: hoursAgo(1) });

    const results = await queryWindowedWinRates(db);
    const r24 = results.find((r) => r.label === "24h")!;
    expect(r24.total).toBe(1);
    expect(r24.wins).toBe(1);
  });
});
