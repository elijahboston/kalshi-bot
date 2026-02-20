import { getDb, calibration, stationBias, adaptiveThresholds, desc, gte, and } from "@kcb/db";
import { getConfig } from "@kcb/config";
import type { CommandDef } from "./index";

/** Probability buckets for calibration analysis */
const BUCKETS = [
  { label: "0.0-0.1", low: 0.0, high: 0.1, midpoint: 0.05 },
  { label: "0.1-0.2", low: 0.1, high: 0.2, midpoint: 0.15 },
  { label: "0.2-0.3", low: 0.2, high: 0.3, midpoint: 0.25 },
  { label: "0.3-0.5", low: 0.3, high: 0.5, midpoint: 0.40 },
  { label: "0.5-0.7", low: 0.5, high: 0.7, midpoint: 0.60 },
  { label: "0.7-1.0", low: 0.7, high: 1.0, midpoint: 0.85 },
] as const;

export const calibrationCommands: CommandDef[] = [
  {
    name: "calibration",
    aliases: ["cal"],
    description: "Calibration summary",
    usage: "calibration [summary | detail | retrain]",
    handler: async (args) => {
      const subcommand = args[0]?.toLowerCase() || "summary";

      if (subcommand === "summary") {
        return await calibrationSummary();
      }
      if (subcommand === "detail") {
        return await calibrationDetail(args[1]);
      }
      if (subcommand === "retrain") {
        return await retrainCalibration();
      }
      if (subcommand === "bias") {
        return await showBias(args[1]);
      }

      return 'Usage: calibration [summary | detail <series> | retrain | bias <station>]';
    },
  },
];

async function calibrationSummary(): Promise<string> {
  const config = getConfig();
  const db = getDb();
  const windowDays = config.calibration.calibrationWindowDays;
  const cutoff = new Date(Date.now() - windowDays * 86400_000).toISOString();

  const records = await db
    .select()
    .from(calibration)
    .where(gte(calibration.resolvedAt, cutoff))
    .orderBy(desc(calibration.resolvedAt));

  if (records.length === 0) {
    return "No calibration data yet. Markets need to resolve first.";
  }

  // Brier score
  const brierScore =
    records.reduce((sum, r) => {
      const error = r.predictedProb - r.actualOutcome;
      return sum + error * error;
    }, 0) / records.length;

  // Bucket breakdown
  const bucketLines = BUCKETS.map((bucket) => {
    const inBucket = records.filter(
      (r) => r.predictedProb >= bucket.low && r.predictedProb < bucket.high
    );
    if (inBucket.length === 0) return null;

    const hitRate =
      inBucket.filter((r) => r.actualOutcome === 1).length / inBucket.length;
    const expected = bucket.midpoint;
    const calibError = Math.abs(hitRate - expected);
    const status = calibError > 0.10 ? "⚠️" : "✓";

    return `  ${bucket.label}: predicted ${inBucket.length}, hit ${
      inBucket.filter((r) => r.actualOutcome === 1).length
    } (${(hitRate * 100).toFixed(1)}%) — expected ~${(expected * 100).toFixed(0)}%  ${status}`;
  }).filter(Boolean);

  // Traded vs skipped
  const traded = records.filter((r) => r.traded);
  const totalPnl = traded.reduce((sum, r) => sum + (r.realizedPnl ?? 0), 0);

  const lines = [
    `Last ${windowDays} days — ${records.length} markets resolved`,
    `Brier score: ${brierScore.toFixed(3)} (good: < 0.25)`,
    "",
    "Bucket breakdown:",
    ...bucketLines,
    "",
    `Traded: ${traded.length} markets`,
    `Total realized PnL: ${totalPnl >= 0 ? "+" : ""}$${(totalPnl / 100).toFixed(2)}`,
  ];

  return lines.join("\n");
}

async function calibrationDetail(seriesTicker?: string): Promise<string> {
  const db = getDb();
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();

  let query = db
    .select()
    .from(calibration)
    .where(gte(calibration.resolvedAt, cutoff))
    .orderBy(desc(calibration.resolvedAt))
    .limit(30);

  if (seriesTicker) {
    query = query.where(
      and(
        gte(calibration.resolvedAt, cutoff),
        // @ts-expect-error — drizzle typing for dynamic where
        calibration.seriesTicker.eq(seriesTicker)
      )
    ) as typeof query;
  }

  const records = await query;

  if (records.length === 0) {
    return seriesTicker
      ? `No calibration data for series ${seriesTicker}`
      : "No calibration data available.";
  }

  const header =
    "TICKER".padEnd(28) +
    "PRED".padStart(6) +
    "MKT".padStart(6) +
    "ACTUAL".padStart(7) +
    "EDGE".padStart(7) +
    "P&L".padStart(8);

  const lines = records.map((r) => {
    const pnl = r.realizedPnl != null ? `$${(r.realizedPnl / 100).toFixed(2)}` : "—";
    return (
      r.ticker.slice(0, 27).padEnd(28) +
      `${(r.predictedProb * 100).toFixed(0)}%`.padStart(6) +
      `${(r.marketPrice * 100).toFixed(0)}%`.padStart(6) +
      (r.actualOutcome === 1 ? "  YES" : "  NO ").padStart(7) +
      `${(r.edge * 100).toFixed(1)}¢`.padStart(7) +
      pnl.padStart(8)
    );
  });

  return [header, "─".repeat(62), ...lines].join("\n");
}

async function showBias(stationId?: string): Promise<string> {
  const db = getDb();

  let rows;
  if (stationId) {
    rows = await db
      .select()
      .from(stationBias)
      .where(gte(stationBias.stationId, stationId.toUpperCase()));
  } else {
    rows = await db.select().from(stationBias);
  }

  if (rows.length === 0) {
    return "No station bias data yet. Needs market resolutions.";
  }

  const header = "STATION".padEnd(8) + "HORIZON".padStart(8) + "BIAS (°F)".padStart(10) + "STD".padStart(8) + "N".padStart(6);
  const lines = rows.map((r) =>
    r.stationId.padEnd(8) +
    `${r.forecastHorizonDays}d`.padStart(8) +
    `${r.meanBias >= 0 ? "+" : ""}${r.meanBias.toFixed(2)}`.padStart(10) +
    r.stdBias.toFixed(2).padStart(8) +
    String(r.sampleSize).padStart(6)
  );

  return [header, "─".repeat(40), ...lines].join("\n");
}

async function retrainCalibration(): Promise<string> {
  // TODO: Implement full recalibration
  // 1. Recompute all station biases from full history
  // 2. Recompute adaptive thresholds per bucket per series
  // 3. Update confidence model weights
  return "Retrain initiated... (not yet implemented — stub for now)";
}
