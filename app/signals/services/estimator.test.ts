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
});

function makePrecipMarket(overrides: Partial<any> = {}) {
  return {
    ticker: "KXRAINNY-26MAR21-T0.1",
    stationId: "KNYC",
    category: "precip",
    bracketLow: 0.1,
    bracketHigh: 0.25,
    targetDate: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
    ...overrides,
  } as any;
}

function makeSnowMarket(overrides: Partial<any> = {}) {
  return {
    ticker: "KXSNOWNY-26MAR21-T1",
    stationId: "KNYC",
    category: "snowfall",
    bracketLow: 1,
    bracketHigh: 3,
    targetDate: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
    ...overrides,
  } as any;
}

describe("ProbabilityEstimator — precip/snow", () => {
  test("precip: uses empirical counting, not normal CDF", async () => {
    const estimator = new ProbabilityEstimator();
    // 3 out of 10 members are in [0.1, 0.25)
    const ensemble = [0, 0, 0, 0.05, 0.12, 0.15, 0.2, 0.3, 0.5, 1.0];

    const result = await estimator.estimate(makePrecipMarket(), ensemble);

    // Empirical: 3/10 = 0.3. CDF should equal counting for precip.
    expect(result.reasoning.cdfProbability).toBe(result.reasoning.countingProbability);
    expect(result.probability).toBe(result.reasoning.countingProbability);
    expect(result.reasoning.membersInBracket).toBe(3);
  });

  test("precip: clamps negative values to zero after bias correction", async () => {
    const db = getDb();
    // Insert a positive bias (model runs wet) → correction subtracts, could go negative
    db.insert(stationBias).values({
      id: "KNYC_precip_1",
      stationId: "KNYC",
      category: "precip",
      forecastHorizonDays: 1,
      meanBias: 0.2,
      stdBias: 0.1,
      sampleSize: 50,
      windowDays: 30,
      updatedAt: new Date().toISOString(),
    }).run();

    const estimator = new ProbabilityEstimator();
    // After subtracting 0.2 bias: [0.05→-0.15, 0.1→-0.1, 0.15→-0.05, 0.35→0.15, 0.8→0.6]
    // After clamping at 0: [0, 0, 0, 0.15, 0.6]
    const ensemble = [0.05, 0.1, 0.15, 0.35, 0.8];

    const result = await estimator.estimate(makePrecipMarket(), ensemble);

    // Members in [0.1, 0.25): just 0.15 → 1 out of 5
    expect(result.reasoning.membersInBracket).toBe(1);
    expect(result.reasoning.biasCorrection).not.toBeNull();
    expect(result.reasoning.biasCorrection!.meanBias).toBe(0.2);
  });

  test("precip: zero-heavy ensemble gets correct zero-rain probability", async () => {
    const estimator = new ProbabilityEstimator();
    // 7 out of 10 members predict no rain at all
    const ensemble = [0, 0, 0, 0, 0, 0, 0, 0.05, 0.12, 0.3];

    // Market: will precip be >= 0.1 inches?
    const market = makePrecipMarket({ bracketLow: 0.1, bracketHigh: Infinity });
    const result = await estimator.estimate(market, ensemble);

    // Only 2/10 members >= 0.1 → P = 0.2
    expect(result.reasoning.countingProbability).toBe(0.2);
    expect(result.probability).toBe(0.2);
  });

  test("snowfall: uses empirical counting", async () => {
    const estimator = new ProbabilityEstimator();
    // Most members predict no snow, a few predict significant snow
    const ensemble = [0, 0, 0, 0, 0, 0, 0, 1.5, 4, 8];

    const result = await estimator.estimate(makeSnowMarket(), ensemble);

    // Members in [1, 3): just 1.5 → 1 out of 10
    expect(result.reasoning.cdfProbability).toBe(result.reasoning.countingProbability);
    expect(result.reasoning.membersInBracket).toBe(1);
  });

  test("snowfall: clamps negative values to zero", async () => {
    const estimator = new ProbabilityEstimator();
    // Some ensemble members might have slightly negative values from model artifacts
    const ensemble = [-0.5, -0.1, 0, 0, 0, 1.5, 2, 3, 5, 8];

    const result = await estimator.estimate(makeSnowMarket(), ensemble);

    // After clamping: [0, 0, 0, 0, 0, 1.5, 2, 3, 5, 8]
    // Members in [1, 3): 1.5 and 2 → 2 out of 10
    expect(result.reasoning.membersInBracket).toBe(2);
  });

  test("per-category bias: precip bias doesn't affect temperature", async () => {
    const db = getDb();
    db.insert(stationBias).values({
      id: "KNYC_precip_1",
      stationId: "KNYC",
      category: "precip",
      forecastHorizonDays: 1,
      meanBias: 0.5,
      stdBias: 0.1,
      sampleSize: 50,
      windowDays: 30,
      updatedAt: new Date().toISOString(),
    }).run();

    const estimator = new ProbabilityEstimator();
    // Temperature market should NOT pick up the precip bias
    const tempResult = await estimator.estimate(makeMarket(), [28, 29, 30, 30, 31]);
    expect(tempResult.reasoning.biasCorrection).toBeNull();
  });
});
