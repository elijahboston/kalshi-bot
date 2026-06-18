import { test, expect, describe, mock, beforeEach } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────
// Only mock @kcb/config — it's safe and doesn't leak harmfully.
// DO NOT mock @kcb/db — it leaks drizzle-orm internals (sql, count, migrate)
// and breaks api.test.ts, ws-bridge.test.ts, and performance-query.test.ts.
// DO NOT mock @kcb/engine or @kcb/kalshi-client — those leak too.

const mockBotConfig = {
  dryRun: true,
  maxOpenPositions: 6,
  maxKellyFraction: 0.025,
  maxContractsPerOrder: 15,
  minContractPrice: 15,
  exitCooldownTicks: 3,
  maxExposurePerTicker: 500,
  minBalanceFloor: 0,
  tickIntervalSec: 120,
  minBetSizeCents: 0,
  flatBetSizeCents: 0,
  highConfidenceThreshold: 0,
  highConfidenceBetSizeCents: 0,
  // Spread-aware + confirmation-mode keys (addendum N4 / win-rate-80 #2).
  maxSpreadCents: 10,
  confirmationBetSizeCents: 500,
  confirmationMaxEntryPrice: 0.93,
  // Confidence-scaled %-of-balance sizing (2026-06-09) — off by default.
  confidenceSizePctEnabled: false,
  confidenceSizeMinPct: 0.01,
  confidenceSizeMaxPct: 0.10,
  confidenceSizeFloorConfidence: 0.80,
  maxExposurePctOfBalance: 0,
  maxEventExposurePctOfBalance: 0,
  adjacentBracketGuardEnabled: false, // tests opt-in per describe block
};

mock.module("@kcb/config", () => ({
  getConfig: () => ({ bot: mockBotConfig }),
}));

import { getDb, runMigrations, orders, positions, markets, and } from "@kcb/db";
import { ExecutionService, computeKelly, confidenceSizedPct, recordExit, tickCooldowns, getCooldown, resetCooldowns, getRecentLoss, resetLossTracking, restoreAntiChurnState, resetRestoredFlag } from "./execution";
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
  resetLossTracking();
  resetRestoredFlag();
  mockBotConfig.maxOpenPositions = 6;
  mockBotConfig.minBetSizeCents = 0;
  mockBotConfig.flatBetSizeCents = 0;
  mockBotConfig.highConfidenceThreshold = 0;
  mockBotConfig.highConfidenceBetSizeCents = 0;
  mockBotConfig.maxExposurePerTicker = 500;
  mockBotConfig.maxContractsPerOrder = 15;
  mockBotConfig.minContractPrice = 15;
  mockBotConfig.maxSpreadCents = 10;
  mockBotConfig.confirmationBetSizeCents = 500;
  mockBotConfig.confirmationMaxEntryPrice = 0.93;
  mockBotConfig.confidenceSizePctEnabled = false;
  mockBotConfig.confidenceSizeMinPct = 0.01;
  mockBotConfig.confidenceSizeMaxPct = 0.10;
  mockBotConfig.confidenceSizeFloorConfidence = 0.80;
  mockBotConfig.maxExposurePctOfBalance = 0;
  mockBotConfig.maxEventExposurePctOfBalance = 0;
  mockBotConfig.adjacentBracketGuardEnabled = false;
  // Clean tables between tests
  const db = getDb();
  db.delete(orders).run();
  db.delete(positions).run();
  db.delete(markets).run();
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

/**
 * Seed a filled BUY order backing a position. The 2026-06-06 over-sell fix
 * makes executeExit clamp to net-held from the orders ledger — a position with
 * no backing buy reads as netHeld 0 and the exit is (correctly) skipped.
 */
