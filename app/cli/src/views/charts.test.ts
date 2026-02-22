import { test, expect, describe } from "bun:test";
import {
  renderEquityChart,
  renderHorizontalBar,
  renderBucketChart,
  renderDailyPnl,
} from "./charts";

describe("renderEquityChart", () => {
  test("returns multi-line string with correct approximate height", () => {
    const values = [4000, 4200, 4100, 4400, 4300, 4500, 4600, 4550, 4700, 4800];
    const result = renderEquityChart(values, 40, 6);
    const lines = result.split("\n");
    // simple-ascii-chart adds axis lines, so height >= requested
    expect(lines.length).toBeGreaterThanOrEqual(6);
  });

  test("returns placeholder for empty data", () => {
    const result = renderEquityChart([]);
    expect(result).toContain("No equity data");
  });

  test("returns single point message for one value", () => {
    const result = renderEquityChart([5000]);
    expect(result).toContain("$50.00");
    expect(result).toContain("single point");
  });

  test("handles two points", () => {
    const result = renderEquityChart([4000, 4200], 30, 4);
    expect(result.split("\n").length).toBeGreaterThanOrEqual(2);
  });

  test("handles all same values", () => {
    const result = renderEquityChart([5000, 5000, 5000, 5000], 30, 4);
    // Should not crash, returns a valid string
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("renderHorizontalBar", () => {
  test("renders proportional bar", () => {
    const result = renderHorizontalBar("Test", 50, 100, 10);
    const filled = (result.match(/█/g) || []).length;
    const empty = (result.match(/░/g) || []).length;
    expect(filled).toBe(5);
    expect(empty).toBe(5);
    expect(result).toContain("Test");
  });

  test("renders full bar at max value", () => {
    const result = renderHorizontalBar("Full", 100, 100, 10);
    const filled = (result.match(/█/g) || []).length;
    expect(filled).toBe(10);
  });

  test("renders empty bar at zero value", () => {
    const result = renderHorizontalBar("Empty", 0, 100, 10);
    const filled = (result.match(/█/g) || []).length;
    const empty = (result.match(/░/g) || []).length;
    expect(filled).toBe(0);
    expect(empty).toBe(10);
  });

  test("handles max of zero gracefully", () => {
    const result = renderHorizontalBar("Zero", 0, 0, 10);
    expect(typeof result).toBe("string");
  });
});

describe("renderBucketChart", () => {
  test("renders buckets with hit rates", () => {
    const buckets = [
      { label: "0.0-0.1", hits: 1, total: 10 },
      { label: "0.1-0.2", hits: 2, total: 8 },
      { label: "0.5-0.7", hits: 4, total: 6 },
    ];
    const result = renderBucketChart(buckets);
    const lines = result.split("\n");
    expect(lines.length).toBe(3);
    expect(result).toContain("0.0-0.1");
    expect(result).toContain("0.5-0.7");
    expect(result).toContain("1/10");
    expect(result).toContain("4/6");
  });

  test("returns placeholder for empty data", () => {
    const result = renderBucketChart([]);
    expect(result).toContain("No calibration data");
  });

  test("skips buckets with zero total", () => {
    const buckets = [
      { label: "0.0-0.1", hits: 0, total: 0 },
      { label: "0.1-0.2", hits: 3, total: 5 },
    ];
    const result = renderBucketChart(buckets);
    expect(result).not.toContain("0.0-0.1");
    expect(result).toContain("0.1-0.2");
  });

  test("marks miscalibrated buckets", () => {
    // 0.0-0.1 bucket with 80% hit rate is very miscalibrated (expected ~5%)
    const buckets = [{ label: "0.0-0.1", hits: 8, total: 10 }];
    const result = renderBucketChart(buckets);
    expect(result).toContain("!");
  });

  test("well-calibrated bucket has no warning marker", () => {
    // 0.5-0.7 bucket with 60% hit rate is well calibrated (expected ~60%)
    const buckets = [{ label: "0.5-0.7", hits: 6, total: 10 }];
    const result = renderBucketChart(buckets);
    expect(result).not.toContain("!");
    expect(result).not.toContain("~");
  });
});

describe("renderDailyPnl", () => {
  test("renders daily P&L bars", () => {
    const days = [
      { date: "2026-02-17", pnl: 240 },
      { date: "2026-02-18", pnl: -120 },
      { date: "2026-02-19", pnl: 80 },
    ];
    const result = renderDailyPnl(days);
    const lines = result.split("\n");
    expect(lines.length).toBe(3);
    expect(result).toContain("Tue");
    expect(result).toContain("Wed");
    expect(result).toContain("Thu");
    expect(result).toContain("+$2.40");
    expect(result).toContain("-$1.20");
  });

  test("returns placeholder for empty data", () => {
    const result = renderDailyPnl([]);
    expect(result).toContain("No daily P&L data");
  });

  test("handles all zeros", () => {
    const days = [
      { date: "2026-02-20", pnl: 0 },
      { date: "2026-02-21", pnl: 0 },
    ];
    const result = renderDailyPnl(days);
    expect(result).toContain("+$0.00");
  });

  test("handles all negative values", () => {
    const days = [
      { date: "2026-02-20", pnl: -500 },
      { date: "2026-02-21", pnl: -200 },
    ];
    const result = renderDailyPnl(days);
    expect(result).toContain("-$5.00");
    expect(result).toContain("-$2.00");
  });
});
