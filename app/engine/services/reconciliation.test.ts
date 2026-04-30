import { test, expect, describe } from "bun:test";

/**
 * Extracted PnL computation from syncSettlements.
 * Tests the fallback: s.realized_pnl ?? (revenue - yesCost - noCost)
 */
function computeSettlementPnl(settlement: {
  realized_pnl?: number | null;
  revenue: number;
  yes_total_cost: number;
  no_total_cost: number;
}): number {
  const yesCost = settlement.yes_total_cost ?? 0;
  const noCost = settlement.no_total_cost ?? 0;
  return settlement.realized_pnl ?? (settlement.revenue - yesCost - noCost);
}

describe("settlement PnL computation", () => {
  test("uses realized_pnl when provided by Kalshi API", () => {
    const pnl = computeSettlementPnl({
      realized_pnl: 250,
      revenue: 500,
      yes_total_cost: 250,
      no_total_cost: 0,
    });
    expect(pnl).toBe(250);
  });

  test("falls back to revenue - costs when realized_pnl is undefined", () => {
    const pnl = computeSettlementPnl({
      realized_pnl: undefined,
      revenue: 500,
      yes_total_cost: 200,
      no_total_cost: 0,
    });
    // 500 - 200 - 0 = 300
    expect(pnl).toBe(300);
  });

  test("falls back to revenue - costs when realized_pnl is null", () => {
    const pnl = computeSettlementPnl({
      realized_pnl: null,
      revenue: 1000,
      yes_total_cost: 0,
      no_total_cost: 400,
    });
    // 1000 - 0 - 400 = 600
    expect(pnl).toBe(600);
  });

  test("computes negative PnL for losing YES trade", () => {
    // Bought YES at 60¢ × 5 contracts, market resolved NO → revenue = 0
    const pnl = computeSettlementPnl({
      realized_pnl: undefined,
      revenue: 0,
      yes_total_cost: 300, // 60¢ × 5
      no_total_cost: 0,
    });
    expect(pnl).toBe(-300);
  });

  test("computes positive PnL for winning YES trade", () => {
    // Bought YES at 40¢ × 5 contracts, resolved YES → revenue = 500 (100¢ × 5)
    const pnl = computeSettlementPnl({
      realized_pnl: undefined,
      revenue: 500,
      yes_total_cost: 200, // 40¢ × 5
      no_total_cost: 0,
    });
    // 500 - 200 = 300
    expect(pnl).toBe(300);
  });

  test("computes positive PnL for winning NO trade", () => {
    // Bought NO at 30¢ × 10 contracts, resolved NO → revenue = 1000
    const pnl = computeSettlementPnl({
      realized_pnl: undefined,
      revenue: 1000,
      yes_total_cost: 0,
      no_total_cost: 300, // 30¢ × 10
    });
    // 1000 - 0 - 300 = 700
    expect(pnl).toBe(700);
  });

  test("does NOT use fallback when realized_pnl is 0 (explicit zero)", () => {
    // 0 is a valid PnL (break-even), should not trigger ?? fallback
    const pnl = computeSettlementPnl({
      realized_pnl: 0,
      revenue: 500,
      yes_total_cost: 200,
      no_total_cost: 0,
    });
    expect(pnl).toBe(0);
  });
});

// Import the real function used by reconciliation
import { computePerSidePnl } from "./reconciliation";

// Adapter: convert test format (price/quantity) to DB format (limitPrice/filledQuantity)
function computeTradesPnl(
  marketTrades: Array<{ action: string; side: string; price: number; quantity: number }>,
  outcome: number,
): number {
  return computePerSidePnl(
    marketTrades.map((t) => ({
      action: t.action,
      side: t.side,
      limitPrice: t.price,
      filledQuantity: t.quantity,
    })),
    outcome,
  );
}