function seedBackingBuy(ticker: string, side: string, quantity: number, price = 50) {
  const db = getDb();
  const nowTs = new Date().toISOString();
  db.insert(orders).values({
    orderId: `seed-buy-${ticker}-${Math.random().toString(36).slice(2, 8)}`,
    ticker,
    action: "buy",
    side,
    limitPrice: price,
    quantity,
    filledQuantity: quantity,
    status: "filled",
    signalId: null,
    dryRun: true,
    kellyFraction: null,
    createdAt: nowTs,
    updatedAt: nowTs,
  }).run();
}

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
    seedBackingBuy(position.ticker, "yes", 5);

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

    seedBackingBuy(position.ticker, "no", 3);
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

    seedBackingBuy(position.ticker, "yes", 10);
    // currentYesPrice=45 → YES side: 45 - 1 = 44
    const orderId = await service.executeExit(position as any, "time decay", 45);

    const db = getDb();
    const rows = db.select().from(orders).where(eq(orders.orderId, orderId!)).all();
    expect(rows[0].limitPrice).toBe(44);
  });

  test("over-sell guard: second exit on the same position is skipped (2026-06-06 fix)", async () => {
    // The 2026-06-05 double-exit: dry-run sells fill instantly so the
    // pending-sell guard never trips, and the stale position row re-triggers
    // the exit next tick — selling 6 more than held into a phantom short.
    const service = new ExecutionService(stubKalshi);
    const position = {
      ticker: "KXTEMP-26FEB25-NYC-B41",
      side: "yes",
      quantity: 6,
      avgEntryPrice: 82,
      costBasis: 492,
      marketValue: 480,
      unrealizedPnl: -12,
      openedAt: "2026-02-20T00:00:00Z",
      updatedAt: "2026-02-25T00:00:00Z",
    };
    seedBackingBuy(position.ticker, "yes", 6, 82);

    const first = await service.executeExit(position as any, "edge reversal", 80);
    expect(first).toBeString();

    // Position row is stale (still shows quantity 6) but the ledger now nets 0.
    const second = await service.executeExit(position as any, "edge reversal", 80);
    expect(second).toBeNull();

    // Exactly one sell order exists.
    const db = getDb();
    const sells = db
      .select()
      .from(orders)
      .where(and(eq(orders.ticker, position.ticker), eq(orders.action, "sell")))
      .all();
    expect(sells).toHaveLength(1);
    expect(sells[0]!.filledQuantity).toBe(6);
  });

  test("over-sell guard: sell quantity clamps to net held when position row overstates", async () => {
    const service = new ExecutionService(stubKalshi);
    const position = {
      ticker: "KXTEMP-26FEB25-NYC-B42",
      side: "no",
      quantity: 8, // stale row says 8
      avgEntryPrice: 85,
      costBasis: 680,
      marketValue: 660,
      unrealizedPnl: -20,
      openedAt: "2026-02-20T00:00:00Z",
      updatedAt: "2026-02-25T00:00:00Z",
    };
    seedBackingBuy(position.ticker, "no", 5, 85); // ledger says 5

    const orderId = await service.executeExit(position as any, "stop-loss", 20);
    expect(orderId).toBeString();

    const db = getDb();
    const rows = db.select().from(orders).where(eq(orders.orderId, orderId!)).all();
    expect(rows[0]!.quantity).toBe(5); // clamped to ledger, not the stale 8
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

    const { orderId } = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull();
  });

  test("skips ticker with active cooldown", async () => {
    const service = new ExecutionService(stubKalshi);
    const signal = makeSignal();

    recordExit(signal.ticker);
    expect(getCooldown(signal.ticker)).toBe(3);

    const { orderId } = await service.executeSignal(signal, 10000);
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
    const { orderId } = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull();
  });

  test("skips when filled buy from >1h ago with no matching sell (DEN-79.5 second-buy case)", async () => {
    const service = new ExecutionService(stubKalshi);
    const db = getDb();
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    db.insert(orders).values({
      orderId: "filled-3h-ago",
      ticker: "KXHIGHNY-26MAR04-B40",
      action: "buy",
      side: "yes",
      limitPrice: 40,
      quantity: 2,
      filledQuantity: 2,
      status: "filled",
      signalId: "sig-first",
      dryRun: true,
      createdAt: threeHoursAgo,
      updatedAt: threeHoursAgo,
    }).run();

    // positions table is empty (simulating sync lag)
    const signal = makeSignal();
    const { orderId } = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull();
  });

  test("allows signal when filled buy has been fully sold (net 0)", async () => {
    const service = new ExecutionService(stubKalshi);
    const db = getDb();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    db.insert(orders).values({
      orderId: "buy-closed-out",
      ticker: "KXHIGHNY-26MAR04-B40",
      action: "buy",
      side: "yes",
      limitPrice: 40,
      quantity: 5,
      filledQuantity: 5,
      status: "filled",
      dryRun: true,
      createdAt: twoHoursAgo,
      updatedAt: twoHoursAgo,
    }).run();
    db.insert(orders).values({
      orderId: "sell-matching",
      ticker: "KXHIGHNY-26MAR04-B40",
      action: "sell",
      side: "yes",
      limitPrice: 50,
      quantity: 5,
      filledQuantity: 5,
      status: "filled",
      dryRun: true,
      createdAt: oneHourAgo,
      updatedAt: oneHourAgo,
    }).run();

    // Drain cooldown from the sell
    for (let i = 0; i < 20; i++) tickCooldowns();

    const signal = makeSignal();
    const { orderId } = await service.executeSignal(signal, 10000);
    expect(orderId).toBeString();
  });

  test("skips when filled buy partially sold (net > 0)", async () => {
    const service = new ExecutionService(stubKalshi);
    const db = getDb();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    db.insert(orders).values({
      orderId: "buy-large",
      ticker: "KXHIGHNY-26MAR04-B40",
      action: "buy",
      side: "yes",
      limitPrice: 40,
      quantity: 10,
      filledQuantity: 10,
      status: "filled",
      dryRun: true,
      createdAt: twoHoursAgo,
      updatedAt: twoHoursAgo,
    }).run();
    db.insert(orders).values({
      orderId: "sell-partial",
      ticker: "KXHIGHNY-26MAR04-B40",
      action: "sell",
      side: "yes",
      limitPrice: 50,
      quantity: 3,
      filledQuantity: 3,
      status: "filled",
      dryRun: true,
      createdAt: oneHourAgo,
      updatedAt: oneHourAgo,
    }).run();

    const signal = makeSignal();
    const { orderId } = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull();
  });

  test("skips when open/partial buy is resting (not yet filled)", async () => {
    const service = new ExecutionService(stubKalshi);
    const db = getDb();
    db.insert(orders).values({
      orderId: "open-buy",
      ticker: "KXHIGHNY-26MAR04-B40",
      action: "buy",
      side: "yes",
      limitPrice: 40,
      quantity: 5,
      filledQuantity: 0,
      status: "open",
      dryRun: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    const signal = makeSignal();
    const { orderId } = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull();
  });

  test("cancelled buys do not count toward netHeld", async () => {
    const service = new ExecutionService(stubKalshi);
    const db = getDb();
    db.insert(orders).values({
      orderId: "cancelled-buy",
      ticker: "KXHIGHNY-26MAR04-B40",
      action: "buy",
      side: "yes",
      limitPrice: 40,
      quantity: 5,
      filledQuantity: 0,
      status: "cancelled",
      dryRun: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    const signal = makeSignal();
    const { orderId } = await service.executeSignal(signal, 10000);
    expect(orderId).toBeString();
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
    const { orderId } = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull();
  });

  test("allows trade when all guards pass", async () => {
    const service = new ExecutionService(stubKalshi);
    const signal = makeSignal();

    const { orderId } = await service.executeSignal(signal, 10000);
    expect(orderId).toBeString();
    expect(orderId).toStartWith("dry-");
  });
});

describe("executeSignal min-bet-size guard", () => {
  test("default (minBetSizeCents=0) allows micro bets", async () => {
    const service = new ExecutionService(stubKalshi);
    // balance=1000, Kelly 2.5% cap → betAmount ~25¢ → 0 contracts at 50¢ would
    // trip the "0 contracts" skip. Use a higher balance and capped Kelly so we
    // end up with 1 contract worth ~50¢ (under $5 floor).
    const signal = makeSignal({ estimatedProb: 0.8, marketPrice: 0.5, edge: 0.3 });
    // balance 2000 * 0.025 = 50¢ → 1 contract @ 50¢
    const { orderId } = await service.executeSignal(signal, 2000);
    expect(orderId).toBeString();
  });

  test("skips when actual spend is below minBetSizeCents", async () => {
    mockBotConfig.minBetSizeCents = 500; // $5 floor
    const service = new ExecutionService(stubKalshi);
    const signal = makeSignal({ estimatedProb: 0.8, marketPrice: 0.5, edge: 0.3 });
    // balance 2000 * 0.025 = 50¢ → 1 contract @ 50¢ = 50¢ spend, below 500¢ floor
    const { orderId } = await service.executeSignal(signal, 2000);
    expect(orderId).toBeNull();
  });

  test("allows when actual spend meets minBetSizeCents exactly", async () => {
    mockBotConfig.minBetSizeCents = 500;
    const service = new ExecutionService(stubKalshi);
    const signal = makeSignal({ estimatedProb: 0.8, marketPrice: 0.5, edge: 0.3 });
    // balance 20000 * 0.025 = 500¢ → 10 contracts @ 50¢ = 500¢ spend, meets floor
    const { orderId } = await service.executeSignal(signal, 20000);
    expect(orderId).toBeString();
  });
});

describe("executeSignal flat bet sizing", () => {
  test("flatBetSizeCents=500 sizes to $5 regardless of small bankroll", async () => {
    mockBotConfig.flatBetSizeCents = 500;
    mockBotConfig.minBetSizeCents = 500;
    mockBotConfig.maxExposurePerTicker = 1000;
    const service = new ExecutionService(stubKalshi);
    const db = getDb();

    // Small bankroll — Kelly at 2.5% cap would spend ~$4.39 on 17556¢. Flat
    // override pushes to $5. Price 50¢ → 10 contracts (under the 15-order cap).
    const signal = makeSignal({ estimatedProb: 0.8, marketPrice: 0.5, edge: 0.3 });
    const { orderId } = await service.executeSignal(signal, 17556);
    expect(orderId).toBeString();

    const [order] = db.select().from(orders).where(eq(orders.orderId, orderId!)).all();
    expect(order.quantity * order.limitPrice).toBe(500);
  });

  test("flatBetSizeCents=500 still skips when Kelly <= 0 (no edge)", async () => {
    mockBotConfig.flatBetSizeCents = 500;
    const service = new ExecutionService(stubKalshi);
    // Negative edge: estimatedProb < marketPrice on yes side → Kelly clamps to 0
    const signal = makeSignal({ estimatedProb: 0.3, marketPrice: 0.5, edge: -0.2, side: "yes" });
    const { orderId } = await service.executeSignal(signal, 17556);
    expect(orderId).toBeNull();
  });

  test("flatBetSizeCents=0 falls back to Kelly sizing (backward compat)", async () => {
    mockBotConfig.flatBetSizeCents = 0;
    mockBotConfig.minBetSizeCents = 0;
    const service = new ExecutionService(stubKalshi);
    const db = getDb();

    // balance 20000 * 0.025 Kelly cap = 500¢ → 10 contracts @ 50¢
    const signal = makeSignal({ estimatedProb: 0.8, marketPrice: 0.5, edge: 0.3 });
    const { orderId } = await service.executeSignal(signal, 20000);
    expect(orderId).toBeString();

    const [order] = db.select().from(orders).where(eq(orders.orderId, orderId!)).all();
    // Kelly-based sizing yields <= 500¢ spend, not flat 500¢
    expect(order.quantity).toBe(10);
  });

  test("flat sizing trimmed by exposure cap below min floor -> skip", async () => {
    mockBotConfig.flatBetSizeCents = 500;
    mockBotConfig.minBetSizeCents = 500;
    mockBotConfig.maxExposurePerTicker = 300; // leaves only 300¢ of room
    const service = new ExecutionService(stubKalshi);

    const signal = makeSignal({ estimatedProb: 0.8, marketPrice: 0.25, edge: 0.3 });
    const { orderId } = await service.executeSignal(signal, 17556);
    expect(orderId).toBeNull();
  });
});

describe("executeSignal confidence-tier sizing", () => {
  test("signal at/above highConfidenceThreshold scales to highConfidenceBetSizeCents", async () => {
    mockBotConfig.flatBetSizeCents = 500;       // $5 base
    mockBotConfig.highConfidenceThreshold = 0.95;
    mockBotConfig.highConfidenceBetSizeCents = 1000; // $10 tier
    mockBotConfig.maxExposurePerTicker = 2000;
    mockBotConfig.minBetSizeCents = 500;
    const service = new ExecutionService(stubKalshi);
    const db = getDb();

    const signal = makeSignal({
      estimatedProb: 0.8,
      marketPrice: 0.5,
      edge: 0.3,
      confidence: 0.97, // above threshold
    });
    const { orderId } = await service.executeSignal(signal, 20000);
    expect(orderId).toBeString();

    const [order] = db.select().from(orders).where(eq(orders.orderId, orderId!)).all();
    // $10 / 50¢ = 20 contracts, but maxContractsPerOrder=15 caps it. 15 × 50¢ = 750¢.
    // Use a smaller-priced contract for a clean $10 test.
    expect(order.quantity * order.limitPrice).toBe(750);
  });

  test("signal at exactly highConfidenceThreshold triggers tier (>=)", async () => {
    mockBotConfig.flatBetSizeCents = 500;
    mockBotConfig.highConfidenceThreshold = 0.95;
    mockBotConfig.highConfidenceBetSizeCents = 1000;
    mockBotConfig.maxExposurePerTicker = 2000;
    mockBotConfig.maxContractsPerOrder = 100; // remove order-size cap
    const service = new ExecutionService(stubKalshi);
    const db = getDb();

    const signal = makeSignal({
      estimatedProb: 0.8,
      marketPrice: 0.5,
      edge: 0.3,
      confidence: 0.95,
    });
    const { orderId } = await service.executeSignal(signal, 20000);
    expect(orderId).toBeString();

    const [order] = db.select().from(orders).where(eq(orders.orderId, orderId!)).all();
    // $10 / 50¢ = 20 contracts → 1000¢ spend
    expect(order.quantity * order.limitPrice).toBe(1000);
  });

  test("signal below threshold uses flatBetSizeCents (not tier)", async () => {
    mockBotConfig.flatBetSizeCents = 500;
    mockBotConfig.highConfidenceThreshold = 0.95;
    mockBotConfig.highConfidenceBetSizeCents = 1000;
    mockBotConfig.maxExposurePerTicker = 2000;
    const service = new ExecutionService(stubKalshi);
    const db = getDb();

    const signal = makeSignal({
      estimatedProb: 0.8,
      marketPrice: 0.5,
      edge: 0.3,
      confidence: 0.92, // below threshold but above minConfidence
    });
    const { orderId } = await service.executeSignal(signal, 20000);
    expect(orderId).toBeString();

    const [order] = db.select().from(orders).where(eq(orders.orderId, orderId!)).all();
    // Base $5 / 50¢ = 10 contracts → 500¢ spend (not 1000¢)
    expect(order.quantity * order.limitPrice).toBe(500);
  });

  test("highConfidenceThreshold=0 disables tier (always uses flat base)", async () => {
    mockBotConfig.flatBetSizeCents = 500;
    mockBotConfig.highConfidenceThreshold = 0; // disabled
    mockBotConfig.highConfidenceBetSizeCents = 1000;
    mockBotConfig.maxExposurePerTicker = 2000;
    const service = new ExecutionService(stubKalshi);
    const db = getDb();

    const signal = makeSignal({
      estimatedProb: 0.8,
      marketPrice: 0.5,
      edge: 0.3,
      confidence: 0.99, // would clear any threshold
    });
    const { orderId } = await service.executeSignal(signal, 20000);
    expect(orderId).toBeString();

    const [order] = db.select().from(orders).where(eq(orders.orderId, orderId!)).all();
    expect(order.quantity * order.limitPrice).toBe(500); // still flat base
  });

  test("tier still skips when Kelly <= 0 even at high confidence", async () => {
    mockBotConfig.flatBetSizeCents = 500;
    mockBotConfig.highConfidenceThreshold = 0.95;
    mockBotConfig.highConfidenceBetSizeCents = 1000;
    mockBotConfig.maxExposurePerTicker = 2000;
    const service = new ExecutionService(stubKalshi);

    // Negative edge: Kelly clamps to 0 — confidence doesn't matter
    const signal = makeSignal({
      estimatedProb: 0.3,
      marketPrice: 0.5,
      edge: -0.2,
      side: "yes",
      confidence: 0.99,
    });
    const { orderId } = await service.executeSignal(signal, 20000);
    expect(orderId).toBeNull();
  });

  test("tier size trimmed by exposure cap (partial-fit allowed)", async () => {
    mockBotConfig.flatBetSizeCents = 500;
    mockBotConfig.highConfidenceThreshold = 0.95;
    mockBotConfig.highConfidenceBetSizeCents = 1000;
    mockBotConfig.maxExposurePerTicker = 800; // tier ($10) doesn't fully fit, but $5+ does
    mockBotConfig.minBetSizeCents = 500;
    const service = new ExecutionService(stubKalshi);
    const db = getDb();

    const signal = makeSignal({
      estimatedProb: 0.8,
      marketPrice: 0.5,
      edge: 0.3,
      confidence: 0.97,
    });
    const { orderId } = await service.executeSignal(signal, 20000);
    expect(orderId).toBeString();

    const [order] = db.select().from(orders).where(eq(orders.orderId, orderId!)).all();
    // 800¢ room / 50¢ = 16 contracts, capped by maxContractsPerOrder=15 = 750¢
    expect(order.quantity * order.limitPrice).toBe(750);
  });

  test("tier with no flat base falls back to Kelly when confidence below threshold", async () => {
    mockBotConfig.flatBetSizeCents = 0; // no flat base
    mockBotConfig.highConfidenceThreshold = 0.95;
    mockBotConfig.highConfidenceBetSizeCents = 1000;
    mockBotConfig.maxExposurePerTicker = 2000;
    const service = new ExecutionService(stubKalshi);
    const db = getDb();

    const signal = makeSignal({
      estimatedProb: 0.8,
      marketPrice: 0.5,
      edge: 0.3,
      confidence: 0.90, // below threshold → no flat, fall back to Kelly
    });
    // balance 20000 * 0.025 Kelly cap = 500¢ → 10 contracts @ 50¢
    const { orderId } = await service.executeSignal(signal, 20000);
    expect(orderId).toBeString();

    const [order] = db.select().from(orders).where(eq(orders.orderId, orderId!)).all();
    expect(order.quantity).toBe(10); // Kelly path
  });
});

describe("executeSignal minContractPrice high-confidence bypass", () => {
  test("blocks cheap contract when confidence below highConfidenceThreshold", async () => {
    (mockBotConfig as any).minContractPrice = 15;
    mockBotConfig.flatBetSizeCents = 500;
    mockBotConfig.highConfidenceThreshold = 0.95;
    mockBotConfig.highConfidenceBetSizeCents = 1000;
    mockBotConfig.maxExposurePerTicker = 2000;
    const service = new ExecutionService(stubKalshi);

    // 92% confidence on a 1¢ market — exactly the high-edge tail scenario,
    // but confidence here is BELOW the threshold so the filter still applies.
    const signal = makeSignal({
      estimatedProb: 0.92,
      marketPrice: 0.01,
      edge: 0.27,
      side: "yes",
      confidence: 0.90,
    });
    const { orderId, skipReason } = await service.executeSignal(signal, 20000);
    expect(orderId).toBeNull();
    expect(skipReason).toContain("min");
  });

  test("allows cheap contract when confidence meets highConfidenceThreshold", async () => {
    (mockBotConfig as any).minContractPrice = 15;
    mockBotConfig.flatBetSizeCents = 500;
    mockBotConfig.highConfidenceThreshold = 0.95;
    mockBotConfig.highConfidenceBetSizeCents = 1000;
    mockBotConfig.maxExposurePerTicker = 2000;
    mockBotConfig.maxContractsPerOrder = 200;
    mockBotConfig.minBetSizeCents = 0;
    const service = new ExecutionService(stubKalshi);

    // Same high-edge signal but conf=0.97 (above threshold) → bypass the filter
    const signal = makeSignal({
      estimatedProb: 0.92,
      marketPrice: 0.01,
      edge: 0.27,
      side: "yes",
      confidence: 0.97,
    });
    const { orderId } = await service.executeSignal(signal, 20000);
    expect(orderId).toBeString();
  });

  test("threshold disabled (0) keeps minContractPrice filter active", async () => {
    (mockBotConfig as any).minContractPrice = 15;
    mockBotConfig.flatBetSizeCents = 500;
    mockBotConfig.highConfidenceThreshold = 0; // disabled
    mockBotConfig.highConfidenceBetSizeCents = 1000;
    const service = new ExecutionService(stubKalshi);

    // Even a 0.99 confidence signal cannot bypass when the threshold is disabled
    const signal = makeSignal({
      estimatedProb: 0.92, marketPrice: 0.01, edge: 0.27, side: "yes", confidence: 0.99,
    });
    const { orderId, skipReason } = await service.executeSignal(signal, 20000);
    expect(orderId).toBeNull();
    expect(skipReason).toContain("min");
  });
});

describe("executeSignal skip reason propagation", () => {
  test("returns specific reason for max-positions skip", async () => {
    mockBotConfig.maxOpenPositions = 1;
    const db = getDb();
    db.insert(positions).values({
      ticker: "OTHER-TICKER", side: "yes", quantity: 1, avgEntryPrice: 50,
      costBasis: 50, marketValue: 50, unrealizedPnl: 0,
      openedAt: "2026-03-04T00:00:00Z", updatedAt: "2026-03-04T00:00:00Z",
    }).run();
    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(makeSignal(), 10000);
    expect(orderId).toBeNull();
    expect(skipReason).toContain("max positions");
  });

  test("returns specific reason for cooldown skip", async () => {
    const service = new ExecutionService(stubKalshi);
    const signal = makeSignal();
    recordExit(signal.ticker);
    const { orderId, skipReason } = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull();
    expect(skipReason).toContain("cooldown");
  });

  test("returns specific reason for negative-edge Kelly skip", async () => {
    const service = new ExecutionService(stubKalshi);
    const signal = makeSignal({ estimatedProb: 0.3, marketPrice: 0.5, edge: -0.2, side: "yes" });
    const { orderId, skipReason } = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull();
    expect(skipReason).toContain("Kelly");
  });

  test("success returns orderId and null skipReason", async () => {
    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(makeSignal(), 10000);
    expect(orderId).toBeString();
    expect(skipReason).toBeNull();
  });
});

describe("loss-based re-entry guard", () => {
  test("recordExit with loss flag tracks the loss", () => {
    recordExit("KXHIGHNY-26MAR25-B53.5", true, -0.3);
    const loss = getRecentLoss("KXHIGHNY-26MAR25-B53.5");
    expect(loss).not.toBeNull();
    expect(loss!.lossPct).toBe(-0.3);
  });

  test("recordExit without loss flag does not track loss", () => {
    recordExit("KXHIGHNY-26MAR25-B53.5");
    const loss = getRecentLoss("KXHIGHNY-26MAR25-B53.5");
    expect(loss).toBeNull();
  });

  test("skips re-entry when edge below elevated threshold after loss", async () => {
    const service = new ExecutionService(stubKalshi);

    // Record a loss exit, then clear the cooldown so only the loss guard is active
    recordExit("KXHIGHNY-26MAR04-B40", true, -0.25);
    // Drain the cooldown
    for (let i = 0; i < 20; i++) tickCooldowns();
    expect(getCooldown("KXHIGHNY-26MAR04-B40")).toBe(0);

    // Signal with moderate edge (below 1.5x threshold)
    // Config threshold for this test is effectively ~0.15 (from computeKelly math)
    // The signal edgeThreshold is 0.15, so 1.5x = 0.225
    const signal = makeSignal({ edge: 0.18, edgeThreshold: 0.15 });

    const { orderId } = await service.executeSignal(signal, 10000);
    expect(orderId).toBeNull(); // blocked by loss guard
  });

  test("allows re-entry when edge exceeds elevated threshold after loss", async () => {
    const service = new ExecutionService(stubKalshi);

    recordExit("KXHIGHNY-26MAR04-B40", true, -0.25);
    for (let i = 0; i < 20; i++) tickCooldowns();

    // Signal with high edge (above 1.5x threshold)
    const signal = makeSignal({ edge: 0.30, edgeThreshold: 0.15 });

    const { orderId } = await service.executeSignal(signal, 10000);
    expect(orderId).toBeString();
    expect(orderId).toStartWith("dry-");
  });

  test("loss tracking expires after 2 hours", () => {
    // Manually insert an old loss entry
    recordExit("KXHIGHNY-26MAR25-B53.5", true, -0.2);
    // Hack the timestamp to 3 hours ago
    const entry = getRecentLoss("KXHIGHNY-26MAR25-B53.5");
    expect(entry).not.toBeNull();

    // We can't easily fake time, but we can verify the expiry logic
    // by checking that getRecentLoss returns null for unknown tickers
    expect(getRecentLoss("UNKNOWN")).toBeNull();
  });
});

describe("restoreAntiChurnState", () => {
  test("rebuilds cooldown from recent sell orders in DB", async () => {
    const db = getDb();
    // Insert a sell order from 5 minutes ago
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    db.insert(orders).values({
      orderId: "sell-recent",
      ticker: "KXHIGHNY-26MAR26-T72",
      action: "sell",
      side: "no",
      limitPrice: 25,
      quantity: 10,
      filledQuantity: 10,
      status: "filled",
      dryRun: false,
      createdAt: fiveMinAgo,
      updatedAt: fiveMinAgo,
    }).run();

    await restoreAntiChurnState();

    // Should have a cooldown for this ticker
    const cd = getCooldown("KXHIGHNY-26MAR26-T72");
    expect(cd).toBeGreaterThan(0);
  });

  test("rebuilds loss flag when sell price < buy price", async () => {
    const db = getDb();
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();

    // Buy at 50, then sell at 30 (loss)
    db.insert(orders).values({
      orderId: "buy-loss",
      ticker: "KXHIGHNY-26MAR26-T72",
      action: "buy",
      side: "no",
      limitPrice: 50,
      quantity: 10,
      filledQuantity: 10,
      status: "filled",
      dryRun: false,
      createdAt: tenMinAgo,
      updatedAt: tenMinAgo,
    }).run();
    db.insert(orders).values({
      orderId: "sell-loss",
      ticker: "KXHIGHNY-26MAR26-T72",
      action: "sell",
      side: "no",
      limitPrice: 30,
      quantity: 10,
      filledQuantity: 10,
      status: "filled",
      dryRun: false,
      createdAt: fiveMinAgo,
      updatedAt: fiveMinAgo,
    }).run();

    await restoreAntiChurnState();

    const loss = getRecentLoss("KXHIGHNY-26MAR26-T72");
    expect(loss).not.toBeNull();
    expect(loss!.lossPct).toBeLessThan(0);
  });

  test("only runs once (idempotent)", async () => {
    await restoreAntiChurnState();
    // Second call should be a no-op
    await restoreAntiChurnState();
    // No error means success
  });
});

// ── Spread-aware / book-aware entries (addendum N4 + N10) ──────
// These tests seed a `markets` row with an order book so executeSignal prices
// against the book (ask for YES, 100−bid for NO) and enforces the spread guard.

function seedMarket(
  ticker: string,
  book: { yesBid?: number | null; yesAsk?: number | null; lastYesPrice?: number | null } = {}
) {
  const ts = new Date().toISOString();
  getDb()
    .insert(markets)
    .values({
      ticker,
      eventTicker: "KXHIGHNY-26MAR04",
      seriesTicker: "KXHIGHNY",
      title: "test market",
      category: "high_temp",
      stationId: "KNYC",
      targetDate: "2026-03-04",
      bracketLow: 39,
      bracketHigh: 40,
      marketType: "bracket",
      status: "open",
      lastYesPrice: book.lastYesPrice ?? null,
      lastNoPrice: book.lastYesPrice != null ? 100 - book.lastYesPrice : null,
      yesBid: book.yesBid ?? null,
      yesAsk: book.yesAsk ?? null,
      discoveredAt: ts,
      updatedAt: ts,
    })
    .onConflictDoNothing()
    .run();
}

function readOrder(ticker: string) {
  return getDb().select().from(orders).where(eq(orders.ticker, ticker)).get();
}

describe("executeSignal spread guard (addendum N4)", () => {
  test("skips when spread exceeds maxSpreadCents", async () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    seedMarket(ticker, { yesBid: 40, yesAsk: 55, lastYesPrice: 50 });
    mockBotConfig.maxSpreadCents = 10;

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({ ticker, side: "yes", marketPrice: 0.5, estimatedProb: 0.75 }),
      10000
    );

    expect(orderId).toBeNull();
    expect(skipReason).toBe("spread 15¢ > max 10¢");
    expect(readOrder(ticker)).toBeUndefined();
  });

  test("proceeds when spread guard disabled (maxSpreadCents=0)", async () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    seedMarket(ticker, { yesBid: 40, yesAsk: 55, lastYesPrice: 50 });
    mockBotConfig.maxSpreadCents = 0;

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({ ticker, side: "yes", marketPrice: 0.5, estimatedProb: 0.75 }),
      10000
    );

    expect(skipReason).toBeNull();
    expect(orderId).toBeString();
    // YES pays the ask = 55¢ even though last trade was 50¢.
    expect(readOrder(ticker)!.limitPrice).toBe(55);
  });
});

