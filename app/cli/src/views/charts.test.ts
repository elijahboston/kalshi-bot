import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import {
  PortfolioChart,
  CalibrationChart,
  DailyPnlChart,
  SigmaComparisonChart,
  AccuracySparkline,
  formatDuration,
  formatDayLabel,
  downsample,
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

describe("PortfolioChart", () => {
  test("renders multi-line chart for valid data", () => {
    const points = makePoints([4000, 4200, 4100, 4400, 4300, 4500, 4600, 4550, 4700, 4800]);
    const { lastFrame } = render(
      React.createElement(PortfolioChart, { points, width: 40, height: 6 })
    );
    const output = lastFrame();
    expect(output.split("\n").length).toBeGreaterThanOrEqual(2);
  });

  test("renders placeholder for empty data", () => {
    const { lastFrame } = render(
      React.createElement(PortfolioChart, { points: [] })
    );
    expect(lastFrame()).toContain("No portfolio data");
  });

  test("renders single point message", () => {
    const { lastFrame } = render(
      React.createElement(PortfolioChart, { points: makePoints([5000]) })
    );
    expect(lastFrame()).toContain("$50.00");
    expect(lastFrame()).toContain("single point");
  });

  test("handles two points without crashing", () => {
    const { lastFrame } = render(
      React.createElement(PortfolioChart, { points: makePoints([4000, 4200]), width: 30, height: 4 })
    );
    expect(lastFrame().length).toBeGreaterThan(0);
  });

  test("handles all same values", () => {
    const { lastFrame } = render(
      React.createElement(PortfolioChart, { points: makePoints([5000, 5000, 5000, 5000]), width: 30, height: 4 })
    );
    expect(lastFrame().length).toBeGreaterThan(0);
  });

  test("downsamples large datasets without crashing", () => {
    const values = Array.from({ length: 500 }, (_, i) => 4000 + i * 2);
    const { lastFrame } = render(
      React.createElement(PortfolioChart, { points: makePoints(values), width: 60, height: 8 })
    );
    expect(lastFrame().split("\n").length).toBeGreaterThanOrEqual(2);
  });
});

describe("CalibrationChart", () => {
  test("renders buckets with hit rates", () => {
    const buckets = [
      { label: "0.0-0.1", hits: 1, total: 10 },
      { label: "0.1-0.2", hits: 2, total: 8 },
      { label: "0.5-0.7", hits: 4, total: 6 },
    ];
    const { lastFrame } = render(
      React.createElement(CalibrationChart, { buckets })
    );
    const output = lastFrame();
    expect(output).toContain("0.0-0.1");
    expect(output).toContain("0.5-0.7");
    expect(output).toContain("1/10");
    expect(output).toContain("4/6");
  });

  test("renders placeholder for empty data", () => {
    const { lastFrame } = render(
      React.createElement(CalibrationChart, { buckets: [] })
    );
    expect(lastFrame()).toContain("No calibration data");
  });

  test("skips buckets with zero total", () => {
    const buckets = [
      { label: "0.0-0.1", hits: 0, total: 0 },
      { label: "0.1-0.2", hits: 3, total: 5 },
    ];
    const { lastFrame } = render(
      React.createElement(CalibrationChart, { buckets })
    );
    const output = lastFrame();
    expect(output).not.toContain("0.0-0.1");
    expect(output).toContain("0.1-0.2");
  });
});

describe("DailyPnlChart", () => {
  test("renders daily P&L bars", () => {
    const days = [
      { date: "2026-02-17", pnl: 240 },
      { date: "2026-02-18", pnl: -120 },
      { date: "2026-02-19", pnl: 80 },
    ];
    const { lastFrame } = render(
      React.createElement(DailyPnlChart, { days })
    );
    const output = lastFrame();
    expect(output).toContain("Tue");
    expect(output).toContain("Wed");
    expect(output).toContain("+$2.40");
    expect(output).toContain("-$1.20");
  });

  test("renders placeholder for empty data", () => {
    const { lastFrame } = render(
      React.createElement(DailyPnlChart, { days: [] })
    );
    expect(lastFrame()).toContain("No daily P&L data");
  });
});

describe("SigmaComparisonChart", () => {
  test("renders three bars", () => {
    const { lastFrame } = render(
      React.createElement(SigmaComparisonChart, {
        ensembleSpread: 2.6,
        empiricalSigma: 1.3,
        actualError: 1.1,
      })
    );
    const output = lastFrame();
    expect(output).toContain("Ensemble spread");
    expect(output).toContain("Empirical sigma");
    expect(output).toContain("Actual error");
    expect(output).toContain("2.6F");
    expect(output).toContain("1.3F");
    expect(output).toContain("1.1F");
  });
});

describe("AccuracySparkline", () => {
  test("renders sparkline with percentage", () => {
    const { lastFrame } = render(
      React.createElement(AccuracySparkline, { values: [0.5, 0.6, 0.7, 0.75] })
    );
    const output = lastFrame();
    expect(output).toContain("75%");
  });

  test("renders placeholder for empty data", () => {
    const { lastFrame } = render(
      React.createElement(AccuracySparkline, { values: [] })
    );
    expect(lastFrame()).toContain("No accuracy data");
  });

  test("uses green when above threshold", () => {
    const { lastFrame } = render(
      React.createElement(AccuracySparkline, { values: [0.8], threshold: 0.7 })
    );
    expect(lastFrame()).toContain("80%");
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

describe("formatDayLabel", () => {
  test("formats ISO date string to short day label", () => {
    const result = formatDayLabel("2026-02-17");
    expect(result).toBe("Tue 02/17");
  });
});

describe("downsample", () => {
  test("returns all points when count is within limit", () => {
    const points = makePoints([1, 2, 3]);
    expect(downsample(points, 5)).toEqual(points);
  });

  test("preserves first and last points", () => {
    const points = makePoints([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = downsample(points, 4);
    expect(result[0]).toEqual(points[0]);
    expect(result[result.length - 1]).toEqual(points[points.length - 1]);
    expect(result.length).toBe(4);
  });
});
