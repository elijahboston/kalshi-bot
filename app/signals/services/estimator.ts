import { getDb, stationBias, calibration, eq, and, gte } from "@kcb/db";
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
  /** Sigma used for CDF: empirical (from station_bias) or ensemble spread */
  sigmaSource: "empirical" | "ensemble";
  /** The sigma value used for CDF computation */
  sigmaUsed: number;
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

    const forecastHorizon = market.targetDate
      ? Math.ceil(
          (new Date(market.targetDate).getTime() - Date.now()) / 86400_000
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
    // Prefer empirical sigma (std of historical forecast errors) over ensemble spread.
    // Empirical sigma is typically 1.0-1.5F for day-1 temps vs 2.6F ensemble spread.
    let sigmaSource: "empirical" | "ensemble" = "ensemble";
    let sigmaUsed = corrStd;
    let obsAdj: ReasoningTrace["observationAdjustment"] = null;

    if (!isPrecipCategory && biasCorrection && biasCorrection.sampleSize >= 10) {
      // Use stdBias as empirical sigma — this is the std of (forecast - actual),
      // which represents true forecast error, not model disagreement
      const empiricalSigma = (biasCorrection as any).stdBias as number | undefined;
      if (empiricalSigma != null && empiricalSigma > 0) {
        sigmaUsed = empiricalSigma;
        sigmaSource = "empirical";
        log.debug(
          `${market.ticker}: using empirical sigma=${empiricalSigma.toFixed(2)}F ` +
          `(vs ensemble spread=${corrStd.toFixed(2)}F, n=${biasCorrection.sampleSize})`
        );
      }
    }

    // Step 3.6: Apply same-day observation adjustment (high_temp only)
    if (observation && market.category === "high_temp" && forecastHorizon <= 1) {
      const sigmaBefore = sigmaUsed;
      const divergence = Math.abs(observation.observedTemp - corrMean);

      if (divergence <= 3) {
        // Observation confirms forecast — tighten sigma by 50%
        sigmaUsed = sigmaUsed * 0.5;
      } else {
        // Observation diverges — shift mean toward observation-based estimate
        // Use regression: adjustedMean = 0.7 * forecastMean + 0.3 * observationBasedHigh
        // For morning obs, afternoon high ≈ observedTemp + typical diurnal range offset
        const diurnalOffset = 10; // rough F offset from morning to afternoon high
        const obsBased = observation.observedTemp + diurnalOffset;
        corrMean = 0.7 * corrMean + 0.3 * obsBased;
        sigmaUsed = sigmaUsed * 0.7; // still tighten somewhat
      }

      obsAdj = {
        observedTemp: observation.observedTemp,
        sigmaBefore,
        sigmaAfter: sigmaUsed,
        meanShift: corrMean - mean(correctedValues),
      };

      log.debug(
        `${market.ticker}: obs adjustment: observed=${observation.observedTemp.toFixed(1)}F, ` +
        `sigma ${sigmaBefore.toFixed(2)} → ${sigmaUsed.toFixed(2)}, mean shift=${obsAdj.meanShift.toFixed(2)}`
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

    // Blend counting and CDF based on ensemble size
    const countingWeight = isPrecipCategory
      ? 1.0
      : Math.min(1, correctedValues.length / 200);
    const probability = countingWeight * countingProb + (1 - countingWeight) * cdfProb;

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
      observationAdjustment: obsAdj,
      membersInBracket,
      cdfProbability: cdfProb,
      countingProbability: countingProb,
      historicalHitRate: await this.getHistoricalHitRate(
        market.stationId,
        market.category,
        market.bracketLow,
        market.bracketHigh
      ),
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
   * Compute historical hit rate from resolved calibration records
   * for the same station, category, and bracket range.
   * Returns null if fewer than 5 data points are available.
   */
  async getHistoricalHitRate(
    stationId: string,
    category: string,
    bracketLow: number,
    bracketHigh: number
  ): Promise<number | null> {
    const config = getConfig();
    const db = getDb();
    const cutoff = new Date(
      Date.now() - config.calibration.calibrationWindowDays * 86400_000
    ).toISOString();

    const rows = await db
      .select({
        actualOutcome: calibration.actualOutcome,
      })
      .from(calibration)
      .where(
        and(
          eq(calibration.stationId, stationId),
          eq(calibration.category, category),
          gte(calibration.resolvedAt, cutoff)
        )
      );

    if (rows.length < 5) return null;

    const hits = rows.filter((r) => r.actualOutcome === 1).length;
    return hits / rows.length;
  }
}

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
