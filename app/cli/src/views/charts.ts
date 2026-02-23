import plot from "simple-ascii-chart";

/** A portfolio snapshot with timestamp */
export interface PortfolioPoint {
  portfolio: number;
  recordedAt: string;
}

/**
 * Render a portfolio value line chart using simple-ascii-chart.
 * Accepts timestamped snapshots covering the full bot lifetime,
 * downsamples to fit the chart width, and labels the x-axis in hours.
 * Returns a multi-line string ready to embed in <Text>.
 */
export function renderPortfolioChart(
  points: PortfolioPoint[],
  width = 60,
  height = 8,
): string {
  if (points.length === 0) return "  No portfolio data yet.";
  if (points.length === 1) {
    return `  $${(points[0]!.portfolio / 100).toFixed(2)} (single point)`;
  }

  // Downsample to ~width points if needed (keep first and last)
  const sampled = downsample(points, width);

  const t0 = new Date(sampled[0]!.recordedAt).getTime();

  // Plot with x = hours since first snapshot
  const chartPoints: [number, number][] = sampled.map((p) => {
    const hoursElapsed = (new Date(p.recordedAt).getTime() - t0) / 3_600_000;
    return [hoursElapsed, p.portfolio / 100];
  });

  return plot(chartPoints, {
    width,
    height,
    color: "ansiGreen",
    hideXAxis: true,
    formatter: (value, { axis }) => {
      if (axis === "y") return `$${value.toFixed(0)}`;
      return value;
    },
  });
}

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

/** Evenly sample points from an array, always keeping first and last */
function downsample(points: PortfolioPoint[], maxPoints: number): PortfolioPoint[] {
  if (points.length <= maxPoints) return points;

  const result: PortfolioPoint[] = [points[0]!];
  const step = (points.length - 1) / (maxPoints - 1);

  for (let i = 1; i < maxPoints - 1; i++) {
    result.push(points[Math.round(i * step)]!);
  }

  result.push(points[points.length - 1]!);
  return result;
}

/**
 * Render a single horizontal bar using Unicode block characters.
 * Returns a string like: "label  ████████░░░░  value"
 */
export function renderHorizontalBar(
  label: string,
  value: number,
  max: number,
  barWidth = 20,
): string {
  const absMax = Math.abs(max) || 1;
  const absValue = Math.abs(value);
  const filled = Math.round((absValue / absMax) * barWidth);
  const empty = barWidth - filled;

  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `${label}  ${bar}`;
}

/** Bucket data for calibration chart */
export interface BucketData {
  label: string;
  hits: number;
  total: number;
}

/**
 * Render a calibration bucket chart with hit rates.
 * Shows horizontal bars colored by calibration quality.
 */
export function renderBucketChart(buckets: BucketData[]): string {
  if (buckets.length === 0) return "  No calibration data yet.";

  const lines: string[] = [];
  const barWidth = 30;

  // Expected midpoints per bucket label
  const midpoints: Record<string, number> = {
    "0.0-0.1": 0.05,
    "0.1-0.2": 0.15,
    "0.2-0.3": 0.25,
    "0.3-0.5": 0.40,
    "0.5-0.7": 0.60,
    "0.7-1.0": 0.85,
  };

  for (const b of buckets) {
    if (b.total === 0) continue;

    const hitRate = b.hits / b.total;
    const filled = Math.round(hitRate * barWidth);
    const empty = barWidth - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);

    const expected = midpoints[b.label] ?? 0.5;
    const calibError = Math.abs(hitRate - expected);
    const indicator = calibError > 0.15 ? "!" : calibError > 0.10 ? "~" : " ";

    const pct = `${(hitRate * 100).toFixed(0)}%`.padStart(4);
    const counts = `${b.hits}/${b.total}`.padStart(5);

    lines.push(`  ${b.label}  ${bar}  ${counts} ${pct} ${indicator}`);
  }

  return lines.length > 0 ? lines.join("\n") : "  No calibration data yet.";
}

/** Daily P&L entry */
export interface DailyPnlEntry {
  date: string;
  pnl: number;
}

/**
 * Render daily P&L as horizontal bars (green positive, red negative).
 * Returns plain text with ANSI-free labels (coloring handled by Ink).
 */
export function renderDailyPnl(days: DailyPnlEntry[]): string {
  if (days.length === 0) return "  No daily P&L data yet.";

  const maxAbs = Math.max(...days.map((d) => Math.abs(d.pnl)), 1);
  const barWidth = 30;
  const lines: string[] = [];

  for (const d of days) {
    const dayLabel = formatDayLabel(d.date);
    const absVal = Math.abs(d.pnl);
    const filled = Math.round((absVal / maxAbs) * barWidth);
    const empty = barWidth - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    const sign = d.pnl >= 0 ? "+" : "-";
    const amount = `${sign}$${(absVal / 100).toFixed(2)}`;

    lines.push(`  ${dayLabel}  ${bar}  ${amount.padStart(8)}`);
  }

  return lines.join("\n");
}

/** Format ISO date string to short day label (e.g. "Mon 02/17") */
function formatDayLabel(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00Z");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days[date.getUTCDay()]!;
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dayNum = String(date.getUTCDate()).padStart(2, "0");
  return `${day} ${month}/${dayNum}`;
}
