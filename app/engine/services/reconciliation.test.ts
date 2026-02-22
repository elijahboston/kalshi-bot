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

/**
 * Extracted PnL computation from checkResolutions.
 * Computes realized PnL from individual trade records.
 */
function computeTradesPnl(
  marketTrades: Array<{ action: string; side: string; price: number; quantity: number }>,
  outcome: number, // 1 = YES, 0 = NO
): number {
  let realizedPnl = 0;
  for (const t of marketTrades) {
    if (t.action === "buy") {
      const won =
        (t.side === "yes" && outcome === 1) ||
        (t.side === "no" && outcome === 0);
      realizedPnl += won
        ? (100 - t.price) * t.quantity
        : -t.price * t.quantity;
    }
  }
  return realizedPnl;
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
        { action: "buy", side: "yes", price: 40, quantity: 5 },  // win: (100-40)*5 = 300
        { action: "buy", side: "yes", price: 50, quantity: 3 },  // win: (100-50)*3 = 150
      ],
      1,
    );
    expect(pnl).toBe(450);
  });

  test("sell actions are ignored", () => {
    const pnl = computeTradesPnl(
      [
        { action: "buy", side: "yes", price: 40, quantity: 5 },  // win: 300
        { action: "sell", side: "yes", price: 60, quantity: 3 }, // ignored
      ],
      1,
    );
    expect(pnl).toBe(300);
  });

  test("no trades returns 0", () => {
    const pnl = computeTradesPnl([], 1);
    expect(pnl).toBe(0);
  });
});
