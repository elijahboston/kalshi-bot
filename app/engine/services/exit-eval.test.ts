import { test, expect, describe } from "bun:test";
import { evaluateExit, type ExitEvaluationInput } from "./exit-eval";

const DEFAULT_CONFIG: ExitEvaluationInput["config"] = {
  exitEdgeThreshold: 0.03,
  stopLossPct: 0.25,
  stopLossMinEdge: 0.05,
  exitTimeDaysBeforeClose: 0.25,
  exitTimeMinEdge: 0.08,
};

function input(overrides: Partial<ExitEvaluationInput> = {}): ExitEvaluationInput {
  return {
    edge: 0.2,
    position: { quantity: 3, costBasis: 157 },
    currentSidePrice: 50,
    closeTime: null,
    now: Date.now(),
    config: DEFAULT_CONFIG,
    ...overrides,
  };
}

describe("evaluateExit — edge reversal", () => {
  test("fires when edge drops below threshold", () => {
    const reason = evaluateExit(input({ edge: 0.02 }));
    expect(reason).toContain("edge reversal");
  });

  test("does not fire when edge exactly at threshold", () => {
    const reason = evaluateExit(input({ edge: 0.03 }));
    expect(reason).toBeNull();
  });
});

describe("evaluateExit — stop-loss with edge gate", () => {
  test("30% drawdown + high edge → does NOT stop-loss (the DEN-79.5 scenario)", () => {
    // Position: 3 contracts @ cost basis 157 cents, current price 17 cents.
    // Loss ~ 67% of cost basis, well past 25% stop-loss threshold.
    // Edge 82¢ — model still strongly believes we win. Should hold.
    const reason = evaluateExit(
      input({
        edge: 0.82,
        position: { quantity: 3, costBasis: 157 },
        currentSidePrice: 17,
      })
    );
    expect(reason).toBeNull();
  });

  test("30% drawdown + edge compressed → stop-loss fires", () => {
    // Same drawdown, but edge has fallen below stopLossMinEdge (5¢).
    const reason = evaluateExit(
      input({
        edge: 0.04,
        position: { quantity: 3, costBasis: 157 },
        currentSidePrice: 17,
      })
    );
    expect(reason).toContain("stop-loss");
  });

  test("edge between exitEdgeThreshold and stopLossMinEdge + drawdown → stop-loss", () => {
    // edge 4¢ > 3¢ (no edge reversal) but < 5¢ (stop-loss gate allows it)
    const reason = evaluateExit(
      input({
        edge: 0.04,
        position: { quantity: 10, costBasis: 500 },
        currentSidePrice: 30, // loss = (10*30 - 500)/500 = -40%
      })
    );
    expect(reason).toContain("stop-loss");
  });

  test("no drawdown → no stop-loss even with low edge", () => {
    // Edge reversal would fire at edge < 3¢, so keep edge just above it.
    const reason = evaluateExit(
      input({
        edge: 0.04,
        position: { quantity: 3, costBasis: 157 },
        currentSidePrice: 100, // huge mark-up, no drawdown
      })
    );
    expect(reason).toBeNull();
  });

  test("zero cost basis → stop-loss cannot fire (avoids divide-by-zero)", () => {
    const reason = evaluateExit(
      input({
        edge: 0.04,
        position: { quantity: 3, costBasis: 0 },
        currentSidePrice: 17,
      })
    );
    expect(reason).toBeNull();
  });
});

describe("evaluateExit — time decay", () => {
  test("inside close window with low edge → fires", () => {
    const now = Date.now();
    const closeTime = new Date(now + 3 * 60 * 60 * 1000).toISOString(); // 3h away
    const reason = evaluateExit(input({ edge: 0.05, closeTime, now }));
    expect(reason).toContain("time decay");
  });

  test("inside close window with sufficient edge → does not fire", () => {
    const now = Date.now();
    const closeTime = new Date(now + 3 * 60 * 60 * 1000).toISOString();
    const reason = evaluateExit(input({ edge: 0.15, closeTime, now }));
    expect(reason).toBeNull();
  });

  test("outside close window → does not fire regardless of edge", () => {
    const now = Date.now();
    const closeTime = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days
    const reason = evaluateExit(input({ edge: 0.05, closeTime, now }));
    expect(reason).toBeNull();
  });
});

describe("evaluateExit — precedence", () => {
  test("edge reversal takes precedence over stop-loss", () => {
    const reason = evaluateExit(
      input({
        edge: 0.01,
        position: { quantity: 3, costBasis: 157 },
        currentSidePrice: 17,
      })
    );
    expect(reason).toContain("edge reversal");
  });

  test("stop-loss takes precedence over time decay", () => {
    const now = Date.now();
    const closeTime = new Date(now + 3 * 60 * 60 * 1000).toISOString();
    const reason = evaluateExit(
      input({
        edge: 0.04,
        position: { quantity: 3, costBasis: 157 },
        currentSidePrice: 17,
        closeTime,
        now,
      })
    );
    expect(reason).toContain("stop-loss");
  });
});

