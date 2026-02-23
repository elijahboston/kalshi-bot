import { test, expect, describe } from "bun:test";
import {
  renderPortfolioChart,
  renderHorizontalBar,
  renderBucketChart,
  renderDailyPnl,
  formatDuration,
  type PortfolioPoint,
} from "./charts";

/** Helper to build PortfolioPoint[] from values with hourly spacing */
function makePoints(values: number[], startIso = "2026-02-20T00:00:00Z"): PortfolioPoint[] {
  const t0 = new Date(startIso).getTime();
  return values.map((v, i) => ({
    portfolio: v,
    recordedAt: new Date(t0 + i * 3_600_000).toISOString(),
  }));
}

describe("renderPortfolioChart", () => {
  test("returns multi-line string with correct approximate height", () => {
    const points = makePoints([4000, 4200, 4100, 4400, 4300, 4500, 4600, 4550, 4700, 4800]);
    const result = renderPortfolioChart(points, 40, 6);
    const lines = result.split("\n");
    // simple-ascii-chart adds axis lines, so height >= requested
    expect(lines.length).toBeGreaterThanOrEqual(6);
  });

  test("returns placeholder for empty data", () => {
    const result = renderPortfolioChart([]);
    expect(result).toContain("No portfolio data");
  });

  test("returns single point message for one value", () => {
    const result = renderPortfolioChart(makePoints([5000]));
    expect(result).toContain("$50.00");
    expect(result).toContain("single point");
  });

  test("handles two points", () => {
    const result = renderPortfolioChart(makePoints([4000, 4200]), 30, 4);
    expect(result.split("\n").length).toBeGreaterThanOrEqual(2);
  });

  test("handles all same values", () => {
    const result = renderPortfolioChart(makePoints([5000, 5000, 5000, 5000]), 30, 4);
    // Should not crash, returns a valid string
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("downsamples large datasets without crashing", () => {
    const values = Array.from({ length: 500 }, (_, i) => 4000 + i * 2);
    const result = renderPortfolioChart(makePoints(values), 60, 8);
    expect(result.split("\n").length).toBeGreaterThanOrEqual(4);
  });
});

describe("formatDuration", () => {
  test("formats days and hours", () => {
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
  });

  test("formats hours and minutes", () => {
    expect(formatDuration(2 * 3_600_000 + 15 * 60_000)).toBe("2h 15m");
  });

  test("formats minutes only", () => {
    expect(formatDuration(45 * 60_000)).toBe("45m");
  });

  test("formats zero", () => {
    expect(formatDuration(0)).toBe("0m");
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
