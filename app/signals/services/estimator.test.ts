import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import {
  mean,
  std,
  erf,
  normalCdf,
  ProbabilityEstimator,
  localHourAtStation,
  estimateDiurnalOffset,
  medianRegularBracketWidth,
  cdfProbForMarket,
  countMembersInMarket,
} from "./estimator";
import { runMigrations, getDb, calibration, stationBias, markets } from "@kcb/db";
import { getConfig } from "@kcb/config";

// Use real in-memory DB — DO NOT mock @kcb/db, it leaks globally
runMigrations();

beforeEach(() => {
  const db = getDb();
  db.delete(calibration).run();
  db.delete(stationBias).run();
  db.delete(markets).run();
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

/** Insert a markets row matching the given ticker/bracket so that the
 *  bracket-filtered getHistoricalHitRate join finds it. Defaults match the
 *  default makeCalibrationRow ticker + 30-31°F bracket. */
function seedMarketRow(overrides: Partial<any> = {}) {
  const db = getDb();
  const row = {
    ticker: "KXHIGHNY-25FEB19-B30",
    eventTicker: "KXHIGHNY-25FEB19",
    seriesTicker: "KXHIGHNY",
    title: "test market",
    category: "high_temp",
    stationId: "KNYC",
    targetDate: "2025-02-19",
    bracketLow: 30,
    bracketHigh: 31,
    marketType: "bracket",
    status: "settled",
    discoveredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  db.insert(markets).values(row).onConflictDoNothing().run();
  return row;
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

  test("ensemble far below bracket → raw probability near 0 (floored to 0.03)", async () => {
    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14];

    const result = await estimator.estimate(makeMarket(), ensemble);

    expect(result.reasoning.countingProbability).toBe(0);
    expect(result.reasoning.cdfProbability).toBeCloseTo(0, 4);
    // Returned probability is floored without empirical bias data
    expect(result.probability).toBeCloseTo(0.03, 6);
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

  test("zero-spread ensemble → falls back to counting (floored to 0.97)", async () => {
    // Pin the sigma floor off: this test covers the sigmaUsed === 0 counting
    // fallback, which the plan-#4 floor intentionally makes unreachable for
    // temperature markets (zero model spread ≠ certainty). Floored behavior
    // has its own describe block below.
    const originalFloor = getConfig().bot.sigmaFloorBracketWidthFactor;
    getConfig().bot.sigmaFloorBracketWidthFactor = 0;
    try {
      const estimator = new ProbabilityEstimator();
      const ensemble = [30.5, 30.5, 30.5, 30.5, 30.5];

      const result = await estimator.estimate(makeMarket(), ensemble);

      expect(result.reasoning.countingProbability).toBe(1);
      expect(result.reasoning.cdfProbability).toBe(result.reasoning.countingProbability);
      // Returned probability is capped at 0.97 without empirical bias data
      expect(result.probability).toBe(0.97);
    } finally {
      getConfig().bot.sigmaFloorBracketWidthFactor = originalFloor;
    }
  });

  test("zero-spread ensemble WITH sigma floor → CDF replaces false certainty", async () => {
    // The floored counterpart of the test above: 200 members all saying 30.5
    // is model clustering, not certainty. Floor 0.6F → CDF over the 30-31
    // bracket ≈ Φ(0.83) − Φ(−0.83) ≈ 0.595 instead of counting's 1.0.
    const originalFloor = getConfig().bot.sigmaFloorBracketWidthFactor;
    getConfig().bot.sigmaFloorBracketWidthFactor = 0.6;
    try {
      const estimator = new ProbabilityEstimator();
      const ensemble = Array.from({ length: 200 }, () => 30.5);

      const result = await estimator.estimate(makeMarket(), ensemble);

      expect(result.reasoning.countingProbability).toBe(1);
      expect(result.reasoning.sigmaFloorApplied).toBeCloseTo(0.6, 6);
      expect(result.probability).toBeGreaterThan(0.5);
      expect(result.probability).toBeLessThan(0.7);
    } finally {
      getConfig().bot.sigmaFloorBracketWidthFactor = originalFloor;
    }
  });
});

describe("ProbabilityEstimator — historical prior blend", () => {
  const originalWeight = getConfig().bot.historicalPriorWeight;

  afterEach(() => {
    getConfig().bot.historicalPriorWeight = originalWeight;
  });

  test("weight=0 leaves probability unchanged even when historical rate exists", async () => {
    const db = getDb();
    seedMarketRow();
    for (const outcome of [1, 1, 1, 1, 1, 0, 0, 0, 0, 0]) {
      db.insert(calibration).values(makeCalibrationRow({ actualOutcome: outcome })).run();
    }
    getConfig().bot.historicalPriorWeight = 0;

    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14]; // far below bracket → raw prob ~0
    const result = await estimator.estimate(makeMarket(), ensemble);

    expect(result.reasoning.historicalHitRate).toBe(0.5);
    expect(result.reasoning.historicalPriorBlend).toBeNull();
    expect(result.probability).toBeCloseTo(0.03, 6); // unchanged floor
  });

  test("weight>0 blends raw probability toward historical hit rate", async () => {
    const db = getDb();
    seedMarketRow();
    for (const outcome of [1, 1, 1, 1, 1, 0, 0, 0, 0, 0]) {
      db.insert(calibration).values(makeCalibrationRow({ actualOutcome: outcome })).run();
    }
    getConfig().bot.historicalPriorWeight = 0.3;

    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14]; // raw prob near 0
    const result = await estimator.estimate(makeMarket(), ensemble);

    expect(result.reasoning.historicalHitRate).toBe(0.5);
    expect(result.reasoning.historicalPriorBlend).not.toBeNull();
    expect(result.reasoning.historicalPriorBlend!.weight).toBe(0.3);
    // blended = 0.7 * ~0 + 0.3 * 0.5 = ~0.15
    expect(result.probability).toBeGreaterThan(0.13);
    expect(result.probability).toBeLessThan(0.17);
  });

  test("weight>0 but historicalHitRate null → no blend applied", async () => {
    getConfig().bot.historicalPriorWeight = 0.5;

    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14];
    const result = await estimator.estimate(makeMarket(), ensemble);

    expect(result.reasoning.historicalHitRate).toBeNull();
    expect(result.reasoning.historicalPriorBlend).toBeNull();
    expect(result.probability).toBeCloseTo(0.03, 6);
  });

  test("weight clamped to [0, 1]", async () => {
    const db = getDb();
    seedMarketRow();
    for (const outcome of [1, 1, 1, 1, 1, 0, 0, 0, 0, 0]) {
      db.insert(calibration).values(makeCalibrationRow({ actualOutcome: outcome })).run();
    }
    getConfig().bot.historicalPriorWeight = 2; // nonsense, should clamp to 1

    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14];
    const result = await estimator.estimate(makeMarket(), ensemble);

    // weight=1 → probability equals historical rate (0.5)
    expect(result.reasoning.historicalPriorBlend!.weight).toBe(1);
    expect(result.probability).toBeCloseTo(0.5, 6);
  });
});