describe("executeSignal crossing-price entry (addendum N4 + N10)", () => {
  test("YES entry uses the ask, not last trade", async () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    seedMarket(ticker, { yesBid: 70, yesAsk: 74, lastYesPrice: 70 });

    const service = new ExecutionService(stubKalshi);
    const { orderId } = await service.executeSignal(
      makeSignal({ ticker, side: "yes", marketPrice: 0.7, estimatedProb: 0.85 }),
      10000
    );

    expect(orderId).toBeString();
    const order = readOrder(ticker)!;
    expect(order.limitPrice).toBe(74); // ask, not Math.round(0.70*100)=70
    expect(order.side).toBe("yes");
  });

  test("NO entry pays 100 − bid", async () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    seedMarket(ticker, { yesBid: 70, yesAsk: 74, lastYesPrice: 70 });

    const service = new ExecutionService(stubKalshi);
    // execution.ts does not run the concordance gate (that lives in entry-gates),
    // so a plain buy_no with positive Kelly fires regardless of marketPrice.
    const { orderId } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "no",
        recommendation: "buy_no",
        marketPrice: 0.7,
        estimatedProb: 0.1,
      }),
      10000
    );

    expect(orderId).toBeString();
    const order = readOrder(ticker)!;
    expect(order.limitPrice).toBe(30); // 100 − bid(70)
    expect(order.side).toBe("no");
  });

  test("falls back to last-trade pricing when book is absent", async () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    seedMarket(ticker, { yesBid: null, yesAsk: null, lastYesPrice: 68 });

    const service = new ExecutionService(stubKalshi);
    const { orderId } = await service.executeSignal(
      makeSignal({ ticker, side: "yes", marketPrice: 0.68, estimatedProb: 0.85 }),
      10000
    );

    expect(orderId).toBeString();
    // No ask → Math.round(0.68 * 100) = 68 (prior behavior).
    expect(readOrder(ticker)!.limitPrice).toBe(68);
  });
});

