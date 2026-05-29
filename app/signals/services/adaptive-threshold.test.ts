import { test, expect, describe, beforeEach } from "bun:test";
import { getBucket, BUCKETS, computeBucketThreshold, persistAdaptiveThresholds } from "./adaptive-threshold";
import { runMigrations, getDb, calibration, adaptiveThresholds } from "@kcb/db";
import { getConfig } from "@kcb/config";

runMigrations();

beforeEach(() => {
  const db = getDb();
  db.delete(calibration).run();
  db.delete(adaptiveThresholds).run();
});

function makeCalibrationRow(overrides: Partial<any> = {}) {
  return {
    id: crypto.randomUUID(),
    ticker: "KXHIGHNY-25FEB19-B30",
    seriesTicker: "KXHIGHNY",
    category: "high_temp",
    stationId: "KNYC",
    predictedProb: 0.15,
    actualOutcome: 0,
    marketPrice: 0.5,
    edge: 0.1,
    traded: false,
    resolvedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("BUCKETS", () => {
  test("has 6 buckets", () => {
    expect(BUCKETS.length).toBe(6);
  });

  test("buckets cover 0.0 to 1.0 without gaps", () => {
    expect(BUCKETS[0]!.low).toBe(0.0);
    for (let i = 1; i < BUCKETS.length; i++) {
      expect(BUCKETS[i]!.low as number).toBe(BUCKETS[i - 1]!.high as number);
    }
    expect(BUCKETS[5]!.high).toBe(1.0);
  });
});

describe("getBucket", () => {
  test("0.0 falls into first bucket", () => {
    expect(getBucket(0.0).label).toBe("0.0-0.1");
  });

  test("0.05 falls into first bucket", () => {
    expect(getBucket(0.05).label).toBe("0.0-0.1");
  });

  test("exact boundary 0.1 falls into second bucket (left-inclusive)", () => {
    expect(getBucket(0.1).label).toBe("0.1-0.2");
  });

  test("0.15 falls into second bucket", () => {
    expect(getBucket(0.15).label).toBe("0.1-0.2");
  });

  test("exact boundary 0.2 falls into third bucket", () => {
    expect(getBucket(0.2).label).toBe("0.2-0.3");
  });

  test("exact boundary 0.3 falls into fourth bucket", () => {
    expect(getBucket(0.3).label).toBe("0.3-0.5");
  });

  test("0.5 falls into fifth bucket", () => {
    expect(getBucket(0.5).label).toBe("0.5-0.7");
  });

  test("0.7 falls into last bucket", () => {
    expect(getBucket(0.7).label).toBe("0.7-1.0");
  });

  test("0.95 falls into last bucket", () => {
    expect(getBucket(0.95).label).toBe("0.7-1.0");
  });

  test("1.0 falls into last bucket (fallback)", () => {
    // 1.0 is not < 1.0 so no bucket matches, fallback is last bucket
    const bucket = getBucket(1.0);
    expect(bucket.label).toBe("0.7-1.0");
  });

  test("negative value falls into last bucket (fallback)", () => {
    // No bucket matches negative values, fallback is last bucket
    const bucket = getBucket(-0.1);
    expect(bucket.label).toBe("0.7-1.0");
  });

  test("mid-range values land in correct buckets", () => {
    expect(getBucket(0.25).label).toBe("0.2-0.3");
    expect(getBucket(0.4).label).toBe("0.3-0.5");
    expect(getBucket(0.6).label).toBe("0.5-0.7");
    expect(getBucket(0.85).label).toBe("0.7-1.0");
  });
});

describe("computeBucketThreshold", () => {
  test("returns null when sample size < 5", () => {
    expect(computeBucketThreshold([1, 0, 1, 0], 0.5, 0.2, 0.05)).toBeNull();
  });

  test("well-calibrated bucket gets tightened threshold (×0.9)", () => {
    // hitRate = 0.5, bucketMid = 0.5 → error = 0 → well-calibrated
    const result = computeBucketThreshold([1, 1, 1, 0, 0, 0], 0.5, 0.2, 0.05);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBeCloseTo(0.18, 4);
    expect(result!.calibrationError).toBe(0);
    expect(result!.sampleSize).toBe(6);
  });

  test("miscalibrated bucket gets bumped threshold", () => {
    // bucketMid 0.15, hitRate 0/10 = 0 → error 0.15, exceeds 0.05
    // threshold = 0.2 × 1.15 = 0.23
    const actuals = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const result = computeBucketThreshold(actuals, 0.15, 0.2, 0.05);
    expect(result).not.toBeNull();
    expect(result!.calibrationError).toBeCloseTo(0.15, 4);
    expect(result!.threshold).toBeCloseTo(0.23, 4);
  });
});

describe("persistAdaptiveThresholds", () => {
  test("returns 0 when calibration table is empty", async () => {
    const written = await persistAdaptiveThresholds();
    expect(written).toBe(0);
  });

  test("returns 0 when no series has >= 5 records", async () => {
    const db = getDb();
    for (let i = 0; i < 4; i++) {
      db.insert(calibration).values(makeCalibrationRow()).run();
    }
    const written = await persistAdaptiveThresholds();
    expect(written).toBe(0);
  });

  test("writes one row per (series, bucket) with sufficient data", async () => {
    const db = getDb();
    // 10 rows all in bucket 0.1-0.2, all actualOutcome=0 (miscalibrated)
    for (let i = 0; i < 10; i++) {
      db.insert(calibration).values(makeCalibrationRow({ predictedProb: 0.15, actualOutcome: 0 })).run();
    }
    const written = await persistAdaptiveThresholds();
    // 1 series (KXHIGHNY) + __global__ alias = 2 series, 1 populated bucket each
    expect(written).toBe(2);

    const rows = await db.select().from(adaptiveThresholds);
    expect(rows.length).toBe(2);
    const seriesRow = rows.find((r) => r.seriesTicker === "KXHIGHNY")!;
    expect(seriesRow.bucketLabel).toBe("0.1-0.2");
    expect(seriesRow.sampleSize).toBe(10);
    // miscalibrated → bumped
    expect(seriesRow.edgeThreshold).toBeGreaterThan(getConfig().bot.edgeThreshold);
  });

  test("upserts existing rows on second call", async () => {
    const db = getDb();
    for (let i = 0; i < 6; i++) {
      db.insert(calibration).values(makeCalibrationRow({ predictedProb: 0.15, actualOutcome: i % 2 })).run();
    }
    await persistAdaptiveThresholds();
    await persistAdaptiveThresholds();

    const rows = await db.select().from(adaptiveThresholds);
    // Both calls should converge on the same id; upsert means no duplicates.
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(rows.length);
  });
});