describe("trade-based PnL computation", () => {
  test("winning YES trade", () => {
    const pnl = computeTradesPnl(
      [{ action: "buy", side: "yes", price: 40, quantity: 5 }],
      1, // YES outcome
    );
    // (100 - 40) * 5 = 300
    expect(pnl).toBe(300);
  });

  test("losing YES trade", () => {
    const pnl = computeTradesPnl(
      [{ action: "buy", side: "yes", price: 60, quantity: 3 }],
      0, // NO outcome
    );
    // -60 * 3 = -180
    expect(pnl).toBe(-180);
  });

  test("winning NO trade", () => {
    const pnl = computeTradesPnl(
      [{ action: "buy", side: "no", price: 30, quantity: 10 }],
      0, // NO outcome → NO wins
    );
    // (100 - 30) * 10 = 700
    expect(pnl).toBe(700);
  });

  test("losing NO trade", () => {
    const pnl = computeTradesPnl(
      [{ action: "buy", side: "no", price: 50, quantity: 4 }],
      1, // YES outcome → NO loses
    );
    // -50 * 4 = -200
    expect(pnl).toBe(-200);
  });

  test("multiple trades mixed", () => {
    const pnl = computeTradesPnl(
      [
        { action: "buy", side: "yes", price: 40, quantity: 5 },
        { action: "buy", side: "yes", price: 50, quantity: 3 },
      ],
      1,
    );
    expect(pnl).toBe(450);
  });

  test("sell reduces remaining position and counts proceeds", () => {
    // Buy YES@40 x5, sell YES@60 x3, outcome YES
    // yesNetQty=2, yesWon=true, payout=200
    // PnL = 200 + 180 - 200 = 180
    const pnl = computeTradesPnl(
      [
        { action: "buy", side: "yes", price: 40, quantity: 5 },
        { action: "sell", side: "yes", price: 60, quantity: 3 },
      ],
      1,
    );
    expect(pnl).toBe(180);
  });

  test("full exit before resolution uses sell proceeds only", () => {
    // Buy YES@60 x5, sell YES@40 x5, outcome NO
    // PnL = 0 + 200 - 300 = -100
    const pnl = computeTradesPnl(
      [
        { action: "buy", side: "yes", price: 60, quantity: 5 },
        { action: "sell", side: "yes", price: 40, quantity: 5 },
      ],
      0,
    );
    expect(pnl).toBe(-100);
  });

  test("buy-exit-rebuy churn computes correctly", () => {
    // Buy YES@60 x5, sell YES@40 x5, buy YES@55 x5, outcome YES
    // PnL = 500 + 200 - 575 = 125
    const pnl = computeTradesPnl(
      [
        { action: "buy", side: "yes", price: 60, quantity: 5 },
        { action: "sell", side: "yes", price: 40, quantity: 5 },
        { action: "buy", side: "yes", price: 55, quantity: 5 },
      ],
      1,
    );
    expect(pnl).toBe(125);
  });

  test("no trades returns 0", () => {
    const pnl = computeTradesPnl([], 1);
    expect(pnl).toBe(0);
  });

  test("filledQuantity=0 produces zero PnL (the sync bug)", () => {
    // When filledQuantity is 0, all math zeroes out regardless of prices
    const pnl = computePerSidePnl(
      [
        { action: "buy", side: "no", limitPrice: 59, filledQuantity: 0 },
        { action: "buy", side: "no", limitPrice: 62, filledQuantity: 0 },
      ],
      0, // NO won — should be a win
    );
    expect(pnl).toBe(0);
  });

  test("repaired filledQuantity produces correct PnL", () => {
    // Same orders as above but with correct filledQuantity
    const pnl = computePerSidePnl(
      [
        { action: "buy", side: "no", limitPrice: 59, filledQuantity: 2 },
        { action: "buy", side: "no", limitPrice: 62, filledQuantity: 2 },
      ],
      0, // NO won
    );
    // noNetQty=4, noWon=true → settlement=400, buyCost=59*2+62*2=242
    // PnL = 400 + 0 - 242 = 158
    expect(pnl).toBe(158);
  });

  test("cross-side sells: NO sells don't inflate YES PnL", () => {
    // Buy YES@16 x12, sell NO@94 x10, outcome NO (YES lost)
    // YES side: buyCost=192, netQty=12, yesWon=false → settlement=0
    //   yesPnl = 0 + 0 - 192 = -192
    // NO side: sellProceeds=940, netQty=-10 (short), noWon=true → settlement=-1000
    //   noPnl = -1000 + 940 - 0 = -60
    // Total: -192 + (-60) = -252
    const pnl = computeTradesPnl(
      [
        { action: "buy", side: "yes", price: 16, quantity: 12 },
        { action: "sell", side: "no", price: 94, quantity: 10 },
      ],
      0,
    );
    expect(pnl).toBe(-252);
  });

  test("cross-side sells: NO shorts profit when YES wins", () => {
    // Sell NO@94 x10, outcome YES → NO lost, short keeps premium
    // NO side: sellProceeds=940, netQty=-10, noWon=false → settlement=0
    //   noPnl = 0 + 940 - 0 = 940
    const pnl = computeTradesPnl(
      [{ action: "sell", side: "no", price: 94, quantity: 10 }],
      1,
    );
    expect(pnl).toBe(940);
  });

  test("mixed YES buys and NO sells, market resolves NO", () => {
    // Real-world scenario: bot buys YES cheap, exit sells NO (wrong side)
    // Buy YES@5 x15, sell NO@94 x15, outcome NO
    // YES: buyCost=75, netQty=15, yesWon=false → 0+0-75 = -75
    // NO: sellProceeds=1410, netQty=-15, noWon=true → -1500+1410-0 = -90
    // Total: -75 + (-90) = -165
    const pnl = computeTradesPnl(
      [
        { action: "buy", side: "yes", price: 5, quantity: 15 },
        { action: "sell", side: "no", price: 94, quantity: 15 },
      ],
      0,
    );
    expect(pnl).toBe(-165);
  });
});

// ── backfillActualValue synthesis path ──────────────────────
// DO NOT mock @kcb/db or @kcb/engine — they leak globally via mock.module
// and break other test files. Use real in-memory DB + fetch swap.
import { mock, beforeEach, afterEach } from "bun:test";
import {
  runMigrations,
  getDb,
  weatherForecasts,
  signals,
  markets,
} from "@kcb/db";
import { eq, sql } from "drizzle-orm";
import { ReconciliationService } from "./reconciliation";

