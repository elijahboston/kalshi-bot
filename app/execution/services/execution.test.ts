import { test, expect, describe } from "bun:test";
import { computeKelly } from "./execution";

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
