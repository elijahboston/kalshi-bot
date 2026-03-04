import { test, expect, describe, mock, beforeEach } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────
// Only mock @kcb/config and @kcb/db — these don't leak harmfully.
// DO NOT mock @kcb/engine or @kcb/kalshi-client — those mocks leak
// across test files and break log-writer.test.ts and client.test.ts.

let insertedRows: any[] = [];

mock.module("@kcb/config", () => ({
  getConfig: () => ({
    bot: {
      dryRun: true,
      maxOpenPositions: 6,
      maxKellyFraction: 0.025,
      maxContractsPerOrder: 15,
      minContractPrice: 15,
      exitCooldownTicks: 3,
      maxExposurePerTicker: 500,
    },
  }),
}));

let exposureTotal = 0;
const mockResult: any = {
  where: () => mockResult,
  limit: () => mockResult,
  then: (resolve: any) => resolve([]),
};
const mockExposureResult: any = {
  where: () => mockExposureResult,
  limit: () => mockExposureResult,
  then: (resolve: any) => resolve([{ total: exposureTotal }]),
};
mock.module("@kcb/db", () => ({
  getDb: () => ({
    select: (fields?: any) => {
      // If selecting a specific `total` field, return exposure mock
      if (fields && "total" in fields) {
        return { from: () => mockExposureResult };
      }
      return { from: () => mockResult };
    },
    insert: () => ({
      values: (row: any) => {
        insertedRows.push(row);
        return Promise.resolve();
      },
    }),
  }),
  orders: {},
  positions: {},
  signals: {},
  eq: () => {},
  and: () => {},
  sql: Object.assign((..._args: any[]) => ({}), { raw: () => ({}) }),
}));

import { ExecutionService, computeKelly, recordExit, tickCooldowns, getCooldown, resetCooldowns } from "./execution";
import { bus } from "@kcb/engine";

// Stub client passed via DI — avoids mocking @kcb/kalshi-client globally
const stubKalshi = {
  createOrder: () => Promise.resolve({ order: { order_id: "live-123" } }),
} as any;

beforeEach(() => {
  insertedRows.length = 0;
  exposureTotal = 0;
  resetCooldowns();
});

describe("computeKelly", () => {
  test("no edge (prob ≈ market price) returns ~0", () => {
    const result = computeKelly(0.5, 0.5, "yes");
    expect(result).toBeCloseTo(0, 5);
  });

  test("positive edge on YES side returns positive fraction", () => {
    // We think prob=0.7 but market says 0.5 → positive edge
    const result = computeKelly(0.7, 0.5, "yes");
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  test("negative edge returns 0 (clamped)", () => {
    // We think prob=0.3 but market says 0.5 → negative edge for YES
    const result = computeKelly(0.3, 0.5, "yes");
    expect(result).toBe(0);
  });

  test("NO side flips prob and cost correctly", () => {
    // We think prob of YES = 0.3, so prob of NO = 0.7
    // Market price for YES = 0.5, so cost of NO = 0.5
    // This is equivalent to YES side with p=0.7, cost=0.5
    const noResult = computeKelly(0.3, 0.5, "no");
    const yesEquivalent = computeKelly(0.7, 0.5, "yes");
    expect(noResult).toBeCloseTo(yesEquivalent, 10);
  });

  test("strong edge yields larger fraction", () => {
    const weakEdge = computeKelly(0.55, 0.5, "yes");
    const strongEdge = computeKelly(0.8, 0.5, "yes");
    expect(strongEdge).toBeGreaterThan(weakEdge);
  });

  test("prob near 1 with low market price yields high fraction", () => {
    const result = computeKelly(0.95, 0.1, "yes");
    expect(result).toBeGreaterThan(0.5);
  });

  test("prob near 0 on YES side yields 0", () => {
    const result = computeKelly(0.05, 0.5, "yes");
    expect(result).toBe(0);
  });

  test("price near 1 with moderate prob yields 0 (no edge)", () => {
    // Market already prices it at 0.95, we think 0.8 → negative edge
    const result = computeKelly(0.8, 0.95, "yes");
    expect(result).toBe(0);
  });
});

describe("ExecutionService.executeExit", () => {
  test("dry-run exit inserts a filled sell order", async () => {
    const service = new ExecutionService(stubKalshi);
    const position = {
      ticker: "KXTEMP-26FEB25-NYC-B40",
      side: "yes",
      quantity: 5,
      avgEntryPrice: 60,
      costBasis: 300,
      marketValue: 250,
      unrealizedPnl: -50,
      openedAt: "2026-02-20T00:00:00Z",
      updatedAt: "2026-02-25T00:00:00Z",
    };

    const orderId = await service.executeExit(position as any, "edge reversal", 55);

    expect(orderId).toBeString();
    expect(orderId).toStartWith("dry-exit-");

    // Should have inserted one order row
    const row = insertedRows.findLast((r: any) => r.orderId === orderId);
    expect(row).toBeDefined();
    expect(row.ticker).toBe("KXTEMP-26FEB25-NYC-B40");
    expect(row.action).toBe("sell");
    expect(row.side).toBe("yes");
    expect(row.quantity).toBe(5);
    expect(row.filledQuantity).toBe(5);
    expect(row.status).toBe("filled");
    expect(row.dryRun).toBe(true);
    // Exit orders are tagged with a signalId for PnL attribution
    expect(row.signalId).toBe("bot-exit");
    // YES side: price = currentYesPrice - 1 = 54
    expect(row.limitPrice).toBe(54);
  });

  test("dry-run exit emits order:placed with action sell", async () => {
    const service = new ExecutionService(stubKalshi);
    const emittedEvents: any[] = [];
    const unsub = bus.on("order:placed", (data) => {
      emittedEvents.push(data);
    });

    const position = {
      ticker: "KXTEMP-26FEB25-NYC-B40",
      side: "no",
      quantity: 3,
      avgEntryPrice: 45,
      costBasis: 135,
      marketValue: 120,
      unrealizedPnl: -15,
      openedAt: "2026-02-20T00:00:00Z",
      updatedAt: "2026-02-25T00:00:00Z",
    };

    // currentYesPrice=60 → NO side price = (100-60) - 1 = 39
    await service.executeExit(position as any, "stop-loss", 60);
    unsub();

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].action).toBe("sell");
    expect(emittedEvents[0].side).toBe("no");
    expect(emittedEvents[0].quantity).toBe(3);
    expect(emittedEvents[0].price).toBe(39);
    expect(emittedEvents[0].dryRun).toBe(true);
  });

  test("dry-run exit prices 1¢ below current market", async () => {
    const service = new ExecutionService(stubKalshi);
    const startLen = insertedRows.length;
    const position = {
      ticker: "KXTEMP-26FEB25-NYC-B40",
      side: "yes",
      quantity: 10,
      avgEntryPrice: 72.5,
      costBasis: 725,
      marketValue: 600,
      unrealizedPnl: -125,
      openedAt: "2026-02-20T00:00:00Z",
      updatedAt: "2026-02-25T00:00:00Z",
    };

    // currentYesPrice=45 → YES side: 45 - 1 = 44
    await service.executeExit(position as any, "time decay", 45);

    const row = insertedRows[startLen];
    expect(row.limitPrice).toBe(44);
  });
});