runMigrations();

const originalFetch = globalThis.fetch;

function mockNwsResponse(maxTempC: number | null) {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          features: maxTempC == null
            ? []
            : [
                {
                  properties: {
                    maxTemperatureLast24Hours: { value: maxTempC },
                    minTemperatureLast24Hours: { value: null },
                    precipitationLastHour: { value: null },
                  },
                },
              ],
        }),
        { status: 200 }
      )
    )
  ) as typeof fetch;
}

describe("backfillActualValue — retention-resilient backfill", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(weatherForecasts).run();
    db.delete(signals).run();
    db.delete(markets).run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const ticker = "KXHIGHNY-26APR20-B72.5";
  const stationId = "KNYC";
  const targetDate = "2026-04-20";
  const category = "high_temp";

  function seedSignalWithTrace(overrides: Record<string, unknown> = {}) {
    const db = getDb();
    db.insert(signals).values({
      id: "sig-1",
      ticker,
      seriesTicker: "KXHIGHNY",
      estimatedProb: 0.2,
      confidence: 0.5,
      marketPrice: 0.3,
      edge: -0.1,
      edgeThreshold: 0.05,
      recommendation: "skip",
      reasoning: JSON.stringify({
        stationId,
        targetDate,
        forecastHorizon: 1,
        rawEnsembleStats: { mean: 71.2, std: 2.5, count: 120 },
        correctedEnsembleStats: { mean: 72.0, std: 2.5 },
        ...overrides,
      }),
      createdAt: "2026-04-19T10:00:00.000Z",
    }).run();
  }

  test("updates existing row's actual_value when one exists without it", async () => {
    const db = getDb();
    db.insert(weatherForecasts).values({
      id: "wf-existing",
      stationId,
      targetDate,
      source: "multi_ensemble",
      forecastType: category,
      forecastHorizon: 1,
      pointForecast: 71.5,
      ensembleValues: "[71,72]",
      ensembleSize: 2,
      ensembleMean: 71.5,
      ensembleStd: 0.5,
      actualValue: null,
      fetchedAt: "2026-04-19T10:00:00.000Z",
    }).run();

    mockNwsResponse(22.2); // 22.2°C → 72.0°F

    const svc = new ReconciliationService({} as never);
    await (svc as any).backfillActualValue({
      ticker,
      stationId,
      targetDate,
      category,
    });

    const rows = db.select().from(weatherForecasts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].actualValue).toBeCloseTo(71.96, 1);
    expect(rows[0].source).toBe("multi_ensemble"); // unchanged
  });

  test("synthesizes a new row from signal trace when no forecast row exists", async () => {
    const db = getDb();
    seedSignalWithTrace();

    mockNwsResponse(22.2); // ≈72°F

    const svc = new ReconciliationService({} as never);
    await (svc as any).backfillActualValue({
      ticker,
      stationId,
      targetDate,
      category,
    });

    const rows = db.select().from(weatherForecasts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("backfilled");
    expect(rows[0].pointForecast).toBe(72.0); // from correctedEnsembleStats.mean
    expect(rows[0].ensembleMean).toBe(71.2);
    expect(rows[0].ensembleStd).toBe(2.5);
    expect(rows[0].ensembleSize).toBe(120);
    expect(rows[0].actualValue).toBeCloseTo(71.96, 1);
    expect(rows[0].forecastType).toBe(category);
    expect(rows[0].forecastHorizon).toBe(1);
  });

  test("no-op when row exists with actual_value already filled", async () => {
    const db = getDb();
    db.insert(weatherForecasts).values({
      id: "wf-filled",
      stationId,
      targetDate,
      source: "multi_ensemble",
      forecastType: category,
      forecastHorizon: 1,
      pointForecast: 71.5,
      ensembleValues: null,
      ensembleSize: null,
      ensembleMean: null,
      ensembleStd: null,
      actualValue: 72.3,
      fetchedAt: "2026-04-19T10:00:00.000Z",
    }).run();

    // Fetch should NOT be called — make any fetch throw to assert this
    globalThis.fetch = mock(() => Promise.reject(new Error("should not fetch"))) as typeof fetch;

    const svc = new ReconciliationService({} as never);
    await (svc as any).backfillActualValue({
      ticker,
      stationId,
      targetDate,
      category,
    });

    const rows = db.select().from(weatherForecasts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].actualValue).toBe(72.3); // unchanged
  });

  test("no synthesis when signal has no reasoning trace", async () => {
    const db = getDb();
    db.insert(signals).values({
      id: "sig-noreason",
      ticker,
      seriesTicker: "KXHIGHNY",
      estimatedProb: 0.2,
      confidence: 0.5,
      marketPrice: 0.3,
      edge: -0.1,
      edgeThreshold: 0.05,
      recommendation: "skip",
      reasoning: null,
      createdAt: "2026-04-19T10:00:00.000Z",
    }).run();

    mockNwsResponse(22.2);

    const svc = new ReconciliationService({} as never);
    await (svc as any).backfillActualValue({
      ticker,
      stationId,
      targetDate,
      category,
    });

    const rows = db.select().from(weatherForecasts).all();
    expect(rows).toHaveLength(0);
  });

  test("no synthesis when ticker is missing", async () => {
    seedSignalWithTrace();
    mockNwsResponse(22.2);

    const svc = new ReconciliationService({} as never);
    await (svc as any).backfillActualValue({
      // ticker omitted intentionally
      stationId,
      targetDate,
      category,
    });

    const db = getDb();
    const rows = db.select().from(weatherForecasts).all();
    expect(rows).toHaveLength(0);
  });

  test("no synthesis when NWS has no observation", async () => {
    seedSignalWithTrace();
    mockNwsResponse(null); // empty features

    const svc = new ReconciliationService({} as never);
    await (svc as any).backfillActualValue({
      ticker,
      stationId,
      targetDate,
      category,
    });

    const db = getDb();
    const rows = db.select().from(weatherForecasts).all();
    expect(rows).toHaveLength(0);
  });

  test("synthesized row has non-null point_forecast and actual_value so recomputeStationBias can use it", async () => {
    const db = getDb();
    seedSignalWithTrace();
    mockNwsResponse(20.0); // 68°F

    const svc = new ReconciliationService({} as never);
    await (svc as any).backfillActualValue({
      ticker,
      stationId,
      targetDate,
      category,
    });

    const [row] = db.select().from(weatherForecasts).where(eq(weatherForecasts.stationId, stationId)).all();
    expect(row).toBeDefined();
    expect(row.pointForecast).not.toBeNull();
    expect(row.actualValue).not.toBeNull();
    // bias residual = pointForecast - actual = 72 - 68 = 4
    expect(row.pointForecast! - row.actualValue!).toBeCloseTo(4.0, 1);
  });
});