describe("ProbabilityEstimator — market prior blend (adaptive ramp)", () => {
  const original = {
    marketPriorWeight: getConfig().bot.marketPriorWeight,
    marketPriorMaxWeight: getConfig().bot.marketPriorMaxWeight,
    marketPriorRampStart: getConfig().bot.marketPriorRampStart,
    marketPriorRampEnd: getConfig().bot.marketPriorRampEnd,
    historicalPriorWeight: getConfig().bot.historicalPriorWeight,
  };

  // Pin the ramp knobs to the documented defaults so each test is hermetic
  // against runtime config drift (the live values may differ from the schema
  // defaults). Individual tests override what they need to exercise.
  beforeEach(() => {
    const bot = getConfig().bot;
    bot.marketPriorWeight = 0.3;
    bot.marketPriorMaxWeight = 0.7;
    bot.marketPriorRampStart = 0.3;
    bot.marketPriorRampEnd = 0.6;
    bot.historicalPriorWeight = 0;
  });

  afterEach(() => {
    Object.assign(getConfig().bot, original);
  });

  test("weight=0 leaves probability unchanged regardless of other ramp knobs", async () => {
    const bot = getConfig().bot;
    bot.marketPriorWeight = 0; // outer gate off → ship-dark
    bot.marketPriorMaxWeight = 0.9; // should be ignored entirely
    bot.marketPriorRampStart = 0.0;
    bot.marketPriorRampEnd = 0.1;

    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14]; // raw prob ~0
    const result = await estimator.estimate(makeMarket(), ensemble, undefined, 0.75);

    expect(result.reasoning.marketPriorBlend).toBeNull();
    expect(result.probability).toBeCloseTo(0.03, 6); // unchanged tail floor
  });

  test("disagreement ≤ rampStart → weight stays at base (0.3)", async () => {
    // Construct a tiny disagreement: set marketPrice equal to the model's
    // pre-blend probability (~0.03 floor) so |pModel − pMarket| ≈ 0 ≤ rampStart.
    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14]; // raw prob ~0, floored to 0.03
    const result = await estimator.estimate(makeMarket(), ensemble, undefined, 0.03);

    const blend = result.reasoning.marketPriorBlend!;
    expect(blend).not.toBeNull();
    expect(blend.baseWeight).toBe(0.3);
    expect(blend.disagreement).toBeLessThanOrEqual(0.3);
    expect(blend.weight).toBeCloseTo(0.3, 6); // base, no ramp
  });

  test("disagreement = ramp midpoint (0.45) → weight ≈ 0.5", async () => {
    // Disagreement is measured against the *pre-floor* blended probability,
    // which is exactly 0 for this far-below-bracket ensemble (the 0.03 tail
    // floor is applied only after the market blend). So marketPrice 0.45 yields
    // disagreement 0.45 = midpoint of [0.30, 0.60] → t=0.5 → weight 0.5.
    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14]; // raw (pre-floor) prob = 0
    const marketPrice = 0.45; // disagreement = 0.45 − 0 = 0.45
    const result = await estimator.estimate(makeMarket(), ensemble, undefined, marketPrice);

    const blend = result.reasoning.marketPriorBlend!;
    expect(blend.probabilityBefore).toBeCloseTo(0, 6);
    expect(blend.disagreement).toBeCloseTo(0.45, 6);
    expect(blend.weight).toBeCloseTo(0.5, 6);
    // probabilityAfter = (1-0.5)*0 + 0.5*0.45 = 0.225
    expect(blend.probabilityAfter).toBeCloseTo(0.225, 6);
  });

  test("disagreement ≥ rampEnd → weight saturates at max (0.7)", async () => {
    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14]; // pre-blend ~0.03
    const result = await estimator.estimate(makeMarket(), ensemble, undefined, 0.8);

    const blend = result.reasoning.marketPriorBlend!;
    expect(blend.disagreement).toBeGreaterThanOrEqual(0.6);
    expect(blend.weight).toBeCloseTo(0.7, 6);
    expect(blend.marketPrice).toBe(0.8);
  });

  test("marketPriorMaxWeight < base → effective max = base (flat, never decreases)", async () => {
    const bot = getConfig().bot;
    bot.marketPriorWeight = 0.5;
    bot.marketPriorMaxWeight = 0.2; // nonsensically below base → must clamp up to base

    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14];
    // Large disagreement (would ramp if max>base) but max is pinned to base.
    const result = await estimator.estimate(makeMarket(), ensemble, undefined, 0.9);

    const blend = result.reasoning.marketPriorBlend!;
    expect(blend.baseWeight).toBe(0.5);
    expect(blend.weight).toBeCloseTo(0.5, 6); // flat — ramp can't pull below base
  });

  test("base weight clamped to [0, 1] (out-of-range → 1, fully follows market)", async () => {
    const bot = getConfig().bot;
    bot.marketPriorWeight = 2; // nonsense → clamp01 → 1; max(base, ...) = 1
    bot.marketPriorMaxWeight = 0.7;

    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14];
    const result = await estimator.estimate(makeMarket(), ensemble, undefined, 0.75);

    expect(result.reasoning.marketPriorBlend!.weight).toBeCloseTo(1, 6);
    expect(result.probability).toBeCloseTo(0.75, 6); // weight=1 → fully market
  });

  test("marketPrice undefined → no blend applied", async () => {
    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14];
    const result = await estimator.estimate(makeMarket(), ensemble); // no marketPrice arg

    expect(result.reasoning.marketPriorBlend).toBeNull();
    expect(result.probability).toBeCloseTo(0.03, 6);
  });

  test("trace exposes baseWeight, disagreement, and effective weight", async () => {
    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14]; // raw (pre-floor) prob = 0
    const result = await estimator.estimate(makeMarket(), ensemble, undefined, 0.45);

    const blend = result.reasoning.marketPriorBlend!;
    expect(blend.baseWeight).toBe(0.3);
    expect(blend.disagreement).toBeCloseTo(0.45, 6);
    expect(blend.weight).toBeCloseTo(0.5, 6);
    expect(blend.marketPrice).toBe(0.45);
    expect(blend.probabilityBefore).toBeCloseTo(0, 6);
    // probabilityAfter is internally consistent with the reported weight.
    const expectedAfter =
      (1 - blend.weight) * blend.probabilityBefore + blend.weight * blend.marketPrice;
    expect(blend.probabilityAfter).toBeCloseTo(expectedAfter, 6);
  });

  test("disagreement is measured AFTER the historical-prior blend", async () => {
    const db = getDb();
    seedMarketRow();
    for (const outcome of [1, 1, 1, 1, 1, 0, 0, 0, 0, 0]) {
      db.insert(calibration).values(makeCalibrationRow({ actualOutcome: outcome })).run();
    }
    getConfig().bot.historicalPriorWeight = 0.3;

    const estimator = new ProbabilityEstimator();
    const ensemble = [10, 11, 12, 13, 14]; // raw prob ~0
    // Historical blend lifts ~0 toward 0.5 at weight 0.3 → before ≈ 0.15.
    // marketPrice 0.9 → disagreement ≈ 0.75 ≥ rampEnd → weight saturates at 0.7.
    const result = await estimator.estimate(makeMarket(), ensemble, undefined, 0.9);

    const blend = result.reasoning.marketPriorBlend!;
    expect(result.reasoning.historicalPriorBlend).not.toBeNull();
    expect(blend.probabilityBefore).toBeGreaterThan(0.13);
    expect(blend.probabilityBefore).toBeLessThan(0.17);
    expect(blend.disagreement).toBeGreaterThanOrEqual(0.6);
    expect(blend.weight).toBeCloseTo(0.7, 6);
    // after ≈ 0.3*0.15 + 0.7*0.9 = ~0.675
    expect(result.probability).toBeGreaterThan(0.64);
    expect(result.probability).toBeLessThan(0.71);
  });

  test("KNYC 2026-06-05 scenario: model ~0.19 vs market 0.80 → final ~0.62, NO edge < 0.25", async () => {
    // Reconstruct the loss the ramp targets. We need a raw model prob ≈ 0.19 on
    // a bracket with market 0.80. Use a 21-member ensemble where 4/21 land in
    // the 30–31 bracket (counting ≈ 0.19) and the CDF agrees closely, so the
    // pre-blend probability is ≈ 0.19 (no empirical bias seeded → CDF/counting
    // blend, no historical prior). Disagreement 0.80 − 0.19 = 0.61 ≥ rampEnd
    // → weight 0.7 → blended ≈ 0.3*0.19 + 0.7*0.80 ≈ 0.617.
    const estimator = new ProbabilityEstimator();
    // 4 members in [30,31): four 30.5's; the rest sit well outside the bracket
    // and roughly symmetric around it so the normal CDF over [30,31) ≈ counting.
    const ensemble = [
      30.5, 30.5, 30.5, 30.5, // 4 inside
      26, 26.5, 27, 27.5, 28, 28.5, 29, 29.5, // below
      32, 32.5, 33, 33.5, 34, 34.5, 35, 35.5, 36, // above
    ];
    const result = await estimator.estimate(makeMarket(), ensemble, undefined, 0.8);

    const blend = result.reasoning.marketPriorBlend!;
    // Pre-blend model probability is in the low-0.2s (the "false edge" zone).
    expect(blend.probabilityBefore).toBeLessThan(0.25);
    expect(blend.weight).toBeCloseTo(0.7, 6); // saturated by the large disagreement
    // Final probability lands near 0.62 and, critically, above 0.55 so the NO
    // edge (0.80 − p) drops below the 0.25 disagreement cap → correctly dropped.
    expect(result.probability).toBeCloseTo(0.617, 2);
    expect(result.probability).toBeGreaterThan(0.55);
    expect(0.8 - result.probability).toBeLessThan(0.25);
  });

  test("sourceMix (N5): carried into the trace when provided, null otherwise", async () => {
    const estimator = new ProbabilityEstimator();
    const ensemble = [28, 29, 30, 30, 31, 32];

    // Provided → stored verbatim
    const mix = { hrrr: 105, gfs: 22, ecmwf: 23, tomorrow_io: 1 };
    const withMix = await estimator.estimate(makeMarket(), ensemble, undefined, undefined, mix);
    expect(withMix.reasoning.sourceMix).toEqual(mix);

    // Omitted → null (back-compat; does not affect probability)
    const withoutMix = await estimator.estimate(makeMarket(), ensemble);
    expect(withoutMix.reasoning.sourceMix).toBeNull();
    expect(withMix.probability).toBeCloseTo(withoutMix.probability, 10);
  });
});

