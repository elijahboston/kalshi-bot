import { test, expect, describe, mock, beforeEach } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────
// Only mock @kcb/config — it's safe and doesn't leak harmfully.
// DO NOT mock @kcb/db — it leaks drizzle-orm internals (sql, count, migrate)
// and breaks api.test.ts, ws-bridge.test.ts, and performance-query.test.ts.
// DO NOT mock @kcb/engine or @kcb/kalshi-client — those leak too.

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

import { getDb, runMigrations, orders, positions } from "@kcb/db";
import { ExecutionService, computeKelly, recordExit, tickCooldowns, getCooldown, resetCooldowns } from "./execution";
import { bus } from "@kcb/engine";
import { eq, sql } from "drizzle-orm";

// Use real in-memory DB
runMigrations();

// Stub client passed via DI — avoids mocking @kcb/kalshi-client globally
const stubKalshi = {
  createOrder: () => Promise.resolve({ order: { order_id: "live-123" } }),
} as any;

beforeEach(async () => {
  resetCooldowns();
  // Clean tables between tests
  const db = getDb();
  db.delete(orders).run();
  db.delete(positions).run();
});

describe("computeKelly", () => {
  test("no edge (prob ≈ market price) returns ~0", () => {
    const result = computeKelly(0.5, 0.5, "yes");
    expect(result).toBeCloseTo(0, 5);
  });

  test("positive edge on YES side returns positive fraction", () => {
    const result = computeKelly(0.7, 0.5, "yes");
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  test("negative edge returns 0 (clamped)", () => {
    const result = computeKelly(0.3, 0.5, "yes");
    expect(result).toBe(0);
  });

  test("NO side flips prob and cost correctly", () => {
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

    // Verify order was inserted in DB
    const db = getDb();
    const rows = db.select().from(orders).where(eq(orders.orderId, orderId!)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].ticker).toBe("KXTEMP-26FEB25-NYC-B40");
    expect(rows[0].action).toBe("sell");
    expect(rows[0].side).toBe("yes");
    expect(rows[0].quantity).toBe(5);
    expect(rows[0].filledQuantity).toBe(5);
    expect(rows[0].status).toBe("filled");
    expect(rows[0].dryRun).toBe(true);
    expect(rows[0].signalId).toBe("bot-exit");
    // YES side: price = currentYesPrice - 1 = 54
    expect(rows[0].limitPrice).toBe(54);
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
    const orderId = await service.executeExit(position as any, "time decay", 45);

    const db = getDb();
    const rows = db.select().from(orders).where(eq(orders.orderId, orderId!)).all();
    expect(rows[0].limitPrice).toBe(44);
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

  test("skips when recently filled buy order exists for same ticker", async () => {
    const service = new ExecutionService(stubKalshi);
    const db = getDb();
    db.insert(orders).values({
      orderId: "filled-recent",
      ticker: "KXHIGHNY-26MAR04-B40",
      action: "buy",
      side: "yes",
      limitPrice: 50,
      quantity: 10,
      filledQuantity: 10,
      status: "filled",
      signalId: "sig-1",
      dryRun: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    const signal = makeSignal();
    const orderId = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull();
  });

  test("skips when accumulated exposure would exceed limit", async () => {
    const service = new ExecutionService(stubKalshi);
    // Insert an open position to create exposure near the limit
    const db = getDb();
    db.insert(positions).values({
      ticker: "KXHIGHNY-26MAR04-B40",
      side: "yes",
      quantity: 10,
      avgEntryPrice: 50,
      costBasis: 500,
      marketValue: 500,
      unrealizedPnl: 0,
      openedAt: "2026-03-04T00:00:00Z",
      updatedAt: "2026-03-04T00:00:00Z",
    }).run();

    const signal = makeSignal();
    const orderId = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull();
  });

  test("allows trade when all guards pass", async () => {
    const service = new ExecutionService(stubKalshi);
    const signal = makeSignal();

    const orderId = await service.executeSignal(signal, 10000);
    expect(orderId).toBeString();
    expect(orderId).toStartWith("dry-");
  });
});
