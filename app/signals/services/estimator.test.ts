import { test, expect, describe, mock } from "bun:test";
import { mean, std, ProbabilityEstimator } from "./estimator";

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

    // 5 out of 10 members are in [30, 31)
    expect(result.probability).toBe(0.5);
    expect(result.ensembleSize).toBe(10);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.reasoning.membersInBracket).toBe(5);
    // No calibration data → null
    expect(result.reasoning.historicalHitRate).toBeNull();
  });

  test("estimate with no members in bracket returns 0", async () => {
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
    expect(result.probability).toBe(0);
  });

  test("estimate throws for missing station/bracket data", async () => {
    const estimator = new ProbabilityEstimator();
    const market = { ticker: "TEST", stationId: null, bracketLow: null, bracketHigh: null } as any;

    expect(estimator.estimate(market, [1, 2, 3])).rejects.toThrow(
      "missing station/bracket data"
    );
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