// ── snapshotBalance mode-aware dry-run lookup ──────────────────
// Tests the core invariant: in dry-run mode, the latest-balance lookup must
// filter to dry_run=1 rows so live and paper histories don't mix. Uses
// getConfig directly to set dryRun because updateConfig isn't exported by the
// mock.module leaks from other test files per project memory.
import { balanceHistory, positions, calibration } from "@kcb/db";
import { getConfig } from "@kcb/config";

describe("snapshotBalance — mode-aware balance lookup", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(balanceHistory).run();
    db.delete(positions).run();
    db.delete(calibration).run();
  });

  function seedBalance(id: string, balance: number, dryRun: boolean, recordedAt: string) {
    const db = getDb();
    db.insert(balanceHistory).values({
      id,
      balance,
      totalEquity: balance,
      openPositions: 0,
      realizedPnl: 0,
      recordedAt,
      dryRun,
    }).run();
  }

  test("dry-run snapshotBalance only reads dry_run=1 rows", async () => {
    // Live balance more recent than the paper balance — the mode-aware read
    // must still return the paper row, not the live one.
    seedBalance("live-new", 7500, false, "2026-04-24T12:00:00Z");
    seedBalance("paper-old", 50000, true, "2026-04-20T08:00:00Z");

    // Force dryRun=true directly on the config object returned by getConfig.
    getConfig().bot.dryRun = true;

    const svc = new ReconciliationService({} as never);
    await (svc as any).snapshotBalance();

    const rows = getDb()
      .select()
      .from(balanceHistory)
      .orderBy(sql`recorded_at DESC`)
      .all();

    // Newest row = the snapshot we just took. Filter to dry_run=1 so we
    // don't confuse it with the seeded live-new row.
    const newestPaper = rows.find((r) => r.dryRun === true);
    expect(newestPaper).toBeDefined();
    expect(newestPaper!.balance).toBe(50000);
  });

  test("dry-run snapshotBalance falls back to 10000 cents when no paper rows exist", async () => {
    seedBalance("live-only", 7500, false, "2026-04-24T12:00:00Z");

    getConfig().bot.dryRun = true;

    const svc = new ReconciliationService({} as never);
    await (svc as any).snapshotBalance();

    const rows = getDb()
      .select()
      .from(balanceHistory)
      .orderBy(sql`recorded_at DESC`)
      .all();

    const newestPaper = rows.find((r) => r.dryRun === true);
    expect(newestPaper).toBeDefined();
    expect(newestPaper!.balance).toBe(10000); // default when no paper history
  });

  test("paper balance deducts cost basis of open paper positions", async () => {
    const db = getDb();
    seedBalance("seed", 50000, true, "2026-04-28T08:00:00Z");

    // Two open paper positions, $5 cost each.
    db.insert(positionsTable).values([
      {
        ticker: "KX-A",
        side: "no",
        quantity: 25,
        avgEntryPrice: 20,
        costBasis: 500,
        marketValue: 25,
        unrealizedPnl: -475,
        openedAt: "2026-04-28T17:00:00Z",
        updatedAt: "2026-04-28T17:00:00Z",
        dryRun: true,
      },
      {
        ticker: "KX-B",
        side: "no",
        quantity: 10,
        avgEntryPrice: 50,
        costBasis: 500,
        marketValue: 480,
        unrealizedPnl: -20,
        openedAt: "2026-04-28T18:00:00Z",
        updatedAt: "2026-04-28T18:00:00Z",
        dryRun: true,
      },
    ]).run();

    getConfig().bot.dryRun = true;

    const svc = new ReconciliationService({} as never);
    await (svc as any).snapshotBalance();

    const rows = getDb()
      .select()
      .from(balanceHistory)
      .orderBy(sql`recorded_at DESC`)
      .all();
    const newest = rows.find((r) => r.dryRun === true && r.recordedAt !== "2026-04-28T08:00:00Z");
    expect(newest).toBeDefined();
    // 50000 seed − (500 + 500) tied up = 49000
    expect(newest!.balance).toBe(49000);
  });

  test("paper balance applies realized PnL from resolved paper trades", async () => {
    const db = getDb();
    seedBalance("seed", 50000, true, "2026-04-28T08:00:00Z");

    // Bot order on a now-resolved paper trade
    db.insert(ordersTable).values({
      orderId: "dry-1",
      ticker: "KX-RESOLVED",
      action: "buy",
      side: "no",
      limitPrice: 20,
      quantity: 25,
      filledQuantity: 25,
      status: "filled",
      signalId: "sig-1",
      dryRun: true,
      createdAt: "2026-04-28T17:00:00Z",
      updatedAt: "2026-04-28T17:00:00Z",
    }).run();

    // Calibration row records the realized PnL: bought 25 NO @ 20¢ = $5 cost,
    // market resolved YES → NO worthless → $5 loss = -500 cents
    db.insert(calibration).values({
      id: "cal-1",
      ticker: "KX-RESOLVED",
      seriesTicker: "KXHIGHNY",
      category: "high_temp",
      stationId: "KNYC",
      predictedProb: 0.05,
      actualOutcome: 1,
      marketPrice: 20,
      edge: -0.15,
      realizedPnl: -500,
      traded: true,
      forecastHorizon: 1,
      resolvedAt: "2026-04-29T05:00:00Z",
    }).run();

    getConfig().bot.dryRun = true;

    const svc = new ReconciliationService({} as never);
    await (svc as any).snapshotBalance();

    const rows = getDb()
      .select()
      .from(balanceHistory)
      .orderBy(sql`recorded_at DESC`)
      .all();
    const newest = rows.find((r) => r.dryRun === true && r.recordedAt !== "2026-04-28T08:00:00Z");
    // 50000 seed + (-500 realized) − 0 open = 49500
    expect(newest!.balance).toBe(49500);
  });

  test("paper balance combines open positions and realized PnL correctly", async () => {
    const db = getDb();
    seedBalance("seed", 50000, true, "2026-04-28T08:00:00Z");

    // One open position, $5 tied up
    db.insert(positionsTable).values({
      ticker: "KX-OPEN",
      side: "no",
      quantity: 25,
      avgEntryPrice: 20,
      costBasis: 500,
      marketValue: 100,
      unrealizedPnl: -400,
      openedAt: "2026-04-30T10:00:00Z",
      updatedAt: "2026-04-30T10:00:00Z",
      dryRun: true,
    }).run();

    // Three resolved paper trades: -$5, -$5, +$3 (net -$7 realized = -700 cents)
    for (const [id, pnl] of [["a", -500], ["b", -500], ["c", 300]] as const) {
      db.insert(ordersTable).values({
        orderId: `dry-${id}`,
        ticker: `KX-RESOLVED-${id}`,
        action: "buy", side: "no", limitPrice: 20, quantity: 25, filledQuantity: 25,
        status: "filled", signalId: `sig-${id}`, dryRun: true,
        createdAt: "2026-04-28T17:00:00Z", updatedAt: "2026-04-28T17:00:00Z",
      }).run();
      db.insert(calibration).values({
        id: `cal-${id}`,
        ticker: `KX-RESOLVED-${id}`,
        seriesTicker: "KXHIGHNY",
        category: "high_temp",
        stationId: "KNYC",
        predictedProb: 0.05,
        actualOutcome: pnl < 0 ? 1 : 0,
        marketPrice: 20,
        edge: -0.15,
        realizedPnl: pnl,
        traded: true,
        forecastHorizon: 1,
        resolvedAt: "2026-04-29T05:00:00Z",
      }).run();
    }

    getConfig().bot.dryRun = true;

    const svc = new ReconciliationService({} as never);
    await (svc as any).snapshotBalance();

    const rows = getDb()
      .select()
      .from(balanceHistory)
      .orderBy(sql`recorded_at DESC`)
      .all();
    const newest = rows.find((r) => r.dryRun === true && r.recordedAt !== "2026-04-28T08:00:00Z");
    // 50000 seed + (-500 + -500 + 300 = -700 realized) − 500 tied up = 48800
    expect(newest!.balance).toBe(48800);
  });

  test("paper balance ignores untraded calibration rows (no bot order)", async () => {
    const db = getDb();
    seedBalance("seed", 50000, true, "2026-04-28T08:00:00Z");

    // Untraded calibration row — no bot order exists for this ticker.
    // Should NOT affect paper balance.
    db.insert(calibration).values({
      id: "cal-untraded",
      ticker: "KX-UNTRADED",
      seriesTicker: "KXHIGHNY",
      category: "high_temp",
      stationId: "KNYC",
      predictedProb: 0.05,
      actualOutcome: 1,
      marketPrice: 20,
      edge: -0.15,
      realizedPnl: 0, // not traded → null in practice, but using 0 for clarity
      traded: false,
      forecastHorizon: 1,
      resolvedAt: "2026-04-29T05:00:00Z",
    }).run();

    getConfig().bot.dryRun = true;

    const svc = new ReconciliationService({} as never);
    await (svc as any).snapshotBalance();

    const rows = getDb()
      .select()
      .from(balanceHistory)
      .orderBy(sql`recorded_at DESC`)
      .all();
    const newest = rows.find((r) => r.dryRun === true && r.recordedAt !== "2026-04-28T08:00:00Z");
    expect(newest!.balance).toBe(50000);
  });
});

