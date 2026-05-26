import { getDb, stationBias, calibration, markets, eq, and, gte, sql } from "@kcb/db";
import { getConfig } from "@kcb/config";
import { createLogger } from "@kcb/engine";
import type { Market } from "@kcb/db";

const log = createLogger("estimator");

export interface EstimateResult {
  /** Estimated probability of YES (0-1) */
  probability: number;
  /** Confidence in the estimate (0-1), based on ensemble spread and bias data quality */
  confidence: number;
  /** Number of ensemble members used */
  ensembleSize: number;
  /** Reasoning trace for the `explain` command */
  reasoning: ReasoningTrace;
}

export interface ObservationAdjustment {
  /** Latest observed temperature in F */
  observedTemp: number;
  /** Timestamp of observation */
  observedAt: string;
}

export interface ReasoningTrace {
  stationId: string;
  targetDate: string;
  forecastHorizon: number;
  bracketLow: number;
  bracketHigh: number;
  /** Raw ensemble values before bias correction */
  rawEnsembleStats: { mean: number; std: number; count: number };
  /** Applied bias correction */
  biasCorrection: { meanBias: number; sampleSize: number } | null;
  /** Corrected ensemble stats */
  correctedEnsembleStats: { mean: number; std: number };
  /** Sigma source label: "empirical" when blend weight >= 0.5, otherwise "ensemble" */
  sigmaSource: "empirical" | "ensemble";
  /** The sigma value used for CDF computation (sample-size-weighted blend of empirical + ensemble) */
  sigmaUsed: number;
  /** Empirical-sigma weight in the blend (n/50, capped at 1). null when no bias data. */
  empiricalSigmaWeight: number | null;
  /** Same-day observation adjustment applied */
  observationAdjustment: { observedTemp: number; sigmaBefore: number; sigmaAfter: number; meanShift: number } | null;
  /** How many members fall in the bracket */
  membersInBracket: number;
  /** CDF-fitted probability for the bracket */
  cdfProbability: number;
  /** Raw counting probability (kept for comparison) */
  countingProbability: number;
  /** Historical verification rate for this bracket */
  historicalHitRate: number | null;
  /** Historical-prior blend applied (null when weight=0 or hit rate unavailable) */
  historicalPriorBlend: { weight: number; rawProbability: number; blendedProbability: number } | null;
}

