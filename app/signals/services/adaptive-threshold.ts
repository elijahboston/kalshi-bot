import { getDb, calibration, adaptiveThresholds, and, eq, gte } from "@kcb/db";
import { getConfig } from "@kcb/config";
import { createLogger } from "@kcb/engine";

const log = createLogger("adaptive-threshold");

export const BUCKETS = [
  { label: "0.0-0.1", low: 0.0, high: 0.1 },
  { label: "0.1-0.2", low: 0.1, high: 0.2 },
  { label: "0.2-0.3", low: 0.2, high: 0.3 },
  { label: "0.3-0.5", low: 0.3, high: 0.5 },
  { label: "0.5-0.7", low: 0.5, high: 0.7 },
  { label: "0.7-1.0", low: 0.7, high: 1.0 },
] as const;

export function getBucket(prob: number) {
  return BUCKETS.find((b) => prob >= b.low && prob < b.high) || BUCKETS[BUCKETS.length - 1]!;
}

/**
 * Get the effective edge threshold for a given estimated probability and series.
 * If we're miscalibrated in that bucket, require more edge. If well-calibrated, allow less.
 */
export async function getEffectiveThreshold(
  estimatedProb: number,
  seriesTicker: string
): Promise<number> {
  const config = getConfig();
  const db = getDb();
  const baseThreshold = config.bot.edgeThreshold;

  const cutoff = new Date(
    Date.now() - config.calibration.calibrationWindowDays * 86400_000
  ).toISOString();

  // Get recent calibration data for this series
  const records = await db
    .select()
    .from(calibration)
    .where(
      and(
        eq(calibration.seriesTicker, seriesTicker),
        gte(calibration.resolvedAt, cutoff)
      )
    );

  if (records.length < 10) {
    // Not enough data — use base threshold
    return baseThreshold;
  }

  const bucket = getBucket(estimatedProb);
  const inBucket = records.filter(
    (r) => r.predictedProb >= bucket.low && r.predictedProb < bucket.high
  );

  if (inBucket.length < 5) {
    return baseThreshold;
  }

  // Compute calibration error for this bucket
  const hitRate =
    inBucket.filter((r) => r.actualOutcome === 1).length / inBucket.length;
  const expectedRate = (bucket.low + bucket.high) / 2;
  const calibrationError = Math.abs(hitRate - expectedRate);

  let effectiveThreshold: number;
  if (calibrationError > config.calibration.maxCalibrationError) {
    // Miscalibrated — require more edge
    effectiveThreshold = baseThreshold * (1 + calibrationError);
    log.info(
      `Bucket ${bucket.label} for ${seriesTicker}: miscalibrated (error=${calibrationError.toFixed(3)}), ` +
      `threshold: ${baseThreshold} → ${effectiveThreshold.toFixed(3)}`
    );
  } else {
    // Well-calibrated — allow slightly tighter edge
    effectiveThreshold = baseThreshold * 0.9;
  }

  return effectiveThreshold;
}