// ── checkResolutions handles finalized status ──────────────────
// Regression: the function used to filter on status='settled' but the bot's
// lifecycle only ever marks markets as 'finalized'. That left this entire
// branch dead — calibration only grew via syncSettlements (which is gated on
// the user having a position), starving the historical-prior blend of data.
import { markets as marketsTable } from "@kcb/db";

describe("checkResolutions — accepts finalized markets", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(marketsTable).run();
    db.delete(signals).run();
    db.delete(calibration).run();
    db.delete(weatherForecasts).run();
  });

  function seedFinalizedMarketAndSignal(ticker: string, predictedProb: number, result: "yes" | "no") {
    const db = getDb();
    // Intentionally omit stationId/targetDate so the recomputeStationBias and
    // backfillActualValue branches are skipped. Test the calibration-row
    // creation in isolation without depending on those downstream paths,
    // which dereference fields on getConfig() that mock.module leaks from
    // other test files don't provide.
    db.insert(marketsTable).values({
      ticker,
      eventTicker: "EVT-1",
      seriesTicker: "KXHIGHNY",
      title: `Test market ${ticker}`,
      category: "high_temp",
      stationId: null,
      targetDate: null,
      bracketLow: 70,
      bracketHigh: 71,
      marketType: "bracket",
      status: "finalized",
      result,
      discoveredAt: "2026-04-26T08:00:00Z",
      updatedAt: "2026-04-26T23:00:00Z",
    }).run();
    db.insert(signals).values({
      id: `sig-${ticker}`,
      ticker,
      seriesTicker: "KXHIGHNY",
      estimatedProb: predictedProb,
      confidence: 0.85,
      marketPrice: 0.5,
      edge: predictedProb - 0.5,
      edgeThreshold: 0.05,
      recommendation: "skip",
      createdAt: "2026-04-26T10:00:00Z",
    }).run();
  }

  test("creates calibration rows for finalized markets with signals", async () => {
    seedFinalizedMarketAndSignal("M-A", 0.05, "yes"); // bot said 5%, hit YES — miscalibrated low
    seedFinalizedMarketAndSignal("M-B", 0.7, "yes");  // bot said 70%, hit YES — calibrated
    seedFinalizedMarketAndSignal("M-C", 0.3, "no");   // bot said 30%, hit NO — calibrated

    const svc = new ReconciliationService({} as never);
    await (svc as any).checkResolutions();

    const rows = getDb()
      .select()
      .from(calibration)
      .all();

    expect(rows).toHaveLength(3);
    const byTicker = new Map(rows.map((r) => [r.ticker, r]));
    expect(byTicker.get("M-A")?.predictedProb).toBe(0.05);
    expect(byTicker.get("M-A")?.actualOutcome).toBe(1);
    expect(byTicker.get("M-B")?.actualOutcome).toBe(1);
    expect(byTicker.get("M-C")?.actualOutcome).toBe(0);
    // Untraded by design — the whole point is calibration grows from market
    // resolutions even when the bot didn't trade.
    expect(byTicker.get("M-A")?.traded).toBe(false);
  });

  test("skips markets that already have a calibration row", async () => {
    seedFinalizedMarketAndSignal("M-A", 0.5, "yes");

    const svc = new ReconciliationService({} as never);
    await (svc as any).checkResolutions();
    expect(getDb().select().from(calibration).all()).toHaveLength(1);

    // Run again — should be idempotent
    await (svc as any).checkResolutions();
    expect(getDb().select().from(calibration).all()).toHaveLength(1);
  });

  test("skips markets without a signal (post-wipe orphans)", async () => {
    const db = getDb();
    db.insert(marketsTable).values({
      ticker: "ORPHAN",
      eventTicker: "EVT-2",
      seriesTicker: "KXHIGHNY",
      title: "Orphaned market",
      category: "high_temp",
      stationId: null,
      targetDate: null,
      bracketLow: 60,
      bracketHigh: 61,
      marketType: "bracket",
      status: "finalized",
      result: "no",
      discoveredAt: "2026-04-25T08:00:00Z",
      updatedAt: "2026-04-25T23:00:00Z",
    }).run();

    const svc = new ReconciliationService({} as never);
    await (svc as any).checkResolutions();

    expect(db.select().from(calibration).all()).toHaveLength(0);
  });

  test("ignores active markets", async () => {
    const db = getDb();
    db.insert(marketsTable).values({
      ticker: "ACTIVE",
      eventTicker: "EVT-3",
      seriesTicker: "KXHIGHNY",
      title: "Active market",
      category: "high_temp",
      stationId: null,
      targetDate: null,
      bracketLow: 60,
      bracketHigh: 61,
      marketType: "bracket",
      status: "active",
      result: null,
      discoveredAt: "2026-04-26T08:00:00Z",
      updatedAt: "2026-04-26T23:00:00Z",
    }).run();
    db.insert(signals).values({
      id: "sig-active",
      ticker: "ACTIVE",
      seriesTicker: "KXHIGHNY",
      estimatedProb: 0.5,
      confidence: 0.9,
      marketPrice: 0.5,
      edge: 0,
      edgeThreshold: 0.05,
      recommendation: "skip",
      createdAt: "2026-04-26T10:00:00Z",
    }).run();

    const svc = new ReconciliationService({} as never);
    await (svc as any).checkResolutions();

    expect(db.select().from(calibration).all()).toHaveLength(0);
  });
});

