import { test, expect, describe, mock } from "bun:test";
import { mean, std, erf, normalCdf, ProbabilityEstimator } from "./estimator";

describe("mean", () => {
  test("computes average of values", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  test("single element", () => {
    expect(mean([42])).toBe(42);
  });

  test("negative values", () => {
    expect(mean([-10, 10])).toBe(0);
  });

  test("decimal values", () => {
    expect(mean([1.5, 2.5])).toBe(2);
  });
});

describe("std", () => {
  test("zero spread returns 0", () => {
    expect(std([5, 5, 5, 5])).toBe(0);
  });

  test("single element returns 0", () => {
    expect(std([42])).toBe(0);
  });

  test("known distribution", () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] → mean=5, variance=4, std=2
    expect(std([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });

  test("symmetric distribution", () => {
    // [-1, 1] → mean=0, variance=1, std=1
    expect(std([-1, 1])).toBe(1);
  });
});

describe("erf", () => {
  test("erf(0) ≈ 0", () => {
    expect(erf(0)).toBeCloseTo(0, 8);
  });

  test("erf(1) ≈ 0.8427", () => {
    expect(erf(1)).toBeCloseTo(0.8427, 4);
  });

  test("odd function: erf(-x) === -erf(x)", () => {
    expect(erf(-1)).toBeCloseTo(-erf(1), 10);
    expect(erf(-0.5)).toBeCloseTo(-erf(0.5), 10);
  });

  test("large positive → ≈ 1.0", () => {
    expect(erf(4)).toBeCloseTo(1.0, 6);
  });
});

describe("normalCdf", () => {
  test("midpoint: normalCdf(mean, mean, std) ≈ 0.5", () => {
    expect(normalCdf(30, 30, 2)).toBeCloseTo(0.5, 6);
  });

  test("mean + 1 std ≈ 0.8413", () => {
    expect(normalCdf(32, 30, 2)).toBeCloseTo(0.8413, 4);
  });

  test("mean - 1 std ≈ 0.1587", () => {
    expect(normalCdf(28, 30, 2)).toBeCloseTo(0.1587, 4);
  });

  test("bracket integral: normalCdf(31,30,2) - normalCdf(29,30,2) ≈ 0.3829", () => {
    const integral = normalCdf(31, 30, 2) - normalCdf(29, 30, 2);
    expect(integral).toBeCloseTo(0.3829, 4);
  });
});

/** Create a mock DB that returns given rows for both .limit() and non-.limit() queries */
function mockDb(rows: any[] = []) {
  return {
    select: () => ({
      from: () => ({
        where: (..._args: any[]) => {
          const result = Promise.resolve(rows);
          // Support both .where().limit() and .where() without limit
          (result as any).limit = () => Promise.resolve(rows);
          return result;
        },
      }),
    }),
  };
}

describe("ProbabilityEstimator", () => {
  test("estimate computes bracket probability from ensemble", async () => {
    mock.module("@kcb/db", () => ({
      ...require("@kcb/db"),
      getDb: () => mockDb([]),
    }));

    const estimator = new ProbabilityEstimator();

    // 10 ensemble members: 5 in bracket [30, 31), 5 outside
    const ensemble = [28, 29, 30, 30, 30, 30, 30, 31, 32, 33];
    const market = {
      ticker: "KXHIGHNY-25FEB19-B30",
      stationId: "KNYC",
      category: "high_temp",
      bracketLow: 30,
      bracketHigh: 31,
      targetDate: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
    } as any;

    const result = await estimator.estimate(market, ensemble);

    // 5 out of 10 members are in [30, 31) → counting = 0.5
    expect(result.reasoning.countingProbability).toBe(0.5);
    expect(result.reasoning.cdfProbability).toBeGreaterThan(0);
    expect(result.reasoning.cdfProbability).toBeLessThan(1);
    // Blended probability: 10/200 = 5% counting weight, 95% CDF
    expect(result.probability).toBeGreaterThan(0);
    expect(result.probability).toBeLessThan(1);
    expect(result.ensembleSize).toBe(10);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.reasoning.membersInBracket).toBe(5);
    // No calibration data → null
    expect(result.reasoning.historicalHitRate).toBeNull();
  });

  test("ensemble far below bracket → probability near 0", async () => {
    mock.module("@kcb/db", () => ({
      ...require("@kcb/db"),
      getDb: () => mockDb([]),
    }));

    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14];
    const market = {
      ticker: "KXHIGHNY-25FEB19-B30",
      stationId: "KNYC",
      category: "high_temp",
      bracketLow: 30,
      bracketHigh: 31,
      targetDate: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
    } as any;

    const result = await estimator.estimate(market, ensemble);
    // Counting = 0, CDF ≈ 0 (mean ~12, bracket 30-31 is many std devs away)
    expect(result.reasoning.countingProbability).toBe(0);
    expect(result.reasoning.cdfProbability).toBeCloseTo(0, 4);
    expect(result.probability).toBeCloseTo(0, 4);
  });

  test("estimate throws for missing station/bracket data", async () => {
    const estimator = new ProbabilityEstimator();
    const market = { ticker: "TEST", stationId: null, bracketLow: null, bracketHigh: null } as any;

    expect(estimator.estimate(market, [1, 2, 3])).rejects.toThrow(
      "missing station/bracket data"
    );
  });

  test("ensemble centered on bracket → blended between counting and CDF", async () => {
    mock.module("@kcb/db", () => ({
      ...require("@kcb/db"),
      getDb: () => mockDb([]),
    }));

    const estimator = new ProbabilityEstimator();
    // Mean ≈ 30.5, bracket [30, 31) — well centered
    const ensemble = Array.from({ length: 50 }, (_, i) => 28 + i * 0.1);
    const market = {
      ticker: "KXHIGHNY-25FEB19-B30",
      stationId: "KNYC",
      category: "high_temp",
      bracketLow: 30,
      bracketHigh: 31,
      targetDate: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
    } as any;

    const result = await estimator.estimate(market, ensemble);
    expect(result.reasoning.countingProbability).toBeGreaterThan(0);
    expect(result.reasoning.cdfProbability).toBeGreaterThan(0);
    // Blended should be between the two (or equal if they're close)
    const lo = Math.min(result.reasoning.countingProbability, result.reasoning.cdfProbability);
    const hi = Math.max(result.reasoning.countingProbability, result.reasoning.cdfProbability);
    expect(result.probability).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(result.probability).toBeLessThanOrEqual(hi + 1e-9);
  });

  test("zero-spread ensemble → falls back to counting", async () => {
    mock.module("@kcb/db", () => ({
      ...require("@kcb/db"),
      getDb: () => mockDb([]),
    }));

    const estimator = new ProbabilityEstimator();
    // All values identical and inside bracket
    const ensemble = [30.5, 30.5, 30.5, 30.5, 30.5];
    const market = {
      ticker: "KXHIGHNY-25FEB19-B30",
      stationId: "KNYC",
      category: "high_temp",
      bracketLow: 30,
      bracketHigh: 31,
      targetDate: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
    } as any;

    const result = await estimator.estimate(market, ensemble);
    // std=0 → cdfProbability falls back to counting
    expect(result.reasoning.countingProbability).toBe(1);
    expect(result.reasoning.cdfProbability).toBe(result.reasoning.countingProbability);
    expect(result.probability).toBe(1);
  });
});

