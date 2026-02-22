import { test, expect, describe } from "bun:test";
import { getBucket, BUCKETS } from "./adaptive-threshold";

describe("BUCKETS", () => {
  test("has 6 buckets", () => {
    expect(BUCKETS.length).toBe(6);
  });

  test("buckets cover 0.0 to 1.0 without gaps", () => {
    expect(BUCKETS[0]!.low).toBe(0.0);
    for (let i = 1; i < BUCKETS.length; i++) {
      expect(BUCKETS[i]!.low).toBe(BUCKETS[i - 1]!.high);
    }
    expect(BUCKETS[BUCKETS.length - 1]!.high).toBe(1.0);
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