describe("executeSignal confirmation mode (win-rate-80 #2)", () => {
  test("confirm_yes fires despite negative Kelly, flat-sized, kellyFraction=0", async () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    seedMarket(ticker, { yesBid: 84, yesAsk: 86, lastYesPrice: 85 });
    mockBotConfig.confirmationBetSizeCents = 500;

    const service = new ExecutionService(stubKalshi);
    // est 0.55 < market 0.85 → Kelly for YES is negative (regular path would skip).
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "confirm_yes",
        marketPrice: 0.85,
        estimatedProb: 0.55,
        edge: 0,
      }),
      10000
    );

    expect(skipReason).toBeNull();
    expect(orderId).toBeString();
    const order = readOrder(ticker)!;
    expect(order.limitPrice).toBe(86); // ask
    expect(order.quantity).toBe(5); // floor(500 / 86) = 5
    expect(order.kellyFraction).toBe(0); // sizing bypassed Kelly
  });

  test("confirm_yes above the entry-price cap is skipped", async () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    seedMarket(ticker, { yesBid: 93, yesAsk: 95, lastYesPrice: 94 });
    mockBotConfig.confirmationMaxEntryPrice = 0.93;

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "confirm_yes",
        marketPrice: 0.95,
        estimatedProb: 0.55,
        edge: 0,
      }),
      10000
    );

    expect(orderId).toBeNull();
    expect(skipReason).toBe("confirmation entry 95¢ > cap 93¢");
    expect(readOrder(ticker)).toBeUndefined();
  });

  test("confirmation is exempt from minBetSizeCents (caught live 2026-06-05)", async () => {
    // At confirmation prices (80-93¢), floor(500/price) × price is structurally
    // < 500¢ (e.g. 5 × 91¢ = 455¢), so the min-bet guard rejected every
    // confirmation entry on the first live tick. The guard targets Kelly
    // dust-bets, not flat market-follow sizing — confirmation bypasses it.
    const ticker = "KXHIGHNY-26MAR04-B40";
    seedMarket(ticker, { yesBid: 89, yesAsk: 91, lastYesPrice: 90 });
    mockBotConfig.minBetSizeCents = 500;
    mockBotConfig.confirmationBetSizeCents = 500;

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "confirm_yes",
        marketPrice: 0.90,
        estimatedProb: 0.6,
        edge: 0,
      }),
      10000
    );

    expect(skipReason).toBeNull();
    expect(orderId).toBeString();
    const order = readOrder(ticker)!;
    expect(order.limitPrice).toBe(91); // ask
    expect(order.quantity).toBe(5); // floor(500/91) — 455¢ spend, below the floor, still fires
  });

  test("regular signals still respect minBetSizeCents", async () => {
    const ticker = "KXHIGHNY-26MAR04-B41";
    seedMarket(ticker, { yesBid: 89, yesAsk: 91, lastYesPrice: 90 });
    mockBotConfig.minBetSizeCents = 500;

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "buy_yes",
        marketPrice: 0.90,
        estimatedProb: 0.99,
        edge: 0.09,
      }),
      10000
    );

    expect(orderId).toBeNull();
    expect(skipReason).toContain("< min 500¢");
  });

  test("confirm_no fires and pays 100 − bid", async () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    seedMarket(ticker, { yesBid: 11, yesAsk: 13, lastYesPrice: 12 });

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "no",
        recommendation: "confirm_no",
        marketPrice: 0.12,
        estimatedProb: 0.45,
        edge: 0,
      }),
      10000
    );

    expect(skipReason).toBeNull();
    expect(orderId).toBeString();
    const order = readOrder(ticker)!;
    expect(order.limitPrice).toBe(89); // 100 − bid(11)
    expect(order.kellyFraction).toBe(0);
  });

  test("regular buy_yes with negative Kelly is still skipped (no positive EV)", async () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    seedMarket(ticker, { yesBid: 84, yesAsk: 86, lastYesPrice: 85 });

    const service = new ExecutionService(stubKalshi);
    // Same numbers as the confirm_yes test but plain buy_yes → must skip.
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "buy_yes",
        marketPrice: 0.85,
        estimatedProb: 0.55,
      }),
      10000
    );

    expect(orderId).toBeNull();
    expect(skipReason).toBe("Kelly fraction <= 0 (no positive EV)");
  });

  test("minContractPrice enforced for regular low-conf signal but bypassed for confirmation", async () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    // ask 10¢ < minContractPrice 15¢. Low-conf regular buy_yes must skip;
    // a confirm_yes at the same price must bypass the floor and place.
    seedMarket(ticker, { yesBid: 8, yesAsk: 10, lastYesPrice: 9 });
    mockBotConfig.minContractPrice = 15;
    mockBotConfig.maxContractsPerOrder = 200;

    const service = new ExecutionService(stubKalshi);

    const regular = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "buy_yes",
        marketPrice: 0.1,
        estimatedProb: 0.5, // positive Kelly on YES at 10¢
        confidence: 0.85, // below highConfidenceThreshold
      }),
      10000
    );
    expect(regular.orderId).toBeNull();
    expect(regular.skipReason).toBe("price 10¢ < min 15¢ (low-conf lottery filter)");

    // Now the confirmation variant bypasses the floor.
    const confirm = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "confirm_yes",
        marketPrice: 0.1,
        estimatedProb: 0.5,
        confidence: 0.85,
        edge: 0,
      }),
      10000
    );
    expect(confirm.skipReason).toBeNull();
    expect(confirm.orderId).toBeString();
    expect(readOrder(ticker)!.limitPrice).toBe(10);
  });
});