describe("getHistoricalHitRate", () => {
  test("returns null when fewer than 5 calibration rows", async () => {
    mock.module("@kcb/db", () => ({
      ...require("@kcb/db"),
      getDb: () => mockDb([
        { actualOutcome: 1 },
        { actualOutcome: 0 },
        { actualOutcome: 1 },
      ]),
    }));

    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBeNull();
  });

  test("returns hit rate when sufficient data", async () => {
    // 3 hits out of 5 records → 0.6
    mock.module("@kcb/db", () => ({
      ...require("@kcb/db"),
      getDb: () => mockDb([
        { actualOutcome: 1 },
        { actualOutcome: 1 },
        { actualOutcome: 1 },
        { actualOutcome: 0 },
        { actualOutcome: 0 },
      ]),
    }));

    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBe(0.6);
  });

  test("returns 1.0 when all outcomes are YES", async () => {
    mock.module("@kcb/db", () => ({
      ...require("@kcb/db"),
      getDb: () => mockDb([
        { actualOutcome: 1 },
        { actualOutcome: 1 },
        { actualOutcome: 1 },
        { actualOutcome: 1 },
        { actualOutcome: 1 },
      ]),
    }));

    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBe(1.0);
  });

  test("returns 0.0 when all outcomes are NO", async () => {
    mock.module("@kcb/db", () => ({
      ...require("@kcb/db"),
      getDb: () => mockDb([
        { actualOutcome: 0 },
        { actualOutcome: 0 },
        { actualOutcome: 0 },
        { actualOutcome: 0 },
        { actualOutcome: 0 },
      ]),
    }));

    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBe(0.0);
  });

  test("returns null when no calibration data", async () => {
    mock.module("@kcb/db", () => ({
      ...require("@kcb/db"),
      getDb: () => mockDb([]),
    }));

    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBeNull();
  });

  test("estimate includes historicalHitRate when data available", async () => {
    // Return calibration rows for hit rate, empty for bias
    let callCount = 0;
    mock.module("@kcb/db", () => ({
      ...require("@kcb/db"),
      getDb: () => ({
        select: () => ({
          from: () => ({
            where: (..._args: any[]) => {
              callCount++;
              // First call is getBiasCorrection (returns .limit()), second is getHistoricalHitRate (returns array)
              if (callCount === 1) {
                // Bias query: .where().limit()
                return { limit: () => Promise.resolve([]) };
              }
              // Hit rate query: .where() returns rows directly
              const rows = [
                { actualOutcome: 1 },
                { actualOutcome: 1 },
                { actualOutcome: 0 },
                { actualOutcome: 0 },
                { actualOutcome: 0 },
              ];
              const result = Promise.resolve(rows);
              (result as any).limit = () => Promise.resolve(rows);
              return result;
            },
          }),
        }),
      }),
    }));

    const estimator = new ProbabilityEstimator();
    const ensemble = [28, 29, 30, 30, 30, 30, 30, 31, 32, 33];
    const market = {
      ticker: "KXHIGHNY-25FEB19-B30",
      stationId: "KNYC",
      category: "high_temp",
      bracketLow: 30,
      bracketHigh: 31,
      targetDate: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
    } as any;

    const result = await estimator.estimate(market, ensemble);
    expect(result.reasoning.historicalHitRate).toBe(0.4);
  });
});
