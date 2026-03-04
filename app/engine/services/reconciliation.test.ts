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