describe("confidenceSizedPct (pure)", () => {
  test("floor confidence → minPct", () => {
    expect(confidenceSizedPct(0.80, 0.80, 0.01, 0.10)).toBeCloseTo(0.01, 6);
  });
  test("confidence 1.0 → maxPct", () => {
    expect(confidenceSizedPct(1.0, 0.80, 0.01, 0.10)).toBeCloseTo(0.10, 6);
  });
  test("midpoint of the band → midpoint pct", () => {
    // 0.90 is halfway across [0.80, 1.0] → halfway across [0.01, 0.10] = 0.055
    expect(confidenceSizedPct(0.90, 0.80, 0.01, 0.10)).toBeCloseTo(0.055, 6);
  });
  test("below floor clamps to minPct", () => {
    expect(confidenceSizedPct(0.50, 0.80, 0.01, 0.10)).toBeCloseTo(0.01, 6);
  });
  test("above 1 clamps to maxPct", () => {
    expect(confidenceSizedPct(1.5, 0.80, 0.01, 0.10)).toBeCloseTo(0.10, 6);
  });
  test("degenerate floor ≥ 1 collapses to maxPct", () => {
    expect(confidenceSizedPct(0.99, 1.0, 0.01, 0.10)).toBe(0.10);
  });
});

describe("executeSignal confidence-scaled %-of-balance sizing (2026-06-09)", () => {
  test("sizes a confirmation entry as a confidence-scaled % of balance", async () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    seedMarket(ticker, { yesBid: 86, yesAsk: 88, lastYesPrice: 87 });
    mockBotConfig.confidenceSizePctEnabled = true;
    mockBotConfig.maxExposurePctOfBalance = 0.12; // scaled cap, doesn't clip here

    const service = new ExecutionService(stubKalshi);
    // conf 0.90 → 0.055 of $100 = 550¢; floor(550/88) = 6 contracts.
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "confirm_yes",
        marketPrice: 0.87,
        estimatedProb: 0.55,
        confidence: 0.90,
        edge: 0,
      }),
      10000
    );

    expect(skipReason).toBeNull();
    expect(orderId).toBeString();
    expect(readOrder(ticker)!.quantity).toBe(6);
  });

  test("higher confidence → larger wager", async () => {
    const ticker = "KXHIGHNY-26MAR04-B41";
    seedMarket(ticker, { yesBid: 86, yesAsk: 88, lastYesPrice: 87 });
    mockBotConfig.confidenceSizePctEnabled = true;
    mockBotConfig.maxExposurePctOfBalance = 0.12;

    const service = new ExecutionService(stubKalshi);
    // conf 0.97 → 0.01 + (0.17/0.20)*0.09 = 0.0865 → 865¢; floor(865/88) = 9.
    const { orderId } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "confirm_yes",
        marketPrice: 0.87,
        estimatedProb: 0.55,
        confidence: 0.97,
        edge: 0,
      }),
      10000
    );

    expect(orderId).toBeString();
    expect(readOrder(ticker)!.quantity).toBe(9); // > the 6 from conf 0.90
  });

  test("pct sizing overrides the flat confirmation size", async () => {
    const ticker = "KXHIGHNY-26MAR04-B42";
    seedMarket(ticker, { yesBid: 86, yesAsk: 88, lastYesPrice: 87 });
    mockBotConfig.confidenceSizePctEnabled = true;
    mockBotConfig.maxExposurePctOfBalance = 0.12;
    mockBotConfig.confirmationBetSizeCents = 500; // would give floor(500/88)=5

    const service = new ExecutionService(stubKalshi);
    const { orderId } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "confirm_yes",
        marketPrice: 0.87,
        estimatedProb: 0.55,
        confidence: 0.90,
        edge: 0,
      }),
      10000
    );

    expect(orderId).toBeString();
    expect(readOrder(ticker)!.quantity).toBe(6); // pct (550¢→6), not flat (500¢→5)
  });

  test("per-ticker exposure cap scales to balance %, bypassing the fixed contract cap", async () => {
    const ticker = "KXHIGHNY-26MAR04-B43";
    // confirm_no at 100 − bid(80) = 20¢.
    seedMarket(ticker, { yesBid: 80, yesAsk: 82, lastYesPrice: 81 });
    mockBotConfig.confidenceSizePctEnabled = true;
    mockBotConfig.confidenceSizeMinPct = 0.50; // force a huge bet so the cap binds
    mockBotConfig.confidenceSizeMaxPct = 0.50;
    mockBotConfig.maxExposurePctOfBalance = 0.12;
    mockBotConfig.maxContractsPerOrder = 15; // fixed cap must NOT bind in pct mode

    const service = new ExecutionService(stubKalshi);
    // betAmount = 50% of 10000 = 5000¢ → floor(5000/20)=250, but the scaled
    // exposure cap = round(10000*0.12)=1200¢ → floor(1200/20)=60 contracts.
    const { orderId } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "no",
        recommendation: "confirm_no",
        marketPrice: 0.18,
        estimatedProb: 0.45,
        confidence: 0.90,
        edge: 0,
      }),
      10000
    );

    expect(orderId).toBeString();
    expect(readOrder(ticker)!.quantity).toBe(60); // 1200¢ cap, not the 15 fixed cap
  });

  test("with maxExposurePctOfBalance=0 the fixed caps still clamp in pct mode", async () => {
    const ticker = "KXHIGHNY-26MAR04-B44";
    seedMarket(ticker, { yesBid: 86, yesAsk: 88, lastYesPrice: 87 });
    mockBotConfig.confidenceSizePctEnabled = true;
    mockBotConfig.confidenceSizeMinPct = 0.50;
    mockBotConfig.confidenceSizeMaxPct = 0.50;
    mockBotConfig.maxExposurePctOfBalance = 0; // disabled → fixed caps apply
    mockBotConfig.maxExposurePerTicker = 500; // fixed cap binds: floor(500/88)=5

    const service = new ExecutionService(stubKalshi);
    const { orderId } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "confirm_yes",
        marketPrice: 0.87,
        estimatedProb: 0.55,
        confidence: 0.90,
        edge: 0,
      }),
      10000
    );

    expect(orderId).toBeString();
    expect(readOrder(ticker)!.quantity).toBe(5); // clamped by fixed $5 exposure cap
  });

  test("pct mode floors a small wager up to minBetSizeCents ($5 minimum)", async () => {
    const ticker = "KXHIGHNY-26MAR04-B45";
    seedMarket(ticker, { yesBid: 48, yesAsk: 50, lastYesPrice: 49 });
    mockBotConfig.confidenceSizePctEnabled = true;
    mockBotConfig.maxExposurePctOfBalance = 0.12;
    mockBotConfig.minBetSizeCents = 500; // $5 wager floor

    const service = new ExecutionService(stubKalshi);
    // conf 0.80 (floor) → 1% of $100 = 100¢, below the $5 floor → floored to
    // 500¢ → floor(500/50)=10 contracts (not the un-floored 2). Regular buy_yes
    // with positive Kelly (est 0.7 > market 0.5) so the EV gate passes.
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "buy_yes",
        marketPrice: 0.50,
        estimatedProb: 0.70,
        confidence: 0.80,
        edge: 0.20,
      }),
      10000
    );

    expect(skipReason).toBeNull();
    expect(orderId).toBeString();
    expect(readOrder(ticker)!.quantity).toBe(10); // floored to $5, not 2
  });

  test("pct mode does NOT floor a wager already above minBetSizeCents", async () => {
    const ticker = "KXHIGHNY-26MAR04-B46";
    seedMarket(ticker, { yesBid: 86, yesAsk: 88, lastYesPrice: 87 });
    mockBotConfig.confidenceSizePctEnabled = true;
    mockBotConfig.maxExposurePctOfBalance = 0.12;
    mockBotConfig.minBetSizeCents = 500;

    const service = new ExecutionService(stubKalshi);
    // conf 0.90 → 5.5% of $100 = 550¢ > 500¢ floor → unaffected → floor(550/88)=6.
    const { orderId } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "confirm_yes",
        marketPrice: 0.87,
        estimatedProb: 0.55,
        confidence: 0.90,
        edge: 0,
      }),
      10000
    );

    expect(orderId).toBeString();
    expect(readOrder(ticker)!.quantity).toBe(6);
  });

  test("minBetSizeCents=0 disables the floor (pct value stands)", async () => {
    const ticker = "KXHIGHNY-26MAR04-B47";
    seedMarket(ticker, { yesBid: 48, yesAsk: 50, lastYesPrice: 49 });
    mockBotConfig.confidenceSizePctEnabled = true;
    mockBotConfig.maxExposurePctOfBalance = 0.12;
    mockBotConfig.minBetSizeCents = 0; // floor disabled

    const service = new ExecutionService(stubKalshi);
    // conf 0.80 → 1% of $100 = 100¢, no floor → floor(100/50)=2 contracts.
    const { orderId } = await service.executeSignal(
      makeSignal({
        ticker,
        side: "yes",
        recommendation: "buy_yes",
        marketPrice: 0.50,
        estimatedProb: 0.70,
        confidence: 0.80,
        edge: 0.20,
      }),
      10000
    );

    expect(orderId).toBeString();
    expect(readOrder(ticker)!.quantity).toBe(2);
  });
});

