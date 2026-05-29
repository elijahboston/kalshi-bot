import { getDb, calibration, adaptiveThresholds, and, eq, gte } from "@kcb/db";
import { getConfig } from "@kcb/config";
import { createLogger } from "@kcb/engine";
import { now } from "@kcb/shared";

const log = createLogger("adaptive-threshold");

/** Cache last-logged threshold per bucket+series to avoid repeat log spam */
const lastLogged = new Map<string, number>();

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
    const cacheKey = `${seriesTicker}:${bucket.label}`;
    const prev = lastLogged.get(cacheKey);
    if (prev !== effectiveThreshold) {
      lastLogged.set(cacheKey, effectiveThreshold);
      log.info(
        `Bucket ${bucket.label} for ${seriesTicker}: miscalibrated (error=${calibrationError.toFixed(3)}), ` +
        `threshold: ${baseThreshold} → ${effectiveThreshold.toFixed(3)}`
      );
    }
  } else {
    // Well-calibrated — allow slightly tighter edge
    effectiveThreshold = baseThreshold * 0.9;
  }

  return effectiveThreshold;
}

/**
 * Compute the adaptive threshold for a given series + bucket from calibration
 * data. Pure function — same logic as the gated portion of getEffectiveThreshold,
 * but factored out so persistAdaptiveThresholds can reuse it without a hot-path
 * DB round-trip per signal.
 *
 * Returns null when the bucket has insufficient data to compute a threshold.
 */
export function computeBucketThreshold(
  inBucketActuals: number[],
  bucketMid: number,
  baseThreshold: number,
  maxCalibrationError: number
): { threshold: number; calibrationError: number; sampleSize: number } | null {
  if (inBucketActuals.length < 5) return null;

  const hitRate =
    inBucketActuals.filter((a) => a === 1).length / inBucketActuals.length;
  const calibrationError = Math.abs(hitRate - bucketMid);

  const threshold =
    calibrationError > maxCalibrationError
      ? baseThreshold * (1 + calibrationError)
      : baseThreshold * 0.9;

  return { threshold, calibrationError, sampleSize: inBucketActuals.length };
}

/**
 * Recompute and upsert every (series, bucket) row in `adaptive_thresholds` from
 * the current `calibration` table. Pure observability — the runtime decision
 * loop still uses on-the-fly `getEffectiveThreshold`. Without this writer, the
 * `adaptive_thresholds` table sits empty and the UI/CLI cannot see what bar
 * any given signal had to clear, only the combined value persisted to
 * `signals.edge_threshold`.
 *
 * Called once per reconciliation cycle. Safe to call frequently — single
 * SELECT + small number of UPSERTs.
 *
 * Returns the number of rows written/updated, for logging.
 */
export async function persistAdaptiveThresholds(): Promise<number> {
  const config = getConfig();
  const db = getDb();
  const baseThreshold = config.bot.edgeThreshold;
  const maxCalErr = config.calibration.maxCalibrationError;
  const cutoff = new Date(
    Date.now() - config.calibration.calibrationWindowDays * 86400_000
  ).toISOString();

  const records = await db
    .select({
      seriesTicker: calibration.seriesTicker,
      predictedProb: calibration.predictedProb,
      actualOutcome: calibration.actualOutcome,
    })
    .from(calibration)
    .where(gte(calibration.resolvedAt, cutoff));

  if (records.length === 0) return 0;

  const bySeries = new Map<string, typeof records>();
  for (const r of records) {
    const existing = bySeries.get(r.seriesTicker) ?? [];
    existing.push(r);
    bySeries.set(r.seriesTicker, existing);
  }
  // Also compute a global aggregate row per bucket.
  bySeries.set("__global__", records);

  const timestamp = now();
  let written = 0;

  for (const [seriesTicker, seriesRecords] of bySeries) {
    if (seriesRecords.length < 5) continue;

    for (const bucket of BUCKETS) {
      const inBucket = seriesRecords.filter(
        (r) => r.predictedProb >= bucket.low && r.predictedProb < bucket.high
      );
      const computed = computeBucketThreshold(
        inBucket.map((r) => r.actualOutcome),
        (bucket.low + bucket.high) / 2,
        baseThreshold,
        maxCalErr
      );
      if (computed == null) continue;

      const id = `${seriesTicker}_${bucket.label}`;
      await db
        .insert(adaptiveThresholds)
        .values({
          id,
          seriesTicker,
          bucketLabel: bucket.label,
          edgeThreshold: computed.threshold,
          calibrationError: computed.calibrationError,
          sampleSize: computed.sampleSize,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: adaptiveThresholds.id,
          set: {
            edgeThreshold: computed.threshold,
            calibrationError: computed.calibrationError,
            sampleSize: computed.sampleSize,
            updatedAt: timestamp,
          },
        });
      written++;
    }
  }

  log.debug(`Persisted ${written} adaptive_threshold row(s)`);
  return written;
}
