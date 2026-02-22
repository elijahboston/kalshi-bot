import plot from "simple-ascii-chart";

/**
 * Render an equity curve line chart using simple-ascii-chart.
 * Returns a multi-line string ready to embed in <Text>.
 */
export function renderEquityChart(
  values: number[],
  width = 60,
  height = 8,
): string {
  if (values.length === 0) return "  No equity data yet.";
  if (values.length === 1) {
    return `  $${(values[0]! / 100).toFixed(2)} (single point)`;
  }

  // Convert cents to dollars for display, indexed by position
  const points: [number, number][] = values.map((v, i) => [i, v / 100]);

  return plot(points, {
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
