import { test, expect, describe } from "bun:test";

/**
 * Test the win rate display formatting logic extracted from PerformanceView.
 * The view computes: (wins / settledCount * 100).toFixed(1) + "%"
 */
function formatWinRate(wins: number, settledCount: number): string {
  const winRate = settledCount > 0 ? wins / settledCount : 0;
  return `${(winRate * 100).toFixed(1)}%`;
}

function formatPredicted(predictedProb: number): string {
  return `${(predictedProb * 100).toFixed(0)}%`;
}

describe("win rate formatting", () => {
  test("0 wins / 0 settled shows 0.0%", () => {
    expect(formatWinRate(0, 0)).toBe("0.0%");
  });

  test("1 win / 3 settled shows 33.3%", () => {
    expect(formatWinRate(1, 3)).toBe("33.3%");
  });

  test("2 wins / 3 settled shows 66.7%", () => {
    expect(formatWinRate(2, 3)).toBe("66.7%");
  });

  test("1 win / 1 settled shows 100.0%", () => {
    expect(formatWinRate(1, 1)).toBe("100.0%");
  });

  test("0 wins / 5 settled shows 0.0%", () => {
    expect(formatWinRate(0, 5)).toBe("0.0%");
  });

  test("3 wins / 7 settled shows 42.9%", () => {
    expect(formatWinRate(3, 7)).toBe("42.9%");
  });
});

describe("predicted column formatting", () => {
  test("formats probability as percentage", () => {
    expect(formatPredicted(0.5)).toBe("50%");
    expect(formatPredicted(0.75)).toBe("75%");
    expect(formatPredicted(0.11)).toBe("11%");
    expect(formatPredicted(0.0)).toBe("0%");
    expect(formatPredicted(0.99)).toBe("99%");
  });
});