export class ProbabilityEstimator {
  /**
   * Estimate the probability that a market resolves YES.
   *
   * For temperature markets: uses normal CDF fitted to ensemble distribution.
   * Uses empirical sigma (std of historical forecast errors) when available,
   * falling back to ensemble spread when sample size < 10.
   *
   * For precip/snow markets: uses empirical CDF (direct counting) since
   * precipitation distributions are zero-inflated and skewed, not Gaussian.
   *
   * @param observation Optional same-day observation to tighten sigma
   */
  async estimate(
    market: Market,
    ensembleValues: number[],
    observation?: ObservationAdjustment
  ): Promise<EstimateResult> {
    const isTail = market.marketType === "upper_tail" || market.marketType === "lower_tail";
    if (!market.stationId || market.bracketLow == null || (!isTail && market.bracketHigh == null)) {
      throw new Error(`Market ${market.ticker} missing station/bracket data`);
    }

    // Same-day markets resolve at midnight-UTC of target_date, so this can be
    // <= 0 once we cross that boundary. station_bias rows are stored with
    // Math.max(1, ...) (see reconciliation.recomputeStationBias), so floor at
    // 1 to keep estimator lookup and stored data on the same horizon. Without
    // this floor, same-day estimates silently lose bias correction.
    const forecastHorizon = market.targetDate
      ? Math.max(
          1,
          Math.ceil(
            (new Date(market.targetDate).getTime() - Date.now()) / 86400_000
          )
        )
      : 1;

    const isPrecipCategory = market.category === "precip" || market.category === "snowfall";

    // Step 1: Get bias correction for this station + horizon + category
    const biasCorrection = await this.getBiasCorrection(
      market.stationId,
      forecastHorizon,
      market.category
    );

    // Step 2: Apply bias correction and clamp precip/snow at zero
    let correctedValues = biasCorrection
      ? ensembleValues.map((v) => v - biasCorrection.meanBias)
      : [...ensembleValues];

    if (isPrecipCategory) {
      correctedValues = correctedValues.map((v) => Math.max(0, v));
    }

    // Step 3: Count members matching this market's condition
    let membersInBracket: number;
    if (market.marketType === "upper_tail") {
      membersInBracket = correctedValues.filter((v) => v > market.bracketLow!).length;
    } else if (market.marketType === "lower_tail") {
      membersInBracket = correctedValues.filter((v) => v < market.bracketLow!).length;
    } else {
      membersInBracket = correctedValues.filter(
        (v) => v >= market.bracketLow! && v < market.bracketHigh!
      ).length;
    }

    const rawMean = mean(ensembleValues);
    const rawStd = std(ensembleValues);
    let corrMean = mean(correctedValues);
    const corrStd = std(correctedValues);

    const countingProb = membersInBracket / correctedValues.length;

    // Step 3.5: Determine sigma for CDF computation
    // Blend empirical sigma (std of historical forecast errors) with ensemble spread,
    // weighted by sample size. Pure-empirical at n>=50, pure-ensemble at n=0. The
    // residuals fit on a small bias-correction window are systematically tighter
    // than out-of-sample errors (overfit to the same data the bias was estimated on),
    // so weighting toward ensemble at small n widens sigma where the empirical
    // estimate is least trustworthy.
    let sigmaSource: "empirical" | "ensemble" = "ensemble";
    let sigmaUsed = corrStd;
    let empiricalSigmaWeight: number | null = null;
    let obsAdj: ReasoningTrace["observationAdjustment"] = null;

    if (!isPrecipCategory && biasCorrection && biasCorrection.sampleSize > 0) {
      const empiricalSigma = (biasCorrection as any).stdBias as number | undefined;
      if (empiricalSigma != null && empiricalSigma > 0) {
        const w = Math.min(1, biasCorrection.sampleSize / 50);
        sigmaUsed = w * empiricalSigma + (1 - w) * corrStd;
        sigmaSource = w >= 0.5 ? "empirical" : "ensemble";
        empiricalSigmaWeight = w;
        log.debug(
          `${market.ticker}: blended sigma=${sigmaUsed.toFixed(2)}F ` +
          `(empirical=${empiricalSigma.toFixed(2)}F w=${w.toFixed(2)}, ` +
          `ensemble=${corrStd.toFixed(2)}F, n=${biasCorrection.sampleSize})`
        );
      }
    }

    // Step 3.6: Apply same-day observation adjustment (high_temp only).
    // We project the observation to an "implied afternoon high" using a
    // time-of-day diurnal offset (morning obs imply a higher peak; afternoon
    // obs imply near-peak). Only then do we compare with the forecast mean.
    if (observation && market.category === "high_temp" && forecastHorizon <= 1) {
      const sigmaBefore = sigmaUsed;

      const obsHour = localHourAtStation(observation.observedAt, market.stationId);
      const diurnalOffset = estimateDiurnalOffset(obsHour);
      const impliedHigh = observation.observedTemp + diurnalOffset;
      const divergence = Math.abs(impliedHigh - corrMean);

      if (divergence <= 2) {
        // Obs-implied high agrees with forecast — tighten sigma, but not as hard
        // as before (we are one observation against a 150-member ensemble).
        sigmaUsed = sigmaUsed * 0.7;
      } else {
        // Obs-implied high disagrees — blend forecast mean toward it and tighten mildly.
        corrMean = 0.7 * corrMean + 0.3 * impliedHigh;
        sigmaUsed = sigmaUsed * 0.85;
      }

      obsAdj = {
        observedTemp: observation.observedTemp,
        sigmaBefore,
        sigmaAfter: sigmaUsed,
        meanShift: corrMean - mean(correctedValues),
      };

      log.debug(
        `${market.ticker}: obs adjustment: observed=${observation.observedTemp.toFixed(1)}F @ ${obsHour}h local, ` +
        `implied high=${impliedHigh.toFixed(1)}F, sigma ${sigmaBefore.toFixed(2)} → ${sigmaUsed.toFixed(2)}, ` +
        `mean shift=${obsAdj.meanShift.toFixed(2)}`
      );
    }

    // CDF-fitted probability: use normal CDF for temperature, empirical for precip/snow
    let cdfProb: number;
    if (isPrecipCategory) {
      cdfProb = countingProb;
    } else if (sigmaUsed === 0) {
      cdfProb = countingProb;
    } else if (market.marketType === "upper_tail") {
      cdfProb = 1 - normalCdf(market.bracketLow!, corrMean, sigmaUsed);
    } else if (market.marketType === "lower_tail") {
      cdfProb = normalCdf(market.bracketLow!, corrMean, sigmaUsed);
    } else {
      cdfProb =
        normalCdf(market.bracketHigh!, corrMean, sigmaUsed) -
        normalCdf(market.bracketLow!, corrMean, sigmaUsed);
    }

    // Blend CDF and counting, weighted by ensemble size. With many members
    // (>=100), the sigma estimate is reliable and the normal-CDF integral over
    // a tight bracket is much smoother than the raw count of members landing
    // inside that bracket. With few members, sigma is shaky so we lean on
    // counting instead. Previously the weighting was inverted (counting
    // dominated at large ensembles), which crushed CDF's correct ~30-40%
    // estimates on tight near-mean brackets down to counting's noisy 5-10%.
    const cdfWeight = isPrecipCategory
      ? 0
      : Math.min(1, correctedValues.length / 200);
    const rawProbability = cdfWeight * cdfProb + (1 - cdfWeight) * countingProb;

    // Historical-prior blend. When the estimator's ensemble+CDF view conflicts
    // with observed historical hit rates for the same station/category/bracket,
    // pull toward the historical rate. Gated by config.bot.historicalPriorWeight
    // (0 = disabled). Addresses documented systemic over-confidence in NO.
    const historicalHitRate = await this.getHistoricalHitRate(
      market.stationId,
      market.category,
      market.bracketLow,
      market.bracketHigh
    );
    const priorWeight = getConfig().bot.historicalPriorWeight;
    let blendedProbability = rawProbability;
    let historicalPriorBlend: ReasoningTrace["historicalPriorBlend"] = null;
    if (priorWeight > 0 && historicalHitRate != null) {
      const clampedWeight = Math.min(1, Math.max(0, priorWeight));
      blendedProbability = (1 - clampedWeight) * rawProbability + clampedWeight * historicalHitRate;
      historicalPriorBlend = {
        weight: clampedWeight,
        rawProbability,
        blendedProbability,
      };
    }

    // Tail-probability floor. Without empirical bias data we can't trust narrow
    // sigma values, so clamp the returned probability away from 0/1. The raw
    // cdfProb/countingProb in the reasoning trace are untouched for debugging.
    const hasEmpirical = biasCorrection != null && biasCorrection.sampleSize >= 10;
    const floor = isPrecipCategory ? 0 : hasEmpirical ? 0.01 : 0.03;
    const probability = isPrecipCategory
      ? blendedProbability
      : Math.min(1 - floor, Math.max(floor, blendedProbability));

    // Step 4: Compute confidence
    const spreadNorm = isPrecipCategory
      ? (corrMean > 0 ? corrStd / corrMean : corrStd)
      : sigmaUsed; // Use sigmaUsed (may be empirical) for confidence
    const spreadDivisor = isPrecipCategory ? 2 : 10;
    const spreadFactor = Math.max(0, 1 - spreadNorm / spreadDivisor);
    const biasFactor = biasCorrection
      ? Math.min(1, biasCorrection.sampleSize / 30)
      : 0.5;
    const ensembleFactor = Math.min(1, ensembleValues.length / 120);

    const confidence = (spreadFactor * 0.4 + biasFactor * 0.4 + ensembleFactor * 0.2);

    const reasoning: ReasoningTrace = {
      stationId: market.stationId,
      targetDate: market.targetDate || "unknown",
      forecastHorizon,
      bracketLow: market.bracketLow,
      bracketHigh: market.bracketHigh ?? market.bracketLow!,
      rawEnsembleStats: { mean: rawMean, std: rawStd, count: ensembleValues.length },
      biasCorrection: biasCorrection
        ? { meanBias: biasCorrection.meanBias, sampleSize: biasCorrection.sampleSize }
        : null,
      correctedEnsembleStats: { mean: corrMean, std: corrStd },
      sigmaSource,
      sigmaUsed,
      empiricalSigmaWeight,
      observationAdjustment: obsAdj,
      membersInBracket,
      cdfProbability: cdfProb,
      countingProbability: countingProb,
      historicalHitRate,
      historicalPriorBlend,
    };

    log.debug(
      `${market.ticker}: P=${probability.toFixed(3)} (counting=${countingProb.toFixed(3)}, cdf=${cdfProb.toFixed(3)}), ` +
      `conf=${confidence.toFixed(2)}, sigma=${sigmaUsed.toFixed(2)} (${sigmaSource}), ` +
      `${membersInBracket}/${correctedValues.length} members in bracket`
    );

    return { probability, confidence, ensembleSize: ensembleValues.length, reasoning };
  }