// ── updatePositions tags rows by dry_run from underlying orders ─
// Verifies the core invariant: a position assembled from dry_run=1 trades
// gets marked dry_run=true, so syncPositionsFromKalshi (which scopes its
// stale-row cleanup to dry_run=false) leaves it alone.
import { positions as positionsTable, trades as tradesTable, orders as ordersTable } from "@kcb/db";

describe("updatePositions — tags positions by dry_run from orders", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(positionsTable).run();
    db.delete(tradesTable).run();
    db.delete(ordersTable).run();
    db.delete(marketsTable).run();
  });

  function seedActiveMarket(ticker: string) {
    const db = getDb();
    db.insert(marketsTable).values({
      ticker,
      eventTicker: "EVT",
      seriesTicker: "KXHIGHNY",
      title: ticker,
      category: "high_temp",
      stationId: null,
      targetDate: null,
      bracketLow: 70,
      bracketHigh: 71,
      marketType: "bracket",
      status: "active",
      result: null,
      lastYesPrice: 80,
      lastNoPrice: 20,
      discoveredAt: "2026-04-28T08:00:00Z",
      updatedAt: "2026-04-28T08:00:00Z",
    }).run();
  }

  function seedFilledOrderAndTrade(orderId: string, ticker: string, dryRun: boolean, qty = 25, price = 20) {
    const db = getDb();
    db.insert(ordersTable).values({
      orderId,
      ticker,
      action: "buy",
      side: "no",
      limitPrice: price,
      quantity: qty,
      filledQuantity: qty,
      status: "filled",
      signalId: `sig-${orderId}`,
      dryRun,
      createdAt: "2026-04-28T17:00:00Z",
      updatedAt: "2026-04-28T17:00:00Z",
    }).run();
    db.insert(tradesTable).values({
      id: `trd-${orderId}`,
      orderId,
      ticker,
      side: "no",
      price,
      quantity: qty,
      action: "buy",
      filledAt: "2026-04-28T17:00:00Z",
    }).run();
  }

  test("tags position dry_run=true when underlying order is dry_run=1", async () => {
    seedActiveMarket("KX-PAPER");
    seedFilledOrderAndTrade("dry-1", "KX-PAPER", true);

    const svc = new ReconciliationService({} as never);
    await (svc as any).updatePositions();

    const [pos] = getDb()
      .select()
      .from(positionsTable)
      .where(eq(positionsTable.ticker, "KX-PAPER"))
      .all();
    expect(pos).toBeDefined();
    expect(pos.dryRun).toBe(true);
    expect(pos.quantity).toBe(25);
    expect(pos.costBasis).toBe(500); // 25 contracts × 20¢
    expect(pos.avgEntryPrice).toBe(20);
  });

  test("tags position dry_run=false when underlying order is dry_run=0", async () => {
    seedActiveMarket("KX-LIVE");
    seedFilledOrderAndTrade("live-1", "KX-LIVE", false);

    const svc = new ReconciliationService({} as never);
    await (svc as any).updatePositions();

    const [pos] = getDb()
      .select()
      .from(positionsTable)
      .where(eq(positionsTable.ticker, "KX-LIVE"))
      .all();
    expect(pos).toBeDefined();
    expect(pos.dryRun).toBe(false);
  });

  test("opened_at reflects the first fill timestamp", async () => {
    seedActiveMarket("KX-PAPER");
    seedFilledOrderAndTrade("dry-1", "KX-PAPER", true);

    const svc = new ReconciliationService({} as never);
    await (svc as any).updatePositions();

    const [pos] = getDb()
      .select()
      .from(positionsTable)
      .where(eq(positionsTable.ticker, "KX-PAPER"))
      .all();
    expect(pos.openedAt).toBe("2026-04-28T17:00:00Z");
  });

  test("removes paper position when its market becomes finalized", async () => {
    const db = getDb();
    seedActiveMarket("KX-PAPER");
    seedFilledOrderAndTrade("dry-1", "KX-PAPER", true);

    const svc = new ReconciliationService({} as never);
    await (svc as any).updatePositions();

    // Position should now exist
    expect(db.select().from(positionsTable).all()).toHaveLength(1);

    // Market resolves — flip to finalized
    db.update(marketsTable)
      .set({ status: "finalized", result: "yes" })
      .where(eq(marketsTable.ticker, "KX-PAPER"))
      .run();

    await (svc as any).updatePositions();

    // Position should be cleaned up. Without the cleanup pass, paper rows on
    // finalized markets sat open indefinitely because syncPositionsFromKalshi
    // is scoped to dry_run=false and the active-market filter excludes them
    // from the trade-aggregation map (so the inner delete never fires).
    expect(db.select().from(positionsTable).all()).toHaveLength(0);
  });

  test("removes live position when its market becomes finalized (without waiting for syncPositionsFromKalshi)", async () => {
    const db = getDb();
    seedActiveMarket("KX-LIVE");
    seedFilledOrderAndTrade("live-1", "KX-LIVE", false);

    const svc = new ReconciliationService({} as never);
    await (svc as any).updatePositions();
    expect(db.select().from(positionsTable).all()).toHaveLength(1);

    db.update(marketsTable)
      .set({ status: "settled", result: "no" })
      .where(eq(marketsTable.ticker, "KX-LIVE"))
      .run();

    await (svc as any).updatePositions();
    expect(db.select().from(positionsTable).all()).toHaveLength(0);
  });
});

