import { test, expect, describe, beforeEach } from "bun:test";
import { mean, std, erf, normalCdf, ProbabilityEstimator } from "./estimator";
import { runMigrations, getDb, calibration, stationBias } from "@kcb/db";

// Use real in-memory DB — DO NOT mock @kcb/db, it leaks globally
runMigrations();

beforeEach(() => {
  const db = getDb();
  db.delete(calibration).run();
  db.delete(stationBias).run();
});

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
    expect(std([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });

  test("symmetric distribution", () => {
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

function makeCalibrationRow(overrides: Partial<any> = {}) {
  return {
    id: crypto.randomUUID(),
    ticker: "KXHIGHNY-25FEB19-B30",
    seriesTicker: "KXHIGHNY",
    category: "high_temp",
    stationId: "KNYC",
    predictedProb: 0.5,
    actualOutcome: 1,
    marketPrice: 0.5,
    edge: 0.1,
    traded: false,
    resolvedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMarket() {
  return {
    ticker: "KXHIGHNY-25FEB19-B30",
    stationId: "KNYC",
    category: "high_temp",
    bracketLow: 30,
    bracketHigh: 31,
    targetDate: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
  } as any;
}

describe("ProbabilityEstimator", () => {
  test("estimate computes bracket probability from ensemble", async () => {
    const estimator = new ProbabilityEstimator();
    const ensemble = [28, 29, 30, 30, 30, 30, 30, 31, 32, 33];

    const result = await estimator.estimate(makeMarket(), ensemble);

    expect(result.reasoning.countingProbability).toBe(0.5);
    expect(result.reasoning.cdfProbability).toBeGreaterThan(0);
    expect(result.reasoning.cdfProbability).toBeLessThan(1);
    expect(result.probability).toBeGreaterThan(0);
    expect(result.probability).toBeLessThan(1);
    expect(result.ensembleSize).toBe(10);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.reasoning.membersInBracket).toBe(5);
    expect(result.reasoning.historicalHitRate).toBeNull();
  });

  test("ensemble far below bracket → probability near 0", async () => {
    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14];

    const result = await estimator.estimate(makeMarket(), ensemble);

    expect(result.reasoning.countingProbability).toBe(0);
    expect(result.reasoning.cdfProbability).toBeCloseTo(0, 4);
    expect(result.probability).toBeCloseTo(0, 4);
  });

  test("estimate throws for missing station/bracket data", async () => {
    const estimator = new ProbabilityEstimator();
    const market = { ticker: "TEST", stationId: null, bracketLow: null, bracketHigh: null } as any;

    expect(estimator.estimate(market, [1, 2, 3])).rejects.toThrow("missing station/bracket data");
  });

  test("ensemble centered on bracket → blended between counting and CDF", async () => {
    const estimator = new ProbabilityEstimator();
    const ensemble = Array.from({ length: 50 }, (_, i) => 28 + i * 0.1);

    const result = await estimator.estimate(makeMarket(), ensemble);

    expect(result.reasoning.countingProbability).toBeGreaterThan(0);
    expect(result.reasoning.cdfProbability).toBeGreaterThan(0);
    const lo = Math.min(result.reasoning.countingProbability, result.reasoning.cdfProbability);
    const hi = Math.max(result.reasoning.countingProbability, result.reasoning.cdfProbability);
    expect(result.probability).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(result.probability).toBeLessThanOrEqual(hi + 1e-9);
  });

  test("zero-spread ensemble → falls back to counting", async () => {
    const estimator = new ProbabilityEstimator();
    const ensemble = [30.5, 30.5, 30.5, 30.5, 30.5];

    const result = await estimator.estimate(makeMarket(), ensemble);

    expect(result.reasoning.countingProbability).toBe(1);
    expect(result.reasoning.cdfProbability).toBe(result.reasoning.countingProbability);
    expect(result.probability).toBe(1);
  });
});

describe("getHistoricalHitRate", () => {
  test("returns null when fewer than 5 calibration rows", async () => {
    const db = getDb();
    for (let i = 0; i < 3; i++) {
      db.insert(calibration).values(makeCalibrationRow({ actualOutcome: i % 2 })).run();
    }

    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBeNull();
  });

  test("returns hit rate when sufficient data", async () => {
    const db = getDb();
    // 3 hits out of 5
    for (const outcome of [1, 1, 1, 0, 0]) {
      db.insert(calibration).values(makeCalibrationRow({ actualOutcome: outcome })).run();
    }

    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBe(0.6);
  });

  test("returns 1.0 when all outcomes are YES", async () => {
    const db = getDb();
    for (let i = 0; i < 5; i++) {
      db.insert(calibration).values(makeCalibrationRow({ actualOutcome: 1 })).run();
    }

    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBe(1.0);
  });

  test("returns 0.0 when all outcomes are NO", async () => {
    const db = getDb();
    for (let i = 0; i < 5; i++) {
      db.insert(calibration).values(makeCalibrationRow({ actualOutcome: 0 })).run();
    }

    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBe(0.0);
  });

  test("returns null when no calibration data", async () => {
    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBeNull();
  });

  test("estimate includes historicalHitRate when data available", async () => {
    const db = getDb();
    for (const outcome of [1, 1, 0, 0, 0]) {
      db.insert(calibration).values(makeCalibrationRow({ actualOutcome: outcome })).run();
    }

    const estimator = new ProbabilityEstimator();
    const ensemble = [28, 29, 30, 30, 30, 30, 30, 31, 32, 33];

    const result = await estimator.estimate(makeMarket(), ensemble);
    expect(result.reasoning.historicalHitRate).toBe(0.4);
  });
});