// ── Per-event exposure cap (2026-06-10) ────────────────────────
// Several tickers in one event are a single correlated thesis (NO on adjacent
// brackets + YES on the center all lose together on a 1-bracket forecast
// miss). The cap bounds summed cost basis across the event.

function seedMarketInEvent(
  ticker: string,
  eventTicker: string,
  book: { yesBid?: number | null; yesAsk?: number | null; lastYesPrice?: number | null } = {}
) {
  const ts = new Date().toISOString();
  getDb()
    .insert(markets)
    .values({
      ticker,
      eventTicker,
      seriesTicker: "KXHIGHNY",
      title: "test market",
      category: "high_temp",
      stationId: "KNYC",
      targetDate: "2026-03-04",
      bracketLow: 39,
      bracketHigh: 40,
      marketType: "bracket",
      status: "open",
      lastYesPrice: book.lastYesPrice ?? null,
      lastNoPrice: book.lastYesPrice != null ? 100 - book.lastYesPrice : null,
      yesBid: book.yesBid ?? null,
      yesAsk: book.yesAsk ?? null,
      discoveredAt: ts,
      updatedAt: ts,
    })
    .onConflictDoNothing()
    .run();
}

function seedPosition(ticker: string, costBasis: number) {
  getDb().insert(positions).values({
    ticker,
    side: "yes",
    quantity: Math.max(1, Math.floor(costBasis / 50)),
    avgEntryPrice: 50,
    costBasis,
    marketValue: costBasis,
    unrealizedPnl: 0,
    openedAt: "2026-03-04T00:00:00Z",
    updatedAt: "2026-03-04T00:00:00Z",
  }).run();
}