describe("evaluateExit — winner-hold carve-out (N8)", () => {
  // Carve-out enabled at the configured default of 0.90.
  const HOLD_CONFIG: ExitEvaluationInput["config"] = {
    ...DEFAULT_CONFIG,
    exitHoldWinnerPrice: 0.9,
    exitHoldWinnerMaxHoursToClose: 6,
  };

  test("holds a confirmed winner: 92¢, 4h to close, in profit, edge below threshold → null", () => {
    const now = Date.now();
    const closeTime = new Date(now + 4 * 60 * 60 * 1000).toISOString();
    // 3 @ cost 157¢, now 92¢ each → unrealized = 3*92 - 157 = +119¢ (profit).
    const reason = evaluateExit(
      input({
        edge: 0.01, // below exitEdgeThreshold (0.03) — would normally reverse
        position: { quantity: 3, costBasis: 157 },
        currentSidePrice: 92,
        closeTime,
        now,
        config: HOLD_CONFIG,
      })
    );
    expect(reason).toBeNull();
  });

  test("too far from close (8h): carve-out does not apply → edge reversal fires", () => {
    const now = Date.now();
    const closeTime = new Date(now + 8 * 60 * 60 * 1000).toISOString(); // beyond 6h window
    const reason = evaluateExit(
      input({
        edge: 0.01,
        position: { quantity: 3, costBasis: 157 },
        currentSidePrice: 92,
        closeTime,
        now,
        config: HOLD_CONFIG,
      })
    );
    expect(reason).toContain("edge reversal");
  });

  test("price too low (85¢): market does not agree we won → edge reversal fires", () => {
    const now = Date.now();
    const closeTime = new Date(now + 4 * 60 * 60 * 1000).toISOString();
    const reason = evaluateExit(
      input({
        edge: 0.01,
        position: { quantity: 3, costBasis: 157 },
        currentSidePrice: 85, // below the 90¢ (= 0.90) carve-out price
        closeTime,
        now,
        config: HOLD_CONFIG,
      })
    );
    expect(reason).toContain("edge reversal");
  });

  test("not in profit (cost basis high): carve-out requires profit → edge reversal fires", () => {
    const now = Date.now();
    const closeTime = new Date(now + 4 * 60 * 60 * 1000).toISOString();
    // 3 @ 92¢ = 276¢ value, but cost basis 300¢ → unrealized = -24¢ (a loss).
    const reason = evaluateExit(
      input({
        edge: 0.01,
        position: { quantity: 3, costBasis: 300 },
        currentSidePrice: 92,
        closeTime,
        now,
        config: HOLD_CONFIG,
      })
    );
    expect(reason).toContain("edge reversal");
  });

  test("time-decay exit is also suppressed for a confirmed winner", () => {
    const now = Date.now();
    const closeTime = new Date(now + 3 * 60 * 60 * 1000).toISOString(); // inside time-decay window
    // edge 0.05 is above exitEdgeThreshold (0.03) so no edge reversal, but
    // below exitTimeMinEdge (0.08) so time decay would normally fire.
    const reason = evaluateExit(
      input({
        edge: 0.05,
        position: { quantity: 3, costBasis: 157 },
        currentSidePrice: 92,
        closeTime,
        now,
        config: HOLD_CONFIG,
      })
    );
    expect(reason).toBeNull();
  });

  test("stop-loss still fires with carve-out config present (price low, carve-out inapplicable)", () => {
    const now = Date.now();
    const closeTime = new Date(now + 3 * 60 * 60 * 1000).toISOString();
    // Deep drawdown at 17¢ (well below 90¢ → carve-out inapplicable),
    // edge 0.04 < stopLossMinEdge (0.05) → stop-loss must fire.
    const reason = evaluateExit(
      input({
        edge: 0.04,
        position: { quantity: 3, costBasis: 157 },
        currentSidePrice: 17,
        closeTime,
        now,
        config: HOLD_CONFIG,
      })
    );
    expect(reason).toContain("stop-loss");
  });

  test("back-compat: config without carve-out fields behaves exactly as before", () => {
    // Re-run the time-decay scenario with the un-extended DEFAULT_CONFIG:
    // 92¢, 4h, in profit, edge 0.01 — without a carve-out this MUST reverse.
    const now = Date.now();
    const closeTime = new Date(now + 4 * 60 * 60 * 1000).toISOString();
    const reason = evaluateExit(
      input({
        edge: 0.01,
        position: { quantity: 3, costBasis: 157 },
        currentSidePrice: 92,
        closeTime,
        now,
        config: DEFAULT_CONFIG,
      })
    );
    expect(reason).toContain("edge reversal");
  });

  test("disabled: exitHoldWinnerPrice 0 → carve-out never applies", () => {
    const now = Date.now();
    const closeTime = new Date(now + 4 * 60 * 60 * 1000).toISOString();
    const reason = evaluateExit(
      input({
        edge: 0.01,
        position: { quantity: 3, costBasis: 157 },
        currentSidePrice: 92,
        closeTime,
        now,
        config: { ...DEFAULT_CONFIG, exitHoldWinnerPrice: 0 },
      })
    );
    expect(reason).toContain("edge reversal");
  });
});