  private async getBiasCorrection(stationId: string, horizon: number, category: string) {
    const db = getDb();
    // Try category-specific bias first
    const [bias] = await db
      .select()
      .from(stationBias)
      .where(
        and(
          eq(stationBias.stationId, stationId),
          eq(stationBias.category, category),
          eq(stationBias.forecastHorizonDays, Math.min(horizon, 7))
        )
      )
      .limit(1);

    if (bias) return bias;

    // Fall back to legacy rows (pre-category migration, default = "high_temp")
    if (category !== "high_temp") return null;

    const [legacy] = await db
      .select()
      .from(stationBias)
      .where(
        and(
          eq(stationBias.stationId, stationId),
          eq(stationBias.category, "high_temp"),
          eq(stationBias.forecastHorizonDays, Math.min(horizon, 7))
        )
      )
      .limit(1);

    return legacy || null;
  }

  /**
   * Compute historical hit rate from resolved calibration records for the same
   * station, category, and *similar bracket position*. Joins with the markets
   * table to filter by bracket center proximity (±BRACKET_HIST_TOLERANCE °F).
   * Tail markets are filtered separately by threshold proximity.
   *
   * Returns null if fewer than 5 matching data points are available.
   *
   * Why this filter exists: without it, the function pooled YES rates across
   * every bracket at a station — including the long tail of far-from-mean
   * brackets that almost never hit YES — yielding ~17% baseline across the
   * board. That stale baseline then dragged the historical-prior blend toward
   * NO regardless of the bracket actually being priced.
   */
  async getHistoricalHitRate(
    stationId: string,
    category: string,
    bracketLow: number,
    bracketHigh: number | null
  ): Promise<number | null> {
    const config = getConfig();
    const db = getDb();
    const cutoff = new Date(
      Date.now() - config.calibration.calibrationWindowDays * 86400_000
    ).toISOString();

    const isTail = bracketHigh == null;
    const queryCenter = isTail ? bracketLow : (bracketLow + bracketHigh) / 2;
    const tolerance = BRACKET_HIST_TOLERANCE_F;

    const proximityClause = isTail
      ? sql`${markets.bracketHigh} IS NULL AND ABS(${markets.bracketLow} - ${queryCenter}) <= ${tolerance}`
      : sql`${markets.bracketHigh} IS NOT NULL AND ABS((${markets.bracketLow} + ${markets.bracketHigh}) / 2.0 - ${queryCenter}) <= ${tolerance}`;

    const rows = await db
      .select({
        actualOutcome: calibration.actualOutcome,
      })
      .from(calibration)
      .innerJoin(markets, eq(calibration.ticker, markets.ticker))
      .where(
        and(
          eq(calibration.stationId, stationId),
          eq(calibration.category, category),
          gte(calibration.resolvedAt, cutoff),
          proximityClause
        )
      );

    if (rows.length < 5) return null;

    const hits = rows.filter((r) => r.actualOutcome === 1).length;
    return hits / rows.length;
  }
}