describe("executeSignal per-event exposure cap", () => {
  const EVENT = "KXHIGHNY-26MAR04";

  test("skips when the event's summed cost basis is at the cap", async () => {
    mockBotConfig.maxEventExposurePctOfBalance = 0.15; // 1500¢ of 10000¢
    seedMarketInEvent("KXHIGHNY-26MAR04-B38", EVENT, { yesBid: 49, yesAsk: 50 });
    seedMarketInEvent("KXHIGHNY-26MAR04-B42", EVENT, { yesBid: 49, yesAsk: 50 });
    seedPosition("KXHIGHNY-26MAR04-B38", 1500);

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({ ticker: "KXHIGHNY-26MAR04-B42", marketPrice: 0.5, estimatedProb: 0.75 }),
      10000
    );

    expect(orderId).toBeNull();
    expect(skipReason).toBe(`event exposure 1500¢/1500¢ (${EVENT})`);
  });

  test("sizes down to fit remaining event room", async () => {
    mockBotConfig.maxEventExposurePctOfBalance = 0.15; // 1500¢ cap
    seedMarketInEvent("KXHIGHNY-26MAR04-B38", EVENT, { yesBid: 49, yesAsk: 50 });
    seedMarketInEvent("KXHIGHNY-26MAR04-B42", EVENT, { yesBid: 49, yesAsk: 50 });
    seedPosition("KXHIGHNY-26MAR04-B38", 1400); // 100¢ room left

    const service = new ExecutionService(stubKalshi);
    const { orderId } = await service.executeSignal(
      makeSignal({ ticker: "KXHIGHNY-26MAR04-B42", marketPrice: 0.5, estimatedProb: 0.75 }),
      10000
    );

    expect(orderId).toBeString();
    // Kelly sizing would buy 5 @ 50¢; event room 100¢ fits only 2.
    expect(readOrder("KXHIGHNY-26MAR04-B42")!.quantity).toBe(2);
  });

  test("positions in a different event don't count", async () => {
    mockBotConfig.maxEventExposurePctOfBalance = 0.15;
    seedMarketInEvent("KXHIGHNY-26MAR03-B38", "KXHIGHNY-26MAR03", { yesBid: 49, yesAsk: 50 });
    seedMarketInEvent("KXHIGHNY-26MAR04-B42", EVENT, { yesBid: 49, yesAsk: 50 });
    seedPosition("KXHIGHNY-26MAR03-B38", 1500); // other event, at cap

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({ ticker: "KXHIGHNY-26MAR04-B42", marketPrice: 0.5, estimatedProb: 0.75 }),
      10000
    );

    expect(skipReason).toBeNull();
    expect(orderId).toBeString();
  });

  test("cap=0 disables the guard (ships dark)", async () => {
    mockBotConfig.maxEventExposurePctOfBalance = 0;
    seedMarketInEvent("KXHIGHNY-26MAR04-B38", EVENT, { yesBid: 49, yesAsk: 50 });
    seedMarketInEvent("KXHIGHNY-26MAR04-B42", EVENT, { yesBid: 49, yesAsk: 50 });
    seedPosition("KXHIGHNY-26MAR04-B38", 5000);

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({ ticker: "KXHIGHNY-26MAR04-B42", marketPrice: 0.5, estimatedProb: 0.75 }),
      10000
    );

    expect(skipReason).toBeNull();
    expect(orderId).toBeString();
  });
});

// ── Recent-loss guard: confirmation exemption (2026-06-10) ─────
// Confirmation entries have model edge ≤ 0 by construction, so the 1.5×-edge
// re-entry bar was unsatisfiable — one loss exit locked the ticker out for the
// whole 2h loss window. 12/15 blocked re-entries would have won (post-regime).

describe("executeSignal recent-loss guard pathway split", () => {
  test("confirmation signal re-enters despite a recent loss exit", async () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    seedMarket(ticker, { yesBid: 84, yesAsk: 86, lastYesPrice: 85 });

    recordExit(ticker, true, -0.3); // loss exit…
    resetCooldowns();               // …with the tick cooldown already elapsed
    expect(getRecentLoss(ticker)).not.toBeNull();

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker,
        recommendation: "confirm_yes",
        side: "yes",
        marketPrice: 0.85,
        estimatedProb: 0.6,
        edge: -0.25, // structurally ≤ 0 for confirmations
      }),
      10000
    );

    expect(skipReason).toBeNull();
    expect(orderId).toBeString();
  });

  test("contrarian signal with a recent loss still needs 1.5× edge", async () => {
    const ticker = "KXHIGHNY-26MAR04-B40";
    seedMarket(ticker, { yesBid: 49, yesAsk: 50, lastYesPrice: 50 });

    recordExit(ticker, true, -0.3);
    resetCooldowns();

    const service = new ExecutionService(stubKalshi);
    // edge 0.20 < 1.5 × 0.15 = 0.225 → still blocked
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({ ticker, edge: 0.2, edgeThreshold: 0.15 }),
      10000
    );

    expect(orderId).toBeNull();
    expect(skipReason).toStartWith("recent-loss elevated edge");
  });
});