describe("getHistoricalHitRate", () => {
  test("returns null when fewer than 5 matching calibration rows", async () => {
    const db = getDb();
    seedMarketRow();
    for (let i = 0; i < 3; i++) {
      db.insert(calibration).values(makeCalibrationRow({ actualOutcome: i % 2 })).run();
    }

    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBeNull();
  });

  test("returns hit rate when sufficient data", async () => {
    const db = getDb();
    seedMarketRow();
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
    seedMarketRow();
    for (let i = 0; i < 5; i++) {
      db.insert(calibration).values(makeCalibrationRow({ actualOutcome: 1 })).run();
    }

    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBe(1.0);
  });

  test("returns 0.0 when all outcomes are NO", async () => {
    const db = getDb();
    seedMarketRow();
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

  test("filters out brackets whose center is outside the ±3°F tolerance", async () => {
    const db = getDb();
    // Seed 6 rows: 3 close brackets (center 30.5, within tolerance of query 30.5)
    // and 3 far brackets (center 50.5, far outside ±3°F). Far rows are all YES;
    // close rows are all NO. Only the close NO rows should be counted.
    seedMarketRow({ ticker: "KXHIGHNY-CLOSE-B30", bracketLow: 30, bracketHigh: 31 });
    seedMarketRow({ ticker: "KXHIGHNY-FAR-B50", bracketLow: 50, bracketHigh: 51 });
    for (let i = 0; i < 5; i++) {
      db.insert(calibration).values(makeCalibrationRow({
        id: `close-${i}`,
        ticker: "KXHIGHNY-CLOSE-B30",
        actualOutcome: 0, // NO
      })).run();
    }
    for (let i = 0; i < 5; i++) {
      db.insert(calibration).values(makeCalibrationRow({
        id: `far-${i}`,
        ticker: "KXHIGHNY-FAR-B50",
        actualOutcome: 1, // YES — should be filtered out
      })).run();
    }

    const estimator = new ProbabilityEstimator();
    // Query center = 30.5. Tolerance ±3°F → matches B30 (center 30.5),
    // excludes B50 (center 50.5, distance 20°F).
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBe(0); // only close NO rows counted
  });

  test("includes brackets at the edge of the ±3°F tolerance", async () => {
    const db = getDb();
    // Query bracket 30-31 (center 30.5). Edge bracket 33-34 (center 33.5,
    // distance 3.0) should match. Edge bracket 34-35 (center 34.5, distance
    // 4.0) should NOT match.
    seedMarketRow({ ticker: "KXHIGHNY-EDGE-B33", bracketLow: 33, bracketHigh: 34 });
    seedMarketRow({ ticker: "KXHIGHNY-OUT-B34", bracketLow: 34, bracketHigh: 35 });
    for (let i = 0; i < 5; i++) {
      db.insert(calibration).values(makeCalibrationRow({
        id: `edge-${i}`, ticker: "KXHIGHNY-EDGE-B33", actualOutcome: 1,
      })).run();
    }
    for (let i = 0; i < 5; i++) {
      db.insert(calibration).values(makeCalibrationRow({
        id: `out-${i}`, ticker: "KXHIGHNY-OUT-B34", actualOutcome: 0,
      })).run();
    }

    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBe(1.0); // only EDGE bracket rows (all YES) counted
  });

  test("tail markets only match other tails by threshold proximity", async () => {
    const db = getDb();
    // Tail query: bracketLow=79, bracketHigh=null (upper_tail >79°)
    // Should match: other tail markets within ±3°F of threshold
    // Should NOT match: regular bracket markets even at similar position
    seedMarketRow({
      ticker: "KXHIGHNY-TAIL-T79", bracketLow: 79, bracketHigh: null, marketType: "upper_tail",
    });
    seedMarketRow({
      ticker: "KXHIGHNY-BRACKET-B79", bracketLow: 79, bracketHigh: 80, marketType: "bracket",
    });
    for (let i = 0; i < 5; i++) {
      db.insert(calibration).values(makeCalibrationRow({
        id: `tail-${i}`, ticker: "KXHIGHNY-TAIL-T79", actualOutcome: 1,
      })).run();
    }
    for (let i = 0; i < 5; i++) {
      db.insert(calibration).values(makeCalibrationRow({
        id: `brk-${i}`, ticker: "KXHIGHNY-BRACKET-B79", actualOutcome: 0,
      })).run();
    }

    const estimator = new ProbabilityEstimator();
    // Tail query with bracketHigh=null
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 79, null);
    expect(result).toBe(1.0); // only tail rows counted, all YES
  });

  test("bracket query excludes tail-market rows", async () => {
    const db = getDb();
    // Mirror of the above: bracket query should NOT pick up tail-market rows.
    seedMarketRow({
      ticker: "KXHIGHNY-B30", bracketLow: 30, bracketHigh: 31, marketType: "bracket",
    });
    seedMarketRow({
      ticker: "KXHIGHNY-T31", bracketLow: 31, bracketHigh: null, marketType: "upper_tail",
    });
    for (let i = 0; i < 5; i++) {
      db.insert(calibration).values(makeCalibrationRow({
        id: `brk-${i}`, ticker: "KXHIGHNY-B30", actualOutcome: 0,
      })).run();
    }
    for (let i = 0; i < 5; i++) {
      db.insert(calibration).values(makeCalibrationRow({
        id: `tail-${i}`, ticker: "KXHIGHNY-T31", actualOutcome: 1,
      })).run();
    }

    const estimator = new ProbabilityEstimator();
    const result = await estimator.getHistoricalHitRate("KNYC", "high_temp", 30, 31);
    expect(result).toBe(0.0); // only bracket rows counted, all NO
  });
});

function makeUpperTailMarket(overrides: Partial<any> = {}) {
  return {
    ticker: "KXHIGHNY-26APR01-T79",
    stationId: "KNYC",
    category: "high_temp",
    bracketLow: 79,
    bracketHigh: null,
    marketType: "upper_tail",
    targetDate: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
    ...overrides,
  } as any;
}

function makeLowerTailMarket(overrides: Partial<any> = {}) {
  return {
    ticker: "KXHIGHNY-26MAR17-T56",
    stationId: "KNYC",
    category: "high_temp",
    bracketLow: 56,
    bracketHigh: null,
    marketType: "lower_tail",
    targetDate: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
    ...overrides,
  } as any;
}

describe("ProbabilityEstimator — threshold (tail) markets", () => {
  test("upper_tail: P(temp > threshold) via CDF", async () => {
    const estimator = new ProbabilityEstimator();
    // mean=80, std≈2 → P(temp > 79) should be around 0.69
    const ensemble = [77, 78, 79, 79, 80, 80, 80, 81, 82, 83];

    const result = await estimator.estimate(makeUpperTailMarket(), ensemble);

    // Counting: 6/10 members > 79
    expect(result.reasoning.membersInBracket).toBe(6);
    expect(result.reasoning.countingProbability).toBe(0.6);
    // CDF: P(temp > 79) = 1 - normalCdf(79, mean, std)
    expect(result.reasoning.cdfProbability).toBeGreaterThan(0.4);
    expect(result.reasoning.cdfProbability).toBeLessThan(0.9);
    expect(result.probability).toBeGreaterThan(0.4);
  });

  test("lower_tail: P(temp < threshold) via CDF", async () => {
    const estimator = new ProbabilityEstimator();
    // mean=59, std≈2.3 → P(temp < 56) should be ~10%
    // This is the T56 scenario that caused the $460 loss
    const ensemble = [55, 57, 58, 58, 59, 59, 60, 60, 61, 63];

    const result = await estimator.estimate(makeLowerTailMarket(), ensemble);

    // Counting: 1/10 members < 56
    expect(result.reasoning.membersInBracket).toBe(1);
    expect(result.reasoning.countingProbability).toBe(0.1);
    // CDF: P(temp < 56) = normalCdf(56, mean, std)
    expect(result.reasoning.cdfProbability).toBeGreaterThan(0.02);
    expect(result.reasoning.cdfProbability).toBeLessThan(0.3);
  });

  test("upper_tail: ensemble well below threshold → raw near 0 (floored to 0.03)", async () => {
    const estimator = new ProbabilityEstimator();
    const ensemble = [60, 61, 62, 63, 64];

    const result = await estimator.estimate(makeUpperTailMarket(), ensemble);

    // All members below 79 → P(temp > 79) ≈ 0
    expect(result.reasoning.countingProbability).toBe(0);
    expect(result.reasoning.cdfProbability).toBeCloseTo(0, 2);
    // Returned probability floored at 0.03 without empirical bias data
    expect(result.probability).toBeCloseTo(0.03, 6);
  });

  test("lower_tail: ensemble well above threshold → raw near 0 (floored to 0.03)", async () => {
    const estimator = new ProbabilityEstimator();
    const ensemble = [70, 71, 72, 73, 74];

    const result = await estimator.estimate(makeLowerTailMarket(), ensemble);

    // All members above 56 → P(temp < 56) ≈ 0
    expect(result.reasoning.countingProbability).toBe(0);
    expect(result.reasoning.cdfProbability).toBeCloseTo(0, 2);
    expect(result.probability).toBeCloseTo(0.03, 6);
  });

  test("upper_tail: ensemble well above threshold → raw near 1 (capped at 0.97)", async () => {
    const estimator = new ProbabilityEstimator();
    const ensemble = [85, 86, 87, 88, 89];

    const result = await estimator.estimate(makeUpperTailMarket(), ensemble);

    // All members above 79 → P(temp > 79) ≈ 1
    expect(result.reasoning.countingProbability).toBe(1);
    expect(result.reasoning.cdfProbability).toBeCloseTo(1, 2);
    expect(result.probability).toBeCloseTo(0.97, 6);
  });

  test("tail market does not require bracketHigh", async () => {
    const estimator = new ProbabilityEstimator();
    const market = makeUpperTailMarket({ bracketHigh: null });
    const ensemble = [77, 78, 79, 80, 81];

    // Should not throw despite bracketHigh being null
    const result = await estimator.estimate(market, ensemble);
    expect(result.probability).toBeGreaterThan(0);
  });

  test("bracket market still requires bracketHigh", async () => {
    const estimator = new ProbabilityEstimator();
    const market = makeMarket();
    market.bracketHigh = null;
    market.marketType = "bracket";

    expect(estimator.estimate(market, [1, 2, 3])).rejects.toThrow("missing station/bracket data");
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

  test("per-category bias: precip bias doesn't affect temperature (precip context)", async () => {
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

describe("ProbabilityEstimator — empirical sigma blend", () => {
  test("blends empirical + ensemble sigma at n=50, capped at MAX_EMPIRICAL_SIGMA_WEIGHT (0.7)", async () => {
    const db = getDb();
    db.insert(stationBias).values({
      id: "KNYC_high_temp_1",
      stationId: "KNYC",
      category: "high_temp",
      forecastHorizonDays: 1,
      meanBias: 0.5,
      stdBias: 1.2, // empirical forecast error std
      sampleSize: 50, // would saturate at 1.0 without the cap
      windowDays: 30,
      updatedAt: new Date().toISOString(),
    }).run();

    const estimator = new ProbabilityEstimator();
    const ensemble = [28, 29, 29, 30, 30, 30, 31, 31, 32, 33];

    const result = await estimator.estimate(makeMarket(), ensemble);

    expect(result.reasoning.sigmaSource).toBe("empirical");
    // Weight capped at 0.7 — keeps 30% ensemble spread in the blend to prevent
    // empirical-overfit from collapsing sigma on tight near-mean brackets.
    expect(result.reasoning.empiricalSigmaWeight).toBeCloseTo(0.7, 6);
    // Sigma is a weighted blend: 0.7 × empirical(1.2) + 0.3 × corrStd(ensemble)
    const corrStd = std([28, 29, 29, 30, 30, 30, 31, 31, 32, 33].map((v) => v - 0.5));
    expect(result.reasoning.sigmaUsed).toBeCloseTo(0.7 * 1.2 + 0.3 * corrStd, 6);
    expect(result.reasoning.cdfProbability).toBeGreaterThan(0.2);
  });

  test("blends sigma at intermediate sample size (n=25 → 50/50 blend, widens toward ensemble)", async () => {
    const db = getDb();
    db.insert(stationBias).values({
      id: "KNYC_high_temp_1",
      stationId: "KNYC",
      category: "high_temp",
      forecastHorizonDays: 1,
      meanBias: 0,
      stdBias: 1.0, // tight empirical
      sampleSize: 25, // w = 0.5
      windowDays: 30,
      updatedAt: new Date().toISOString(),
    }).run();

    const estimator = new ProbabilityEstimator();
    // Wide ensemble spread (~3F) — blend should land between empirical and ensemble
    const ensemble = [27, 28, 29, 30, 31, 32, 33];

    const result = await estimator.estimate(makeMarket(), ensemble);

    const corrStd = std(ensemble);
    expect(result.reasoning.empiricalSigmaWeight).toBeCloseTo(0.5, 6);
    expect(result.reasoning.sigmaUsed).toBeCloseTo(0.5 * 1.0 + 0.5 * corrStd, 6);
    // Source labels "empirical" once weight >= 0.5
    expect(result.reasoning.sigmaSource).toBe("empirical");
    // Blended sigma must lie strictly between the two inputs
    expect(result.reasoning.sigmaUsed).toBeGreaterThan(1.0);
    expect(result.reasoning.sigmaUsed).toBeLessThan(corrStd);
  });

  test("low sample size (n=10) → mostly ensemble (w=0.2), source labels 'ensemble'", async () => {
    const db = getDb();
    db.insert(stationBias).values({
      id: "KNYC_high_temp_1",
      stationId: "KNYC",
      category: "high_temp",
      forecastHorizonDays: 1,
      meanBias: 0,
      stdBias: 1.0,
      sampleSize: 10,
      windowDays: 30,
      updatedAt: new Date().toISOString(),
    }).run();

    const estimator = new ProbabilityEstimator();
    const ensemble = [27, 28, 29, 30, 31, 32, 33];

    const result = await estimator.estimate(makeMarket(), ensemble);

    expect(result.reasoning.empiricalSigmaWeight).toBeCloseTo(0.2, 6);
    expect(result.reasoning.sigmaSource).toBe("ensemble");
    const corrStd = std(ensemble);
    expect(result.reasoning.sigmaUsed).toBeCloseTo(0.2 * 1.0 + 0.8 * corrStd, 6);
  });

  test("falls back to ensemble spread when no bias data", async () => {
    const estimator = new ProbabilityEstimator();
    const ensemble = [28, 29, 30, 30, 31, 32, 33];

    const result = await estimator.estimate(makeMarket(), ensemble);

    expect(result.reasoning.sigmaSource).toBe("ensemble");
    expect(result.reasoning.empiricalSigmaWeight).toBeNull();
  });

  test("same-day market still picks up horizon=1 bias correction", async () => {
    const db = getDb();
    db.insert(stationBias).values({
      id: "KNYC_high_temp_1",
      stationId: "KNYC",
      category: "high_temp",
      forecastHorizonDays: 1,
      meanBias: -2,
      stdBias: 1.2,
      sampleSize: 16, // w = 0.32 → blend dominated by ensemble
      windowDays: 30,
      updatedAt: new Date().toISOString(),
    }).run();

    const estimator = new ProbabilityEstimator();
    // Same-day market: targetDate = today. Without the floor, ceil((midnight - now)/day)
    // resolves to 0 once we're past midnight UTC, and the horizon=1 bias row is missed.
    const today = new Date().toISOString().slice(0, 10);
    const market = { ...makeMarket(), targetDate: today };
    const ensemble = [28, 29, 30, 30, 31, 32, 33, 34, 35, 36];

    const result = await estimator.estimate(market, ensemble);

    expect(result.reasoning.biasCorrection).not.toBeNull();
    expect(result.reasoning.biasCorrection!.meanBias).toBe(-2);
    expect(result.reasoning.biasCorrection!.sampleSize).toBe(16);
    expect(result.reasoning.empiricalSigmaWeight).toBeCloseTo(16 / 50, 6);
    // n=16 → w=0.32 < 0.5 → labels "ensemble", but blend still tightens slightly
    expect(result.reasoning.sigmaSource).toBe("ensemble");
  });

  test("MAX_EMPIRICAL_SIGMA_WEIGHT cap kicks in at n=35 (n/50=0.7)", async () => {
    const db = getDb();
    db.insert(stationBias).values({
      id: "KNYC_high_temp_1",
      stationId: "KNYC",
      category: "high_temp",
      forecastHorizonDays: 1,
      meanBias: 0,
      stdBias: 1.0,
      sampleSize: 200, // arbitrary high — w would be min(1, 200/50)=1 without cap
      windowDays: 30,
      updatedAt: new Date().toISOString(),
    }).run();

    const estimator = new ProbabilityEstimator();
    const ensemble = [27, 28, 29, 30, 31, 32, 33];

    const result = await estimator.estimate(makeMarket(), ensemble);

    // Cap is 0.7 regardless of how large n grows.
    expect(result.reasoning.empiricalSigmaWeight).toBeCloseTo(0.7, 6);
    expect(result.reasoning.sigmaSource).toBe("empirical"); // w >= 0.5 keeps the label
    const corrStd = std(ensemble);
    expect(result.reasoning.sigmaUsed).toBeCloseTo(0.7 * 1.0 + 0.3 * corrStd, 6);
    // Blended sigma must be strictly between empirical (1.0) and ensemble (~2.16)
    expect(result.reasoning.sigmaUsed).toBeGreaterThan(1.0);
    expect(result.reasoning.sigmaUsed).toBeLessThan(corrStd);
  });

  test("empirical sigma + capped blend concentrates probability on correct bracket (n=50)", async () => {
    const db = getDb();
    db.insert(stationBias).values({
      id: "KNYC_high_temp_1",
      stationId: "KNYC",
      category: "high_temp",
      forecastHorizonDays: 1,
      meanBias: 0,
      stdBias: 1.0,
      sampleSize: 50, // would be fully empirical without the cap
      windowDays: 30,
      updatedAt: new Date().toISOString(),
    }).run();

    const estimator = new ProbabilityEstimator();
    // Mean is 30.5, exactly centered in [30, 31) bracket
    const ensemble = [30, 30, 30.5, 30.5, 31, 31];

    const result = await estimator.estimate(makeMarket(), ensemble);

    // With cap at 0.7: sigmaUsed = 0.7 × 1.0 + 0.3 × std(ensemble)
    const corrStd = std([30, 30, 30.5, 30.5, 31, 31]);
    expect(result.reasoning.sigmaUsed).toBeCloseTo(0.7 + 0.3 * corrStd, 6);
    // Slightly wider than pure-empirical (1.0) → CDF P(bracket) shifts down a
    // bit, but should still be the dominant probability for a centered mean.
    expect(result.reasoning.cdfProbability).toBeGreaterThan(0.25);
  });
});

describe("ProbabilityEstimator — sigma floor (plan #4)", () => {
  const originalFloorFactor = getConfig().bot.sigmaFloorBracketWidthFactor;

  beforeEach(() => {
    getConfig().bot.sigmaFloorBracketWidthFactor = 0.6;
  });

  afterAll(() => {
    getConfig().bot.sigmaFloorBracketWidthFactor = originalFloorFactor;
  });

  /** Tight empirical sigma + tight ensemble → blend collapses below the floor. */
  function seedTightSigma() {
    getDb().insert(stationBias).values({
      id: "KNYC_high_temp_1",
      stationId: "KNYC",
      category: "high_temp",
      forecastHorizonDays: 1,
      meanBias: 0,
      stdBias: 0.1, // overfit-tight empirical error
      sampleSize: 50, // saturates the blend weight at the 0.7 cap
      windowDays: 30,
      updatedAt: new Date().toISOString(),
    }).run();
  }
  const tightEnsemble = [29.8, 29.9, 30, 30, 30.1, 30.2];

  test("floors collapsed sigma at factor × bracket width (1°F bracket → 0.6F)", async () => {
    seedTightSigma();
    const estimator = new ProbabilityEstimator();

    const result = await estimator.estimate(makeMarket(), tightEnsemble);

    // Blend would be 0.7×0.1 + 0.3×corrStd(≈0.13) ≈ 0.11F — mechanically
    // overconfident on a 1°F bracket. The floor lifts it to 0.6 × 1.0.
    expect(result.reasoning.sigmaUsed).toBeCloseTo(0.6, 6);
    expect(result.reasoning.sigmaFloorApplied).toBeCloseTo(0.6, 6);
  });

  test("factor 0 disables the floor", async () => {
    getConfig().bot.sigmaFloorBracketWidthFactor = 0;
    seedTightSigma();
    const estimator = new ProbabilityEstimator();

    const result = await estimator.estimate(makeMarket(), tightEnsemble);

    expect(result.reasoning.sigmaUsed).toBeLessThan(0.2);
    expect(result.reasoning.sigmaFloorApplied).toBeNull();
  });

  test("scales with bracket width (2°F bracket → 1.2F floor)", async () => {
    seedTightSigma();
    const estimator = new ProbabilityEstimator();
    const market = { ...makeMarket(), bracketHigh: 32 }; // 30–32 → width 2

    const result = await estimator.estimate(market, tightEnsemble);

    expect(result.reasoning.sigmaUsed).toBeCloseTo(1.2, 6);
    expect(result.reasoning.sigmaFloorApplied).toBeCloseTo(1.2, 6);
  });

  test("tail markets use width 1.0", async () => {
    seedTightSigma();
    const estimator = new ProbabilityEstimator();
    const market = {
      ...makeMarket(),
      marketType: "upper_tail",
      bracketHigh: null,
    };

    const result = await estimator.estimate(market, tightEnsemble);

    expect(result.reasoning.sigmaUsed).toBeCloseTo(0.6, 6);
    expect(result.reasoning.sigmaFloorApplied).toBeCloseTo(0.6, 6);
  });

  test("does not bind when the blend is already wider than the floor", async () => {
    const estimator = new ProbabilityEstimator();
    // No bias row → pure ensemble spread (~1.7F) > 0.6 floor
    const wide = [27, 28, 29, 30, 31, 32, 33];

    const result = await estimator.estimate(makeMarket(), wide);

    expect(result.reasoning.sigmaFloorApplied).toBeNull();
    expect(result.reasoning.sigmaUsed).toBeGreaterThan(1);
  });
});

describe("ProbabilityEstimator — observation adjustment", () => {
  test("tightens sigma when observation confirms forecast", async () => {
    const estimator = new ProbabilityEstimator();
    // Set target date to today for forecastHorizon <= 1
    const today = new Date().toISOString().slice(0, 10);
    const market = {
      ...makeMarket(),
      targetDate: today,
      bracketLow: 80,
      bracketHigh: 82,
    };
    // Ensemble centered around 81
    const ensemble = [79, 80, 80, 81, 81, 81, 82, 82, 83, 84];

    const observation = {
      observedTemp: 72, // morning temp, within 3F divergence threshold isn't about closeness to mean
      observedAt: new Date().toISOString(),
    };

    const resultWithObs = await estimator.estimate(market, ensemble, observation);

    // Observation adjustment should be recorded
    if (resultWithObs.reasoning.observationAdjustment) {
      expect(resultWithObs.reasoning.observationAdjustment.sigmaAfter)
        .toBeLessThan(resultWithObs.reasoning.observationAdjustment.sigmaBefore);
    }
  });

  test("shifts mean when observation diverges significantly", async () => {
    const estimator = new ProbabilityEstimator();
    const today = new Date().toISOString().slice(0, 10);
    const market = {
      ...makeMarket(),
      targetDate: today,
      bracketLow: 80,
      bracketHigh: 82,
    };
    const ensemble = [79, 80, 80, 81, 81, 81, 82, 82, 83, 84];

    // Morning temp is 65F — diverges by much more than 3F from forecast mean of ~81
    const observation = {
      observedTemp: 65,
      observedAt: new Date().toISOString(),
    };

    const result = await estimator.estimate(market, ensemble, observation);

    // Should have observation adjustment with mean shift
    expect(result.reasoning.observationAdjustment).not.toBeNull();
    if (result.reasoning.observationAdjustment) {
      expect(result.reasoning.observationAdjustment.meanShift).not.toBe(0);
    }
  });

  test("no observation adjustment for precip markets", async () => {
    const estimator = new ProbabilityEstimator();
    const today = new Date().toISOString().slice(0, 10);
    const market = {
      ...makePrecipMarket(),
      targetDate: today,
    };
    const ensemble = [0, 0, 0.1, 0.15, 0.2];
    const observation = { observedTemp: 72, observedAt: new Date().toISOString() };

    const result = await estimator.estimate(market, ensemble, observation);

    // Precip markets should not get observation adjustment
    expect(result.reasoning.observationAdjustment).toBeNull();
  });

  test("no observation adjustment for distant markets", async () => {
    const estimator = new ProbabilityEstimator();
    // Target date is 3 days out
    const futureDate = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
    const market = {
      ...makeMarket(),
      targetDate: futureDate,
    };
    const ensemble = [28, 29, 30, 30, 31];
    const observation = { observedTemp: 72, observedAt: new Date().toISOString() };

    const result = await estimator.estimate(market, ensemble, observation);

    // forecastHorizon > 1 → no adjustment
    expect(result.reasoning.observationAdjustment).toBeNull();
  });

  test("morning obs whose implied afternoon high exceeds forecast mean → diverges branch", async () => {
    // Regression: Apr 20 NY-51.5 lost because morning obs 50°F was treated as
    // "confirming" a 50.83°F forecast mean (divergence < 3°F) and sigma was
    // halved. A 50°F morning reading actually implies a ~57°F afternoon high,
    // which disagrees with a 50.83°F forecast and should widen — not tighten —
    // the warm-side tail.
    const estimator = new ProbabilityEstimator();
    const today = new Date().toISOString().slice(0, 10);
    const market = {
      ...makeMarket(),
      stationId: "KNYC",
      targetDate: today,
      bracketLow: 51.5,
      bracketHigh: 52.5,
    };
    const ensemble = Array.from({ length: 20 }, (_, i) => 49 + i * 0.2); // mean ≈ 50.9

    // 9am ET (EDT) in April = 13:00 UTC; year doesn't matter for TZ logic
    const observation = {
      observedTemp: 50,
      observedAt: `${today}T13:00:00Z`,
    };

    const result = await estimator.estimate(market, ensemble, observation);

    expect(result.reasoning.observationAdjustment).not.toBeNull();
    const adj = result.reasoning.observationAdjustment!;
    // Mean should shift upward (obs implies a warmer afternoon high than forecast)
    expect(adj.meanShift).toBeGreaterThan(0);
    // Sigma tightened only mildly (0.85x), not halved
    expect(adj.sigmaAfter / adj.sigmaBefore).toBeGreaterThan(0.8);
  });

  test("afternoon obs matching forecast mean → confirms branch tightens sigma", async () => {
    const estimator = new ProbabilityEstimator();
    const today = new Date().toISOString().slice(0, 10);
    const market = {
      ...makeMarket(),
      stationId: "KNYC",
      targetDate: today,
      bracketLow: 80,
      bracketHigh: 82,
    };
    const ensemble = [79, 80, 80, 81, 81, 81, 82, 82, 83, 84];

    // 3pm ET in April (EDT) = 19:00 UTC; obs temp ≈ forecast mean
    const observation = {
      observedTemp: 81,
      observedAt: `${today}T19:00:00Z`,
    };

    const result = await estimator.estimate(market, ensemble, observation);

    expect(result.reasoning.observationAdjustment).not.toBeNull();
    const adj = result.reasoning.observationAdjustment!;
    // Confirms branch: tighten sigma ~30% (0.7x)
    expect(adj.sigmaAfter).toBeLessThan(adj.sigmaBefore);
    expect(adj.sigmaAfter / adj.sigmaBefore).toBeLessThan(0.8);
    // No mean shift when obs confirms
    expect(adj.meanShift).toBeCloseTo(0, 6);
  });
});

describe("localHourAtStation", () => {
  test("KNYC 13:00Z in April is 9am local (EDT)", () => {
    expect(localHourAtStation("2026-04-20T13:00:00Z", "KNYC")).toBe(9);
  });

  test("KDEN 13:00Z in April is 7am local (MDT)", () => {
    expect(localHourAtStation("2026-04-20T13:00:00Z", "KDEN")).toBe(7);
  });

  test("KLAX 13:00Z in April is 6am local (PDT)", () => {
    expect(localHourAtStation("2026-04-20T13:00:00Z", "KLAX")).toBe(6);
  });

  test("unknown station falls back to NY tz", () => {
    expect(localHourAtStation("2026-04-20T13:00:00Z", "KZZZ")).toBe(9);
  });
});

describe("estimateDiurnalOffset", () => {
  test("peak heating (3pm local) → ~0°F", () => {
    expect(estimateDiurnalOffset(15)).toBeCloseTo(0, 6);
  });

  test("predawn (~5am) → high offset", () => {
    expect(estimateDiurnalOffset(5)).toBeGreaterThan(9);
  });

  test("9am local → mid-range", () => {
    const offset = estimateDiurnalOffset(9);
    expect(offset).toBeGreaterThan(5);
    expect(offset).toBeLessThan(9);
  });

  test("6pm local → small positive offset", () => {
    const offset = estimateDiurnalOffset(18);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(4);
  });

  test("bounded at hour 0 and 24", () => {
    expect(estimateDiurnalOffset(0)).toBeGreaterThanOrEqual(0);
    expect(estimateDiurnalOffset(24)).toBeGreaterThanOrEqual(0);
  });
});

describe("ProbabilityEstimator — tail probability floor", () => {
  test("no bias record + extreme bracket → probability floored at 3%", async () => {
    const estimator = new ProbabilityEstimator();
    // Bracket 80-82°F, ensemble all near 50°F with zero spread → raw prob → 0
    const ensemble = Array.from({ length: 200 }, () => 50);
    const market = {
      ...makeMarket(),
      bracketLow: 80,
      bracketHigh: 82,
    };

    const result = await estimator.estimate(market, ensemble);

    // Raw cdf/counting are 0; returned probability should be floored to 0.03
    expect(result.reasoning.countingProbability).toBe(0);
    expect(result.probability).toBeGreaterThanOrEqual(0.03 - 1e-9);
    expect(result.probability).toBeLessThan(0.1);
  });

  test("no bias record + certain bracket → probability capped at 97%", async () => {
    // Sigma floor pinned off so the zero-spread pool keeps its pre-floor
    // near-certainty — this test covers the 0.97 cap, not the floor (which
    // would pull the probability to ~0.6 before the cap could ever bind).
    const originalFloor = getConfig().bot.sigmaFloorBracketWidthFactor;
    getConfig().bot.sigmaFloorBracketWidthFactor = 0;
    try {
      const estimator = new ProbabilityEstimator();
      // All members inside bracket, no bias record
      const ensemble = Array.from({ length: 200 }, () => 30.5);
      const result = await estimator.estimate(makeMarket(), ensemble);

      expect(result.reasoning.countingProbability).toBe(1);
      expect(result.probability).toBeLessThanOrEqual(0.97 + 1e-9);
      expect(result.probability).toBeGreaterThan(0.9);
    } finally {
      getConfig().bot.sigmaFloorBracketWidthFactor = originalFloor;
    }
  });

  test("with empirical bias record (sample >= 10) → floor narrows to 1%", async () => {
    const db = getDb();
    db.insert(stationBias).values({
      id: crypto.randomUUID(),
      stationId: "KNYC",
      category: "high_temp",
      forecastHorizonDays: 1,
      meanBias: 0,
      stdBias: 1.2,
      sampleSize: 20,
      windowDays: 30,
      updatedAt: new Date().toISOString(),
    } as any).run();

    const estimator = new ProbabilityEstimator();
    const ensemble = Array.from({ length: 200 }, () => 50);
    const market = {
      ...makeMarket(),
      bracketLow: 80,
      bracketHigh: 82,
    };

    const result = await estimator.estimate(market, ensemble);
    // With bias record, floor is 0.01 not 0.03
    expect(result.probability).toBeGreaterThanOrEqual(0.01 - 1e-9);
    expect(result.probability).toBeLessThan(0.03);
  });
});

describe("medianRegularBracketWidth", () => {
  test("odd count → middle width", () => {
    const ms = [
      { marketType: "bracket", bracketLow: 30, bracketHigh: 31 },
      { marketType: "bracket", bracketLow: 31, bracketHigh: 33 }, // width 2
      { marketType: "bracket", bracketLow: 33, bracketHigh: 36 }, // width 3
    ] as any[];
    expect(medianRegularBracketWidth(ms)).toBe(2);
  });

  test("even count → mean of two middle widths", () => {
    const ms = [
      { marketType: "bracket", bracketLow: 0, bracketHigh: 1 }, // 1
      { marketType: "bracket", bracketLow: 0, bracketHigh: 3 }, // 3
    ] as any[];
    expect(medianRegularBracketWidth(ms)).toBe(2);
  });

  test("tails excluded; tail-only event → fallback 1.0", () => {
    const ms = [
      { marketType: "upper_tail", bracketLow: 80, bracketHigh: null },
      { marketType: "lower_tail", bracketLow: 60, bracketHigh: null },
    ] as any[];
    expect(medianRegularBracketWidth(ms)).toBe(1.0);
  });

  test("mixed tails + brackets → uses only the brackets", () => {
    const ms = [
      { marketType: "lower_tail", bracketLow: 60, bracketHigh: null },
      { marketType: "bracket", bracketLow: 60, bracketHigh: 61 },
      { marketType: "bracket", bracketLow: 61, bracketHigh: 62 },
      { marketType: "upper_tail", bracketLow: 62, bracketHigh: null },
    ] as any[];
    expect(medianRegularBracketWidth(ms)).toBe(1);
  });
});

/**
 * Build a coherent event: lower_tail (< lo) + `n` contiguous 1°F brackets
 * starting at `lo` + upper_tail (> lo+n). Partitions ℝ, so raw probs should sum
 * to ~1. All markets share station/targetDate/category/eventTicker.
 */
function makeEvent(opts: { lo?: number; n?: number; station?: string; eventTicker?: string } = {}) {
  const lo = opts.lo ?? 78;
  const n = opts.n ?? 6;
  const station = opts.station ?? "KNYC";
  const eventTicker = opts.eventTicker ?? "KXHIGHNY-26JUN05";
  const targetDate = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  const common = {
    stationId: station,
    category: "high_temp",
    targetDate,
    eventTicker,
    seriesTicker: "KXHIGHNY",
    status: "open",
  };
  const markets: any[] = [];
  markets.push({
    ...common,
    ticker: `${eventTicker}-T${lo}L`,
    marketType: "lower_tail",
    bracketLow: lo,
    bracketHigh: null,
  });
  for (let i = 0; i < n; i++) {
    const blo = lo + i;
    markets.push({
      ...common,
      ticker: `${eventTicker}-B${blo}`,
      marketType: "bracket",
      bracketLow: blo,
      bracketHigh: blo + 1,
    });
  }
  markets.push({
    ...common,
    ticker: `${eventTicker}-T${lo + n}U`,
    marketType: "upper_tail",
    bracketLow: lo + n,
    bracketHigh: null,
  });
  return markets;
}

function sumProbs(results: Map<string, { probability: number }>): number {
  let s = 0;
  for (const r of results.values()) s += r.probability;
  return s;
}

describe("ProbabilityEstimator — estimateEvent (addendum N2)", () => {
  const originalHist = getConfig().bot.historicalPriorWeight;
  const originalMkt = getConfig().bot.marketPriorWeight;
  const originalFloor = getConfig().bot.sigmaFloorBracketWidthFactor;

  beforeEach(() => {
    // Hermetic defaults: priors/blends off, modest sigma floor so a partition of
    // 1°F brackets stays coherent (floor = 0.6 × median width 1.0 = 0.6).
    getConfig().bot.historicalPriorWeight = 0;
    getConfig().bot.marketPriorWeight = 0;
    getConfig().bot.sigmaFloorBracketWidthFactor = 0.6;
  });

  afterEach(() => {
    getConfig().bot.historicalPriorWeight = originalHist;
    getConfig().bot.marketPriorWeight = originalMkt;
    getConfig().bot.sigmaFloorBracketWidthFactor = originalFloor;
  });

  test("partition (lower tail + 6 brackets + upper tail) sums to 1, no priors/blends", async () => {
    const estimator = new ProbabilityEstimator();
    const event = makeEvent({ lo: 78, n: 6 }); // brackets [78,84), tails <78 / >84
    // Ensemble centered ~81. Use non-integer values so no member lands exactly on
    // a half-open bracket boundary (e.g. exactly 84 would fall in the [84,84] gap
    // between the top bracket [83,84) and the >84 upper tail — a measure-zero
    // boundary in the CDF but a real miss for discrete counting).
    const ensemble = [77.5, 78.5, 78.7, 79.5, 80.2, 80.8, 81.3, 81.6, 82.4, 82.7, 83.2, 83.6, 84.5, 85.5];

    const results = await estimator.estimateEvent(event, ensemble);

    expect(results.size).toBe(event.length);
    // The raw CDF/counting vector over a partition is exactly 1 (the tails close
    // both ends), so coverage ≈ 1 and the final sum tracks it.
    expect(sumProbs(results)).toBeCloseTo(1, 6);
    for (const r of results.values()) {
      expect(r.reasoning.eventCoherence).not.toBeNull();
      expect(r.reasoning.eventCoherence!.rawCdfSum).toBeCloseTo(1, 6);
      expect(r.reasoning.eventCoherence!.finalSum).toBeCloseTo(sumProbs(results), 9);
      expect(r.reasoning.eventCoherence!.eventBlendWeight).toBeNull();
      expect(r.reasoning.eventCoherence!.markets).toBe(event.length);
    }
  });

  test("historical prior does NOT inflate the sum (renormalized to coverage)", async () => {
    const db = getDb();
    // Seed calibration so getHistoricalHitRate returns ~0.5 for the central
    // brackets (the join is bracket-center-proximity based). Use the event's own
    // tickers so the markets-join finds them.
    const event = makeEvent({ lo: 78, n: 6 });
    for (const m of event) {
      db.insert(markets).values({
        ticker: m.ticker,
        eventTicker: m.eventTicker,
        seriesTicker: m.seriesTicker,
        title: "t",
        category: "high_temp",
        stationId: "KNYC",
        targetDate: m.targetDate,
        bracketLow: m.bracketLow,
        bracketHigh: m.bracketHigh,
        marketType: m.marketType,
        status: "settled",
        discoveredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).onConflictDoNothing().run();
      for (const outcome of [1, 1, 1, 0, 0, 0]) {
        db.insert(calibration).values(makeCalibrationRow({
          id: crypto.randomUUID(),
          ticker: m.ticker,
          actualOutcome: outcome,
        })).run();
      }
    }
    getConfig().bot.historicalPriorWeight = 0.5;

    const estimator = new ProbabilityEstimator();
    const ensemble = [78, 79, 79, 80, 80, 81, 81, 81, 82, 82, 83, 83, 84, 85];
    const results = await estimator.estimateEvent(event, ensemble);

    const coverage = [...results.values()][0]!.reasoning.eventCoherence!.rawCdfSum;
    // Despite each bracket being pulled toward its ~0.5 baseline, the sum is
    // rescaled back to coverage — no wing inflation (the Finding-2 bug).
    expect(sumProbs(results)).toBeCloseTo(coverage, 2);
    // The blend actually fired on at least one market.
    const anyBlend = [...results.values()].some((r) => r.reasoning.historicalPriorBlend != null);
    expect(anyBlend).toBe(true);
  });

  test("vector market blend: de-vigs an overround book, preserves the sum, moves the peak toward the market", async () => {
    const estimator = new ProbabilityEstimator();
    const event = makeEvent({ lo: 78, n: 6 });
    // Model is centered ~80 (peak bracket 80-81). Build a market book whose peak
    // is at 82-83 and that sums to 1.10 (10% overround) to exercise de-vigging.
    const ensemble = [78, 79, 79, 80, 80, 80, 81, 81, 82, 82, 83, 84];

    getConfig().bot.marketPriorWeight = 0.3;
    getConfig().bot.marketPriorMaxWeight = 0.7;
    getConfig().bot.marketPriorRampStart = 0.0; // ensure the ramp engages on this TV
    getConfig().bot.marketPriorRampEnd = 0.4;

    const prices = new Map<string, number>();
    // Overround book peaked at 82-83. Raw entries sum to ~1.10.
    const byTicker: Record<string, number> = {
      [`${event[0]!.ticker}`]: 0.02, // lower tail
      [`${event[1]!.ticker}`]: 0.04, // 78-79
      [`${event[2]!.ticker}`]: 0.08, // 79-80
      [`${event[3]!.ticker}`]: 0.14, // 80-81
      [`${event[4]!.ticker}`]: 0.20, // 81-82
      [`${event[5]!.ticker}`]: 0.30, // 82-83  ← market peak
      [`${event[6]!.ticker}`]: 0.20, // 83-84
      [`${event[7]!.ticker}`]: 0.08, // upper tail
    };
    for (const [t, p] of Object.entries(byTicker)) prices.set(t, p);

    const before = await estimator.estimateEvent(event, ensemble); // no prices
    getConfig().bot.marketPriorWeight = 0.3; // (re-set after no-price call reset nothing)
    const after = await estimator.estimateEvent(event, ensemble, undefined, prices);

    const coverage = [...after.values()][0]!.reasoning.eventCoherence!.rawCdfSum;
    // Sum-preserving: the blend keeps Σ at coverage.
    expect(sumProbs(after)).toBeCloseTo(coverage, 2);
    // Event-level blend weight was computed.
    expect([...after.values()][0]!.reasoning.eventCoherence!.eventBlendWeight).not.toBeNull();
    // The 82-83 bracket (market's peak) should gain probability vs the no-blend run.
    const peakTicker = event[5]!.ticker;
    expect(after.get(peakTicker)!.probability).toBeGreaterThan(before.get(peakTicker)!.probability);
  });

  test("gap preservation: dropping a middle bracket → coverage < 1, finalSum ≈ coverage", async () => {
    const estimator = new ProbabilityEstimator();
    const full = makeEvent({ lo: 78, n: 6 });
    // Drop the 81-82 bracket (index 4: lower tail=0, brackets start at 1).
    const dropped = full.filter((m) => m.ticker !== full[4]!.ticker);
    const ensemble = [78, 79, 79, 80, 80, 81, 81, 81, 82, 82, 83, 83, 84, 85];

    const results = await estimator.estimateEvent(dropped, ensemble);
    const coverage = [...results.values()][0]!.reasoning.eventCoherence!.rawCdfSum;

    // Missing bracket carried real mass → coverage strictly below 1.
    expect(coverage).toBeLessThan(0.99);
    expect(coverage).toBeGreaterThan(0.5);
    // Gap mass is preserved (NOT forced back to 1) and finalSum tracks coverage.
    expect(sumProbs(results)).toBeCloseTo(coverage, 2);
  });

  test("single-market 'event' ≈ estimate() within tolerance (priors/blends off)", async () => {
    const estimator = new ProbabilityEstimator();
    const market = makeMarket(); // 30-31 bracket
    const ensemble = [28, 29, 30, 30, 30, 30, 30, 31, 32, 33];

    const single = await estimator.estimate(market, ensemble);
    const evResults = await estimator.estimateEvent([market], ensemble);
    const ev = evResults.get(market.ticker)!;

    // The per-market sigma floor (estimate) uses this market's width (1.0); the
    // event floor uses median regular width (also 1.0 here) → identical sigma,
    // so the probabilities match closely. (Tail floor + clamp differ only by the
    // coverage renorm, which is a no-op for a single market whose raw == coverage.)
    expect(ev.probability).toBeCloseTo(single.probability, 6);
    expect(ev.confidence).toBeCloseTo(single.confidence, 6);
    expect(ev.reasoning.sigmaUsed).toBeCloseTo(single.reasoning.sigmaUsed, 6);
  });

  test("tail-only event (no regular brackets) → median width fallback 1.0, no crash", async () => {
    const estimator = new ProbabilityEstimator();
    const targetDate = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const common = {
      stationId: "KNYC",
      category: "high_temp",
      targetDate,
      eventTicker: "KXHIGHNY-TAILONLY",
      seriesTicker: "KXHIGHNY",
    };
    const event = [
      { ...common, ticker: "T-LOW", marketType: "lower_tail", bracketLow: 70, bracketHigh: null },
      { ...common, ticker: "T-HIGH", marketType: "upper_tail", bracketLow: 70, bracketHigh: null },
    ] as any[];
    const ensemble = [65, 68, 70, 72, 75, 78];

    const results = await estimator.estimateEvent(event, ensemble);
    expect(results.size).toBe(2);
    // lower_tail (<70) + upper_tail (>70) ≈ partition (members exactly at 70 go
    // to neither), so the sum is ≈ coverage and ≤ 1.
    const coverage = [...results.values()][0]!.reasoning.eventCoherence!.rawCdfSum;
    expect(sumProbs(results)).toBeCloseTo(coverage, 6);
    expect(coverage).toBeLessThanOrEqual(1 + 1e-9);
  });

  test("confidence identical across the event's results", async () => {
    const estimator = new ProbabilityEstimator();
    const event = makeEvent({ lo: 78, n: 6 });
    const ensemble = [78, 79, 80, 80, 81, 81, 82, 82, 83, 84];

    const results = await estimator.estimateEvent(event, ensemble);
    const confidences = [...results.values()].map((r) => r.confidence);
    const first = confidences[0]!;
    for (const c of confidences) expect(c).toBe(first);
  });

  test("throws on empty event", async () => {
    const estimator = new ProbabilityEstimator();
    expect(estimator.estimateEvent([], [30, 31, 32])).rejects.toThrow("no markets");
  });

  test("throws when a market is missing bracket data", async () => {
    const estimator = new ProbabilityEstimator();
    const event = makeEvent({ lo: 78, n: 2 });
    (event[1] as any).bracketLow = null;
    expect(estimator.estimateEvent(event, [78, 79, 80])).rejects.toThrow("missing station/bracket data");
  });

  test("market blend with only ONE priced market is skipped (needs ≥2)", async () => {
    const estimator = new ProbabilityEstimator();
    const event = makeEvent({ lo: 78, n: 6 });
    const ensemble = [78, 79, 80, 80, 81, 81, 82, 82, 83, 84];
    getConfig().bot.marketPriorWeight = 0.5;

    const prices = new Map<string, number>([[event[3]!.ticker, 0.9]]); // single price
    const results = await estimator.estimateEvent(event, ensemble, undefined, prices);

    // No event-level blend fired; coherence weight stays null.
    expect([...results.values()][0]!.reasoning.eventCoherence!.eventBlendWeight).toBeNull();
    for (const r of results.values()) expect(r.reasoning.marketPriorBlend).toBeNull();
  });
});

// ── Addendum N3 — observation running-max clamp + post-peak collapse ──────────

/** A bracket market for `m`-type markets, defaulting to today (forecastHorizon ≤ 1). */
function makeTodayBracket(overrides: Partial<any> = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    ticker: "KXHIGHNY-TODAY-B86",
    stationId: "KNYC",
    category: "high_temp",
    bracketLow: 86.5,
    bracketHigh: 88.5,
    marketType: "bracket",
    targetDate: today,
    ...overrides,
  } as any;
}

describe("cdfProbForMarket — N3 running-max clamp (pure math)", () => {
  // The clamped CDF is F_H(x) = 0 for x < rm, Φ((x−μ)/σ) for x ≥ rm.
  const bracket = { marketType: "bracket", bracketLow: 86.5, bracketHigh: 88.5 } as any;
  const lowerTail = { marketType: "lower_tail", bracketLow: 86.5, bracketHigh: null } as any;
  const upperTail = { marketType: "upper_tail", bracketLow: 84.5, bracketHigh: null } as any;

  test("bracket containing rm: clamp folds the sub-rm mass INTO the bracket → P rises", () => {
    const mu = 88;
    const sigma = 1.5;
    const noClamp = cdfProbForMarket(bracket, mu, sigma, 0, false, null);
    const withClamp = cdfProbForMarket(bracket, mu, sigma, 0, false, 87.5);
    // rm 87.5 ∈ [86.5, 88.5): mass below 87.5 collapses onto the point rm, which
    // lands inside the bracket → the bracket probability strictly increases.
    expect(withClamp).toBeGreaterThan(noClamp);
    // Exact: clampedCdf(88.5) − clampedCdf(86.5) = Φ((88.5−88)/1.5) − 0.
    expect(withClamp).toBeCloseTo(normalCdf(88.5, mu, sigma), 9);
  });

  test("bracket fully below rm → clamped to 0 (impossible)", () => {
    // Bracket [86.5,88.5) entirely below rm=90 → the high can't land here.
    expect(cdfProbForMarket(bracket, 88, 1.5, 0.4, false, 90)).toBeCloseTo(0, 9);
  });

  test("lower tail at/under rm → P = 0 exactly", () => {
    // th 86.5 ≤ rm 87.5 → clampedCdf(86.5) = 0.
    expect(cdfProbForMarket(lowerTail, 88, 1.5, 0.3, false, 87.5)).toBe(0);
  });

  test("lower tail above rm → unaffected Φ(th)", () => {
    // th 86.5 > rm 80 → clampedCdf(86.5) = Φ((86.5−88)/1.5) (clamp irrelevant).
    const p = cdfProbForMarket(lowerTail, 88, 1.5, 0.3, false, 80);
    expect(p).toBeCloseTo(normalCdf(86.5, 88, 1.5), 9);
  });

  test("upper tail with threshold below rm → P = 1 exactly", () => {
    // th 84.5 < rm 87.5 → the observed max already exceeds the threshold.
    expect(cdfProbForMarket(upperTail, 88, 1.5, 0.9, false, 87.5)).toBe(1);
  });

  test("upper tail with threshold above rm → 1 − Φ(th), clamp irrelevant", () => {
    // th 84.5 ≥ rm 80 → 1 − clampedCdf(84.5) = 1 − Φ((84.5−88)/1.5).
    const p = cdfProbForMarket(upperTail, 88, 1.5, 0.9, false, 80);
    expect(p).toBeCloseTo(1 - normalCdf(84.5, 88, 1.5), 9);
  });

  test("clamp at exactly the bracket low boundary: lower-tail mass folds in", () => {
    // rm == lo == 86.5. clampedCdf(86.5) = Φ((86.5−88)/1.5) (>= boundary), so the
    // bracket keeps Φ(hi)−Φ(lo) — nothing folds in (no mass strictly below lo).
    const p = cdfProbForMarket(bracket, 88, 1.5, 0, false, 86.5);
    expect(p).toBeCloseTo(normalCdf(88.5, 88, 1.5) - normalCdf(86.5, 88, 1.5), 9);
  });

  test("null/undefined runningMax → identical to the un-clamped integral", () => {
    const a = cdfProbForMarket(bracket, 88, 1.5, 0, false);
    const b = cdfProbForMarket(bracket, 88, 1.5, 0, false, null);
    const c = cdfProbForMarket(bracket, 88, 1.5, 0, false, undefined);
    const plain = normalCdf(88.5, 88, 1.5) - normalCdf(86.5, 88, 1.5);
    expect(a).toBeCloseTo(plain, 9);
    expect(b).toBeCloseTo(plain, 9);
    expect(c).toBeCloseTo(plain, 9);
  });

  test("a partition's clamped slices still sum to 1 (coherence)", () => {
    const mu = 81;
    const sigma = 2;
    const rm = 80.3;
    const lower = { marketType: "lower_tail", bracketLow: 78, bracketHigh: null } as any;
    const brackets = [
      { marketType: "bracket", bracketLow: 78, bracketHigh: 80 },
      { marketType: "bracket", bracketLow: 80, bracketHigh: 82 },
      { marketType: "bracket", bracketLow: 82, bracketHigh: 84 },
    ] as any[];
    const upper = { marketType: "upper_tail", bracketLow: 84, bracketHigh: null } as any;
    let sum = cdfProbForMarket(lower, mu, sigma, 0, false, rm);
    for (const b of brackets) sum += cdfProbForMarket(b, mu, sigma, 0, false, rm);
    sum += cdfProbForMarket(upper, mu, sigma, 0, false, rm);
    expect(sum).toBeCloseTo(1, 9);
  });
});

describe("countMembersInMarket — N3 running-max clamp (pure)", () => {
  const bracket = { marketType: "bracket", bracketLow: 86.5, bracketHigh: 88.5 } as any;
  const lowerTail = { marketType: "lower_tail", bracketLow: 86.5, bracketHigh: null } as any;
  const upperTail = { marketType: "upper_tail", bracketLow: 84.5, bracketHigh: null } as any;

  test("members below rm fold up into the bracket containing rm", () => {
    // 3 members below rm (84,85,86) clamp to 87.5 → land in [86.5,88.5);
    // 87 already inside; 89 above. Without clamp only 87 counts (1); with → 4.
    const ens = [84, 85, 86, 87, 89];
    expect(countMembersInMarket(bracket, ens)).toBe(1);
    expect(countMembersInMarket(bracket, ens, 87.5)).toBe(4);
  });

  test("lower tail under rm → 0 members (all clamp up to rm)", () => {
    const ens = [80, 82, 84, 90];
    expect(countMembersInMarket(lowerTail, ens, 87.5)).toBe(0);
  });

  test("upper tail below rm → all members count (clamped ≥ rm > th)", () => {
    const ens = [80, 82, 84];
    expect(countMembersInMarket(upperTail, ens, 87.5)).toBe(3);
  });

  test("null runningMax leaves the raw counts unchanged", () => {
    const ens = [84, 85, 86, 87, 89];
    expect(countMembersInMarket(bracket, ens, null)).toBe(1);
  });
});

describe("ProbabilityEstimator — N3 observation integration", () => {
  const originalBot = {
    obsPeakHour: getConfig().bot.obsPeakHour,
    obsMaxAgeMinutes: getConfig().bot.obsMaxAgeMinutes,
    obsPostPeakSigma: getConfig().bot.obsPostPeakSigma,
    obsPostPeakMeanOffset: getConfig().bot.obsPostPeakMeanOffset,
    sigmaFloorBracketWidthFactor: getConfig().bot.sigmaFloorBracketWidthFactor,
  };

  beforeEach(() => {
    const bot = getConfig().bot;
    bot.obsPeakHour = 16;
    bot.obsMaxAgeMinutes = 90;
    bot.obsPostPeakSigma = 0.7;
    bot.obsPostPeakMeanOffset = 0.3;
    bot.sigmaFloorBracketWidthFactor = 0.6;
  });

  afterEach(() => {
    Object.assign(getConfig().bot, originalBot);
  });

  const today = () => new Date().toISOString().slice(0, 10);

  test("clamp: rm inside the bracket raises P vs the no-obs case (mass folds in)", async () => {
    const estimator = new ProbabilityEstimator();
    // Bracket [86.5, 88.5); ensemble centered ~88. Post-peak obs pins mean=rm+0.3
    // and sigma=0.7 so the only variable across runs is the clamp itself.
    const market = makeTodayBracket();
    const ensemble = Array.from({ length: 30 }, (_, i) => 86 + (i % 5)); // spread 86..90, mean 88
    // 21:30Z @ KNYC (EDT) = 17:30 local ≥ 16 → post-peak; rm 87.5.
    const obs = {
      observedTemp: 87.5,
      observedAt: `${today()}T21:30:00Z`,
      runningMax: 87.5,
      latestAgeMinutes: 10,
    };

    const withObs = await estimator.estimate(market, ensemble, obs);
    // Compare against the same post-peak distribution WITHOUT the clamp: the
    // clamp folds the (real) sub-87.5 mass into the bracket, so P must rise.
    const noClampCdf = cdfProbForMarket(
      market, withObs.reasoning.correctedEnsembleStats.mean, withObs.reasoning.sigmaUsed, 0, false, null
    );
    expect(withObs.reasoning.cdfProbability).toBeGreaterThan(noClampCdf);
    expect(withObs.reasoning.observationAdjustment!.postPeakCollapse).toBe(true);
  });

  test("clamp kills an impossible lower tail: raw cdf is exactly 0", async () => {
    const estimator = new ProbabilityEstimator();
    // Lower-tail < 86.5, rm 87.5 ≥ threshold → P(H < 86.5) = 0 (raw).
    const market = makeTodayBracket({
      ticker: "KXHIGHNY-TODAY-T86L",
      marketType: "lower_tail",
      bracketLow: 86.5,
      bracketHigh: null,
    });
    const ensemble = [82, 83, 84, 85, 86, 87, 88]; // some below the threshold
    const obs = {
      observedTemp: 87.5,
      observedAt: `${today()}T21:30:00Z`,
      runningMax: 87.5,
      latestAgeMinutes: 5,
    };

    const result = await estimator.estimate(market, ensemble, obs);
    // Raw cdf/counting are 0; the final probability is the tail floor (≥ 0.03).
    expect(result.reasoning.cdfProbability).toBe(0);
    expect(result.reasoning.countingProbability).toBe(0);
    expect(result.probability).toBeCloseTo(0.03, 6);
  });

  test("upper tail below rm: raw cdf is exactly 1", async () => {
    const estimator = new ProbabilityEstimator();
    // Upper-tail > 84.5, rm 87.5 > threshold → P(H > 84.5) = 1 (raw); final
    // clamped to 1 − floor.
    const market = makeTodayBracket({
      ticker: "KXHIGHNY-TODAY-T84U",
      marketType: "upper_tail",
      bracketLow: 84.5,
      bracketHigh: null,
    });
    const ensemble = [80, 81, 82, 83, 84];
    const obs = {
      observedTemp: 87.5,
      observedAt: `${today()}T21:30:00Z`,
      runningMax: 87.5,
      latestAgeMinutes: 5,
    };

    const result = await estimator.estimate(market, ensemble, obs);
    expect(result.reasoning.cdfProbability).toBe(1);
    expect(result.reasoning.countingProbability).toBe(1);
    expect(result.probability).toBeCloseTo(0.97, 6); // 1 − floor
  });

  test("post-peak collapse: mean = rm + 0.3, sigma = 0.7, trace flag set", async () => {
    const estimator = new ProbabilityEstimator();
    const market = makeTodayBracket();
    const ensemble = [84, 85, 86, 87, 88, 89, 90];
    const obs = {
      observedTemp: 86, // latest reading need not equal the running max
      observedAt: `${today()}T21:30:00Z`, // 17:30 EDT ≥ 16
      runningMax: 87.5,
      latestAgeMinutes: 20,
    };

    const result = await estimator.estimate(market, ensemble, obs);

    const adj = result.reasoning.observationAdjustment!;
    expect(adj.postPeakCollapse).toBe(true);
    expect(adj.runningMax).toBe(87.5);
    expect(adj.latestAgeMinutes).toBe(20);
    expect(result.reasoning.correctedEnsembleStats.mean).toBeCloseTo(87.8, 6); // rm + 0.3
    expect(result.reasoning.sigmaUsed).toBeCloseTo(0.7, 6); // collapsed below the floor
    // sigma 0.7 < the 0.6×2 = 1.2 bracket floor — post-peak deliberately overrides it.
    expect(result.reasoning.obsStale).toBe(false);
  });

  test("pre-peak: existing implied-high behavior, postPeakCollapse false", async () => {
    const estimator = new ProbabilityEstimator();
    const market = makeTodayBracket({ bracketLow: 80, bracketHigh: 82 });
    const ensemble = [79, 80, 80, 81, 81, 81, 82, 82, 83, 84]; // mean ≈ 81.3
    // 15:00Z @ KNYC (EDT) = 11:00 local < 16 → pre-peak. Obs 72 → implied high
    // 72 + offset(11h ≈ 5.67) ≈ 77.7, diverges > 2 from ~81.3 → mean shifts down.
    const obs = {
      observedTemp: 72,
      observedAt: `${today()}T15:00:00Z`,
      runningMax: 73,
      latestAgeMinutes: 15,
    };

    const result = await estimator.estimate(market, ensemble, obs);

    const adj = result.reasoning.observationAdjustment!;
    expect(adj.postPeakCollapse).toBe(false);
    expect(adj.runningMax).toBe(73);
    // Diverges branch: mean blended toward the (lower) implied high, sigma ×0.85.
    expect(adj.meanShift).toBeLessThan(0);
    expect(adj.sigmaAfter / adj.sigmaBefore).toBeCloseTo(0.85, 6);
  });

  test("staleness guard: stale obs ignored entirely, obsStale true, no clamp", async () => {
    const estimator = new ProbabilityEstimator();
    const market = makeTodayBracket();
    const ensemble = [84, 85, 86, 87, 88, 89, 90];
    // latestAgeMinutes 120 > 90 → ignore. Even though obsHour would be post-peak,
    // the staleness guard short-circuits before any adjustment.
    const staleObs = {
      observedTemp: 87.5,
      observedAt: `${today()}T21:30:00Z`,
      runningMax: 87.5,
      latestAgeMinutes: 120,
    };

    const stale = await estimator.estimate(market, ensemble, staleObs);
    const noObs = await estimator.estimate(market, ensemble);

    expect(stale.reasoning.observationAdjustment).toBeNull();
    expect(stale.reasoning.obsStale).toBe(true);
    // No clamp / no mean shift / no collapse → identical to the no-obs estimate.
    expect(stale.reasoning.cdfProbability).toBeCloseTo(noObs.reasoning.cdfProbability, 9);
    expect(stale.reasoning.correctedEnsembleStats.mean).toBeCloseTo(noObs.reasoning.correctedEnsembleStats.mean, 9);
    expect(stale.reasoning.sigmaUsed).toBeCloseTo(noObs.reasoning.sigmaUsed, 9);
    expect(stale.probability).toBeCloseTo(noObs.probability, 9);
  });

  test("missing latestAgeMinutes → treated as fresh (back-compat)", async () => {
    const estimator = new ProbabilityEstimator();
    const market = makeTodayBracket();
    const ensemble = [84, 85, 86, 87, 88, 89, 90];
    // No latestAgeMinutes (e.g. a legacy single-reading caller) → not stale.
    const obs = {
      observedTemp: 86,
      observedAt: `${today()}T21:30:00Z`,
      runningMax: 87.5,
    };
    const result = await estimator.estimate(market, ensemble, obs);
    expect(result.reasoning.obsStale).toBe(false);
    expect(result.reasoning.observationAdjustment!.postPeakCollapse).toBe(true);
    expect(result.reasoning.observationAdjustment!.latestAgeMinutes).toBeNull();
  });

  test("non-high_temp markets are untouched by the obs anchor", async () => {
    const estimator = new ProbabilityEstimator();
    const market = makePrecipMarket({ targetDate: today() });
    const ensemble = [0, 0, 0.1, 0.15, 0.2];
    const obs = {
      observedTemp: 87.5,
      observedAt: `${today()}T21:30:00Z`,
      runningMax: 87.5,
      latestAgeMinutes: 5,
    };
    const result = await estimator.estimate(market, ensemble, obs);
    expect(result.reasoning.observationAdjustment).toBeNull();
    expect(result.reasoning.obsStale).toBe(false);
  });

  test("event coherence preserved under the clamp (finalSum ≈ coverage ≈ 1)", async () => {
    const estimator = new ProbabilityEstimator();
    // Hermetic: priors off so coverage tracks the raw clamped CDF.
    getConfig().bot.historicalPriorWeight = 0;
    getConfig().bot.marketPriorWeight = 0;

    const event = makeEvent({ lo: 78, n: 6 }); // brackets [78,84), tails <78 / >84
    const ensemble = [77.5, 78.5, 79.5, 80.2, 80.8, 81.3, 81.6, 82.4, 82.7, 83.6, 84.5, 85.5];
    // Post-peak obs, rm 81 lands inside the bracket range → the clamp reshapes
    // the vector but a partition must still sum to coverage ≈ 1.
    const obs = {
      observedTemp: 81,
      observedAt: `${today()}T21:30:00Z`,
      runningMax: 81,
      latestAgeMinutes: 10,
    };

    const results = await estimator.estimateEvent(event, ensemble, obs);
    const coverage = [...results.values()][0]!.reasoning.eventCoherence!.rawCdfSum;
    // The clamped slices of a partition still sum to ~1 (coverage).
    expect(coverage).toBeCloseTo(1, 6);
    // finalSum tracks coverage within the documented tail-floor/clamp drift
    // (the impossible lower tail's raw 0 → 0.03 floor adds a little mass the
    // post-clamp step deliberately doesn't renormalize away — eventCoherence
    // telemetry surfaces it). Matches the precision used by the other
    // estimateEvent coverage assertions.
    expect([...results.values()][0]!.reasoning.eventCoherence!.finalSum).toBeCloseTo(sumProbs(results), 9);
    expect(sumProbs(results)).toBeCloseTo(coverage, 1);
    // The clamp actually engaged (post-peak collapse, shared across the event).
    for (const r of results.values()) {
      expect(r.reasoning.observationAdjustment!.postPeakCollapse).toBe(true);
      expect(r.reasoning.observationAdjustment!.runningMax).toBe(81);
    }
    // Lower tail (<78) is impossible given rm 81 → its raw cdf is 0.
    expect(results.get(event[0]!.ticker)!.reasoning.cdfProbability).toBe(0);
  });

  test("event: stale obs → no clamp/collapse, obsStale true on every market", async () => {
    const estimator = new ProbabilityEstimator();
    getConfig().bot.historicalPriorWeight = 0;
    getConfig().bot.marketPriorWeight = 0;
    const event = makeEvent({ lo: 78, n: 6 });
    const ensemble = [77.5, 78.5, 79.5, 80.2, 80.8, 81.3, 81.6, 82.4, 82.7, 83.6, 84.5, 85.5];
    const staleObs = {
      observedTemp: 81,
      observedAt: `${today()}T21:30:00Z`,
      runningMax: 81,
      latestAgeMinutes: 200,
    };

    const withStale = await estimator.estimateEvent(event, ensemble, staleObs);
    const without = await estimator.estimateEvent(event, ensemble);

    for (const r of withStale.values()) {
      expect(r.reasoning.obsStale).toBe(true);
      expect(r.reasoning.observationAdjustment).toBeNull();
    }
    // Identical vector to the no-obs run (the stale obs changed nothing).
    for (const m of event) {
      expect(withStale.get(m.ticker)!.probability).toBeCloseTo(without.get(m.ticker)!.probability, 9);
    }
  });
});