/** Window (°F) for matching "similar" brackets in getHistoricalHitRate. ±3°F
 * captures ~5–6 adjacent 1°F brackets per station — enough sample size while
 * keeping the population climatologically relevant to the query bracket. */
const BRACKET_HIST_TOLERANCE_F = 3;

// ── Helpers ────────────────────────────────────────────────

export function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function std(values: number[]): number {
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Abramowitz & Stegun approximation of the error function (max error ~1.5e-7) */
export function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const a = Math.abs(x);

  const t = 1 / (1 + 0.3275911 * a);
  const poly =
    t * (0.254829592 +
    t * (-0.284496736 +
    t * (1.421413741 +
    t * (-1.453152027 +
    t * 1.061405429))));

  return sign * (1 - poly * Math.exp(-a * a));
}

/** CDF of the normal distribution */
export function normalCdf(x: number, mu: number, sigma: number): number {
  return 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
}

/** IANA timezone per enabled station. Expand as we enable more stations. */
const STATION_TZ: Record<string, string> = {
  KNYC: "America/New_York",
  KMIA: "America/New_York",
  KORD: "America/Chicago",
  KAUS: "America/Chicago",
  KDEN: "America/Denver",
  KLAX: "America/Los_Angeles",
};

/** Extract the local hour-of-day (0–23) at the given station from an ISO timestamp. */
export function localHourAtStation(iso: string, stationId: string | null): number {
  const tz = (stationId && STATION_TZ[stationId]) || "America/New_York";
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(iso));
  const hourPart = parts.find((p) => p.type === "hour");
  return hourPart ? Number(hourPart.value) : 12;
}

/**
 * Estimate the offset between an observation at `localHour` and the day's afternoon
 * high, in °F. Peak heating is ~3pm local (offset ≈ 0); predawn (~5am) is typically
 * ~10°F below the afternoon high. Piecewise linear between keypoints — a rough
 * climatological approximation, intentionally bounded.
 */
export function estimateDiurnalOffset(localHour: number): number {
  const keypoints: Array<[number, number]> = [
    [0, 8], [3, 10], [6, 10], [9, 7], [12, 3], [15, 0], [18, 2], [21, 5], [24, 8],
  ];
  const h = Math.max(0, Math.min(24, localHour));
  for (let i = 0; i < keypoints.length - 1; i++) {
    const [h1, o1] = keypoints[i]!;
    const [h2, o2] = keypoints[i + 1]!;
    if (h >= h1 && h <= h2) {
      const t = (h - h1) / (h2 - h1);
      return o1 + t * (o2 - o1);
    }
  }
  return 8;
}