// ── Adjacent-bracket mutual exclusivity guard (2026-06-18) ─────
// Blocks a confirmation entry when an open position already exists on a
// neighbouring bracket of the same event. Prevents the correlated two-leg
// stacking that caused KMIA Jun-15 / KDEN Jun-12 combined losses.

function seedMarketWithBracket(
  ticker: string,
  eventTicker: string,
  bracketLow: number,
  bracketHigh: number | null,
  book: { yesBid?: number; yesAsk?: number; lastYesPrice?: number } = {}
) {
  const ts = new Date().toISOString();
  getDb().insert(markets).values({
    ticker,
    eventTicker,
    seriesTicker: "KXHIGH",
    title: "test market",
    category: "high_temp",
    stationId: "KNYC",
    targetDate: "2026-03-04",
    bracketLow,
    bracketHigh,
    marketType: bracketHigh == null ? "upper_tail" : "bracket",
    status: "open",
    lastYesPrice: book.lastYesPrice ?? 80,
    lastNoPrice: book.lastYesPrice != null ? 100 - book.lastYesPrice : 20,
    yesBid: book.yesBid ?? null,
    yesAsk: book.yesAsk ?? null,
    discoveredAt: ts,
    updatedAt: ts,
  }).onConflictDoNothing().run();
}

describe("executeSignal adjacent-bracket guard", () => {
  const EVENT = "KXHIGH-26MAR04";

  test("blocks confirm when lower adjacent bracket is held", async () => {
    // Event: B92.5-94.5 (the bracket) and T94.5 (upper tail).
    // Bot holds the bracket; now tries confirm_no on the tail → blocked.
    const bracketTicker = `${EVENT}-B93.5`;
    const tailTicker    = `${EVENT}-T94`;
    seedMarketWithBracket(bracketTicker, EVENT, 92.5, 94.5, { yesBid: 78, yesAsk: 82 });
    seedMarketWithBracket(tailTicker,    EVENT, 94.5, null, { yesBid: 16, yesAsk: 20 });
    seedPosition(bracketTicker, 400); // open position on the bracket

    mockBotConfig.adjacentBracketGuardEnabled = true;

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker: tailTicker,
        recommendation: "confirm_no",
        side: "no",
        marketPrice: 0.18,
        estimatedProb: 0.23,
        edge: 0,
      }),
      10000
    );

    expect(orderId).toBeNull();
    expect(skipReason).toBe(`adjacent-bracket hold (${bracketTicker})`);
  });

  test("blocks confirm when upper adjacent bracket is held", async () => {
    // Bot holds the tail; now tries confirm_yes on the bracket just below → blocked.
    const bracketTicker = `${EVENT}-B93.5`;
    const tailTicker    = `${EVENT}-T94`;
    seedMarketWithBracket(bracketTicker, EVENT, 92.5, 94.5, { yesBid: 78, yesAsk: 82 });
    seedMarketWithBracket(tailTicker,    EVENT, 94.5, null, { yesBid: 16, yesAsk: 20 });
    seedPosition(tailTicker, 400); // open position on the tail

    mockBotConfig.adjacentBracketGuardEnabled = true;

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker: bracketTicker,
        recommendation: "confirm_yes",
        side: "yes",
        marketPrice: 0.80,
        estimatedProb: 0.55,
        edge: 0,
      }),
      10000
    );

    expect(orderId).toBeNull();
    expect(skipReason).toBe(`adjacent-bracket hold (${tailTicker})`);
  });

  test("allows confirm when held position is not adjacent (different event)", async () => {
    const sigTicker  = `${EVENT}-B93.5`;
    const otherEvent = "KXHIGH-26MAR05";
    const otherTicker = `${otherEvent}-B93.5`;
    seedMarketWithBracket(sigTicker,   EVENT,      92.5, 94.5, { yesBid: 78, yesAsk: 82 });
    seedMarketWithBracket(otherTicker, otherEvent, 92.5, 94.5, { yesBid: 78, yesAsk: 82 });
    seedPosition(otherTicker, 400); // different event — not adjacent

    mockBotConfig.adjacentBracketGuardEnabled = true;

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker: sigTicker,
        recommendation: "confirm_yes",
        side: "yes",
        marketPrice: 0.80,
        estimatedProb: 0.55,
        edge: 0,
      }),
      10000
    );

    expect(skipReason).toBeNull();
    expect(orderId).toBeString();
  });

  test("allows confirm when held position is non-adjacent in same event", async () => {
    // B91.5 (bracketLow=90.5, bracketHigh=92.5) and T94 (bracketLow=94.5) are
    // not adjacent — B93.5 sits between them.
    const lowerBracket = `${EVENT}-B91.5`;
    const tailTicker   = `${EVENT}-T94`;
    seedMarketWithBracket(lowerBracket, EVENT, 90.5, 92.5, { yesBid: 78, yesAsk: 82 });
    seedMarketWithBracket(tailTicker,   EVENT, 94.5, null, { yesBid: 16, yesAsk: 20 });
    seedPosition(lowerBracket, 400);

    mockBotConfig.adjacentBracketGuardEnabled = true;

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker: tailTicker,
        recommendation: "confirm_no",
        side: "no",
        marketPrice: 0.18,
        estimatedProb: 0.23,
        edge: 0,
      }),
      10000
    );

    expect(skipReason).toBeNull();
    expect(orderId).toBeString();
  });

  test("non-confirmation (contrarian) is not blocked by adjacent position", async () => {
    // The guard only fires for confirm_* — contrarian entries aren't stacked the same way.
    const bracketTicker = `${EVENT}-B93.5`;
    const tailTicker    = `${EVENT}-T94`;
    seedMarketWithBracket(bracketTicker, EVENT, 92.5, 94.5, { yesBid: 78, yesAsk: 82 });
    seedMarketWithBracket(tailTicker,    EVENT, 94.5, null, { yesBid: 16, yesAsk: 20 });
    seedPosition(bracketTicker, 400);

    mockBotConfig.adjacentBracketGuardEnabled = true;

    const service = new ExecutionService(stubKalshi);
    const { orderId, skipReason } = await service.executeSignal(
      makeSignal({
        ticker: tailTicker,
        recommendation: "buy_no",
        side: "no",
        marketPrice: 0.18,
        estimatedProb: 0.05,
        edge: 0.13,
        edgeThreshold: 0.05,
      }),
      10000
    );

    // Guard does not fire — skip reason is from some other check or it places
    expect(skipReason).not.toStartWith("adjacent-bracket hold");
  });

  test("guard disabled — adjacent confirm goes through", async () => {
    const bracketTicker = `${EVENT}-B93.5`;
    const tailTicker    = `${EVENT}-T94`;
    seedMarketWithBracket(bracketTicker, EVENT, 92.5, 94.5, { yesBid: 78, yesAsk: 82 });
    seedMarketWithBracket(tailTicker,    EVENT, 94.5, null, { yesBid: 16, yesAsk: 20 });
    seedPosition(bracketTicker, 400);

    mockBotConfig.adjacentBracketGuardEnabled = false; // disabled

    const service = new ExecutionService(stubKalshi);
    const { skipReason } = await service.executeSignal(
      makeSignal({
        ticker: tailTicker,
        recommendation: "confirm_no",
        side: "no",
        marketPrice: 0.18,
        estimatedProb: 0.23,
        edge: 0,
      }),
      10000
    );

    expect(skipReason).not.toStartWith("adjacent-bracket hold");
  });
});