// ── fetchNwsActualValue uses per-observation temperature field ─
// Regression: NWS rarely populates maxTemperatureLast24Hours / minTemperatureLast24Hours
// even when the schema defines them. The reliably-populated field is `temperature`
// (instantaneous reading at each observation time). Without taking max/min of
// those, every backfill call returns null and weather_forecasts.actual_value
// stays empty forever, starving station_bias / empirical sigma.
import { weatherForecasts as weatherForecastsTable } from "@kcb/db";

function mockNwsRealisticResponse(temperaturesC: number[]) {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          features: temperaturesC.map((tc) => ({
            properties: {
              // Realistic shape: temperature populated, max/min24h null.
              temperature: { value: tc },
              maxTemperatureLast24Hours: { value: null },
              minTemperatureLast24Hours: { value: null },
              precipitationLastHour: { value: null },
            },
          })),
        }),
        { status: 200 }
      )
    )
  ) as typeof fetch;
}

describe("fetchNwsActualValue — uses per-observation temperature", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(weatherForecastsTable).run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("derives high_temp from max of per-observation temperature when max24h is null", async () => {
    // 33°C is the daily high for KAUS on 2026-04-28 — the actual NWS pattern.
    mockNwsRealisticResponse([28, 30, 31, 33, 32, 30, 27]);

    const svc = new ReconciliationService({} as never);
    const result = await (svc as any).fetchNwsActualValue("KAUS", "2026-04-28", "high_temp");
    // 33°C → 91.4°F
    expect(result).toBeCloseTo(91.4, 1);
  });

  test("derives low_temp from min of per-observation temperature", async () => {
    mockNwsRealisticResponse([28, 30, 31, 33, 32, 30, 27]);

    const svc = new ReconciliationService({} as never);
    const result = await (svc as any).fetchNwsActualValue("KAUS", "2026-04-28", "low_temp");
    // 27°C → 80.6°F
    expect(result).toBeCloseTo(80.6, 1);
  });

  test("still uses precomputed max24h when both are present (prefers tighter source)", async () => {
    // If max24h is more accurate (e.g. precomputed daily high from a
    // dedicated max-min thermometer), the function should pick the higher
    // value of either source. Realistic case: max24h reports 35°C while
    // hourly observations only saw 33°C.
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            features: [
              {
                properties: {
                  temperature: { value: 33 },
                  maxTemperatureLast24Hours: { value: 35 },
                  minTemperatureLast24Hours: { value: null },
                  precipitationLastHour: { value: null },
                },
              },
            ],
          }),
          { status: 200 }
        )
      )
    ) as typeof fetch;

    const svc = new ReconciliationService({} as never);
    const result = await (svc as any).fetchNwsActualValue("KAUS", "2026-04-28", "high_temp");
    // max(33→91.4, 35→95.0) = 95.0
    expect(result).toBeCloseTo(95.0, 1);
  });

  test("returns null when no features", async () => {
    mockNwsRealisticResponse([]);
    const svc = new ReconciliationService({} as never);
    const result = await (svc as any).fetchNwsActualValue("KAUS", "2026-04-28", "high_temp");
    expect(result).toBeNull();
  });
});
