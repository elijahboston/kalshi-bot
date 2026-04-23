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
import { eq } from "drizzle-orm";
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
