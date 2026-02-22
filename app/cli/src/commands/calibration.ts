import { getDb, calibration, stationBias, adaptiveThresholds, weatherForecasts, desc, gte, and, eq, sql } from "@kcb/db";
import { getConfig } from "@kcb/config";
import { now } from "@kcb/shared";
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

  const whereClause = seriesTicker
    ? and(gte(calibration.resolvedAt, cutoff), eq(calibration.seriesTicker, seriesTicker))
    : gte(calibration.resolvedAt, cutoff);

  const records = await db
    .select()
    .from(calibration)
    .where(whereClause)
    .orderBy(desc(calibration.resolvedAt))
    .limit(30);

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
  const config = getConfig();
  const db = getDb();
  const timestamp = now();
  const lines: string[] = ["Retraining calibration...", ""];

  // 1. Recompute all station biases from weather_forecasts where actualValue is set
  const forecasts = await db
    .select()
    .from(weatherForecasts)
    .where(sql`${weatherForecasts.actualValue} IS NOT NULL`);

  // Group by stationId + horizon
  const biasGroups = new Map<string, { errors: number[]; stationId: string; horizon: number }>();

  for (const f of forecasts) {
    if (f.pointForecast == null || f.actualValue == null) continue;
    const horizon = Math.min(f.forecastHorizon, 7);
    const key = `${f.stationId}_${horizon}`;
    let group = biasGroups.get(key);
    if (!group) {
      group = { errors: [], stationId: f.stationId, horizon };
      biasGroups.set(key, group);
    }
    group.errors.push(f.pointForecast - f.actualValue);
  }

  let biasCount = 0;
  for (const [key, group] of biasGroups) {
    const n = group.errors.length;
    if (n === 0) continue;

    const meanBias = group.errors.reduce((a, b) => a + b, 0) / n;
    const variance = group.errors.reduce((s, e) => s + (e - meanBias) ** 2, 0) / n;
    const stdBias = Math.sqrt(variance);

    const existing = await db
      .select()
      .from(stationBias)
      .where(eq(stationBias.id, key))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(stationBias)
        .set({
          meanBias,
          stdBias,
          sampleSize: n,
          windowDays: config.calibration.biasWindowDays,
          updatedAt: timestamp,
        })
        .where(eq(stationBias.id, key));
    } else {
      await db.insert(stationBias).values({
        id: key,
        stationId: group.stationId,
        forecastHorizonDays: group.horizon,
        meanBias,
        stdBias,
        sampleSize: n,
        windowDays: config.calibration.biasWindowDays,
        updatedAt: timestamp,
      });
    }
    biasCount++;
  }

  lines.push(`Station biases: updated ${biasCount} entries from ${forecasts.length} forecasts`);

  // 2. Recompute adaptive thresholds per bucket per series from calibration history
  const calRecords = await db.select().from(calibration);

  // Group by seriesTicker
  const seriesMap = new Map<string, typeof calRecords>();
  for (const r of calRecords) {
    const existing = seriesMap.get(r.seriesTicker) || [];
    existing.push(r);
    seriesMap.set(r.seriesTicker, existing);
  }

  // Also compute global
  seriesMap.set("__global__", calRecords);

  const baseThreshold = config.bot.edgeThreshold;
  let thresholdCount = 0;

  for (const [seriesTicker, records] of seriesMap) {
    if (records.length < 5) continue;

    for (const bucket of BUCKETS) {
      const inBucket = records.filter(
        (r) => r.predictedProb >= bucket.low && r.predictedProb < bucket.high
      );
      if (inBucket.length < 3) continue;

      const hitRate = inBucket.filter((r) => r.actualOutcome === 1).length / inBucket.length;
      const expectedRate = bucket.midpoint;
      const calibrationError = Math.abs(hitRate - expectedRate);

      let effectiveThreshold: number;
      if (calibrationError > config.calibration.maxCalibrationError) {
        effectiveThreshold = baseThreshold * (1 + calibrationError);
      } else {
        effectiveThreshold = baseThreshold * 0.9;
      }

      const thresholdId = `${seriesTicker}_${bucket.label}`;

      const existing = await db
        .select()
        .from(adaptiveThresholds)
        .where(eq(adaptiveThresholds.id, thresholdId))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(adaptiveThresholds)
          .set({
            edgeThreshold: effectiveThreshold,
            calibrationError,
            sampleSize: inBucket.length,
            updatedAt: timestamp,
          })
          .where(eq(adaptiveThresholds.id, thresholdId));
      } else {
        await db.insert(adaptiveThresholds).values({
          id: thresholdId,
          seriesTicker,
          bucketLabel: bucket.label,
          edgeThreshold: effectiveThreshold,
          calibrationError,
          sampleSize: inBucket.length,
          updatedAt: timestamp,
        });
      }
      thresholdCount++;
    }
  }

  lines.push(`Adaptive thresholds: updated ${thresholdCount} entries from ${calRecords.length} calibration records`);
  lines.push("");
  lines.push("Retrain complete.");

  return lines.join("\n");
}