// Helper signal for anti-churn tests
function makeSignal(overrides: Partial<any> = {}): any {
  return {
    id: "sig-1",
    ticker: "KXHIGHNY-26MAR04-B40",
    seriesTicker: "KXHIGHNY",
    estimatedProb: 0.7,
    confidence: 0.8,
    marketPrice: 0.5,
    edge: 0.2,
    edgeThreshold: 0.15,
    recommendation: "buy_yes",
    side: "yes",
    kellyFraction: 0.02,
    ensembleSize: 5,
    reasoning: "test",
    acted: false,
    orderId: null,
    skipReason: null,
    createdAt: "2026-03-04T00:00:00Z",
    ...overrides,
  };
}

describe("executeSignal anti-churn guards", () => {
  test("skips contract priced below minContractPrice", async () => {
    const service = new ExecutionService(stubKalshi);
    // estimatedProb=0.9, marketPrice=0.08 → YES side price = 8¢ < 15¢ min
    const signal = makeSignal({
      estimatedProb: 0.9,
      marketPrice: 0.08,
      edge: 0.82,
      side: "yes",
    });

    const orderId = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull();
  });

  test("skips ticker with active cooldown", async () => {
    const service = new ExecutionService(stubKalshi);
    const signal = makeSignal();

    // Set cooldown for this ticker
    recordExit(signal.ticker);
    expect(getCooldown(signal.ticker)).toBe(3);

    const orderId = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull();
  });

  test("cooldown decrements and clears", () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    recordExit(ticker);
    expect(getCooldown(ticker)).toBe(3);

    tickCooldowns();
    expect(getCooldown(ticker)).toBe(2);

    tickCooldowns();
    expect(getCooldown(ticker)).toBe(1);

    tickCooldowns();
    expect(getCooldown(ticker)).toBe(0);
  });

  test("skips when accumulated exposure would exceed limit", async () => {
    const service = new ExecutionService(stubKalshi);
    // Existing exposure of 490¢ + new order would exceed 500¢
    exposureTotal = 490;
    const signal = makeSignal();

    const orderId = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull();
  });

  test("allows trade when all guards pass", async () => {
    const service = new ExecutionService(stubKalshi);
    exposureTotal = 0;
    const signal = makeSignal();

    const orderId = await service.executeSignal(signal, 10000);
    expect(orderId).toBeString();
    expect(orderId).toStartWith("dry-");
  });
});
