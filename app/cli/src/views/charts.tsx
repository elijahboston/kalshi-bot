import React from "react";
import { Box, Text } from "ink";
import { LineGraph } from "@pppp606/ink-chart";

// ═══════════════════════════════════════════════════════════
// Data interfaces (unchanged — these are the data contracts)
// ═══════════════════════════════════════════════════════════

/** A portfolio snapshot with timestamp */
export interface PortfolioPoint {
  portfolio: number;
  recordedAt: string;
}

/** Bucket data for calibration chart */
export interface BucketData {
  label: string;
  hits: number;
  total: number;
}

/** Daily P&L entry */
export interface DailyPnlEntry {
  date: string;
  pnl: number;
}

// ═══════════════════════════════════════════════════════════
// Utility functions (kept — used across views)
// ═══════════════════════════════════════════════════════════

/** Format a duration in ms to a human-readable label like "3d 4h" or "2h 15m" */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Format ISO date string to short day label (e.g. "Mon 02/17") */
export function formatDayLabel(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00Z");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days[date.getUTCDay()]!;
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dayNum = String(date.getUTCDate()).padStart(2, "0");
  return `${day} ${month}/${dayNum}`;
}

/** Evenly sample points from an array, always keeping first and last */
export function downsample<T>(points: T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) return points;

  const result: T[] = [points[0]!];
  const step = (points.length - 1) / (maxPoints - 1);

  for (let i = 1; i < maxPoints - 1; i++) {
    result.push(points[Math.round(i * step)]!);
  }

  result.push(points[points.length - 1]!);
  return result;
}

// ═══════════════════════════════════════════════════════════
// Chart components
// ═══════════════════════════════════════════════════════════

/** Portfolio equity line chart */
export function PortfolioChart({
  points,
  width = 60,
  height = 8,
}: {
  points: PortfolioPoint[];
  width?: number;
  height?: number;
}) {
  if (points.length === 0) {
    return <Text color="gray">  No portfolio data yet.</Text>;
  }
  if (points.length === 1) {
    return (
      <Text color="green">
        {"  "}${(points[0]!.portfolio / 100).toFixed(2)} (single point)
      </Text>
    );
  }

  const sampled = downsample(points, width);
  const values = sampled.map((p) => p.portfolio / 100);

  // Build y-axis labels: min and max dollar values
  const min = Math.min(...values);
  const max = Math.max(...values);
  const yLabels = min === max ? [`$${min.toFixed(0)}`] : [`$${min.toFixed(0)}`, `$${max.toFixed(0)}`];

  return (
    <LineGraph
      data={[{ values, color: "green" }]}
      width={width}
      height={height}
      yLabels={yLabels}
    />
  );
}

/** Expected midpoints per calibration bucket label */
const BUCKET_MIDPOINTS: Record<string, number> = {
  "0.0-0.1": 0.05,
  "0.1-0.2": 0.15,
  "0.2-0.3": 0.25,
  "0.3-0.5": 0.40,
  "0.5-0.7": 0.60,
  "0.7-1.0": 0.85,
};

/** Calibration bucket bar chart */
export function CalibrationChart({ buckets }: { buckets: BucketData[] }) {
  const barWidth = 30;
  const filtered = buckets.filter((b) => b.total > 0);

  if (filtered.length === 0) {
    return <Text color="gray">  No calibration data yet.</Text>;
  }

  return (
    <Box flexDirection="column">
      {filtered.map((b) => {
        const hitRate = b.hits / b.total;
        const filled = Math.round(hitRate * barWidth);
        const empty = barWidth - filled;
        const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);

        const expected = BUCKET_MIDPOINTS[b.label] ?? 0.5;
        const calibError = Math.abs(hitRate - expected);
        const indicator =
          calibError > 0.15 ? "!" : calibError > 0.1 ? "~" : " ";

        const pct = `${(hitRate * 100).toFixed(0)}%`.padStart(4);
        const counts = `${b.hits}/${b.total}`.padStart(5);

        return (
          <Text key={b.label}>
            {"  "}
            {b.label}{"  "}
            <Text color="green">{bar}</Text>
            {"  "}{counts} {pct}{" "}
            <Text color={calibError > 0.15 ? "red" : calibError > 0.1 ? "yellow" : "gray"}>
              {indicator}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}

/** Daily P&L bar chart */
export function DailyPnlChart({ days }: { days: DailyPnlEntry[] }) {
  if (days.length === 0) {
    return <Text color="gray">  No daily P&L data yet.</Text>;
  }

  const maxAbs = Math.max(...days.map((d) => Math.abs(d.pnl)), 1);
  const barWidth = 30;

  return (
    <Box flexDirection="column">
      {days.map((d) => {
        const absVal = Math.abs(d.pnl);
        const filled = Math.round((absVal / maxAbs) * barWidth);
        const empty = barWidth - filled;
        const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
        const sign = d.pnl >= 0 ? "+" : "-";
        const amount = `${sign}$${(absVal / 100).toFixed(2)}`;
        const color = d.pnl >= 0 ? "green" : "red";
        const dayLabel = formatDayLabel(d.date);

        return (
          <Text key={d.date}>
            {"  "}{dayLabel}{"  "}
            <Text color={color}>{bar}</Text>
            {"  "}{amount.padStart(8)}
          </Text>
        );
      })}
    </Box>
  );
}

/** Sigma comparison bar chart (new — for #8 forecast accuracy) */
export function SigmaComparisonChart({
  ensembleSpread,
  empiricalSigma,
  actualError,
}: {
  ensembleSpread: number;
  empiricalSigma: number;
  actualError: number;
}) {
  const maxVal = Math.max(ensembleSpread, empiricalSigma, actualError, 0.1);
  const barWidth = 30;

  const rows = [
    { label: "Ensemble spread", value: ensembleSpread, color: "yellow" as const },
    { label: "Empirical sigma", value: empiricalSigma, color: "cyan" as const },
    { label: "Actual error", value: actualError, color: "green" as const },
  ];

  return (
    <Box flexDirection="column">
      {rows.map((r) => {
        const filled = Math.round((r.value / maxVal) * barWidth);
        const empty = barWidth - filled;
        const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);

        return (
          <Text key={r.label}>
            {"  "}{r.label.padEnd(17)}
            <Text color={r.color}>{bar}</Text>
            {"  "}{r.value.toFixed(1)}F
          </Text>
        );
      })}
    </Box>
  );
}

/** Unicode sparkline characters for AccuracySparkline */
const SPARK_CHARS = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";

/** Accuracy sparkline (new — for #8 forecast accuracy) */
export function AccuracySparkline({
  values,
  threshold = 0.7,
}: {
  values: number[];
  threshold?: number;
}) {
  if (values.length === 0) {
    return <Text color="gray">No accuracy data</Text>;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const sparkChars = values.map((v) => {
    const normalized = (v - min) / range;
    const idx = Math.min(Math.floor(normalized * 8), 7);
    return SPARK_CHARS[idx]!;
  });

  const latest = values[values.length - 1]!;
  const aboveThreshold = latest >= threshold;

  return (
    <Text>
      <Text color={aboveThreshold ? "green" : "yellow"}>{sparkChars.join("")}</Text>
      <Text color={aboveThreshold ? "green" : "yellow"}>
        {" "}{(latest * 100).toFixed(0)}%
      </Text>
    </Text>
  );
}

