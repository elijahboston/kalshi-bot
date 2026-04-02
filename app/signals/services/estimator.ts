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
   * For precip/snow markets: uses empirical CDF (direct counting) since
   * precipitation distributions are zero-inflated and skewed, not Gaussian.
   */
  async estimate(
    market: Market,
    ensembleValues: number[]
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
      // YES = temp > threshold
      membersInBracket = correctedValues.filter((v) => v > market.bracketLow!).length;
    } else if (market.marketType === "lower_tail") {
      // YES = temp < threshold
      membersInBracket = correctedValues.filter((v) => v < market.bracketLow!).length;
    } else {
      // Standard bracket: bracketLow <= temp < bracketHigh
      membersInBracket = correctedValues.filter(
        (v) => v >= market.bracketLow! && v < market.bracketHigh!
      ).length;
    }

    const rawMean = mean(ensembleValues);
    const rawStd = std(ensembleValues);
    const corrMean = mean(correctedValues);
    const corrStd = std(correctedValues);

    const countingProb = membersInBracket / correctedValues.length;

    // CDF-fitted probability: use normal CDF for temperature, empirical for precip/snow
    let cdfProb: number;
    if (isPrecipCategory) {
      // Precip/snow: empirical CDF only — normal distribution is wrong for
      // zero-inflated, right-skewed precipitation data
      cdfProb = countingProb;
    } else if (corrStd === 0) {
      // Zero spread — CDF is undefined, fall back to counting
      cdfProb = countingProb;
    } else if (market.marketType === "upper_tail") {
      // P(temp > threshold) = 1 - CDF(threshold)
      cdfProb = 1 - normalCdf(market.bracketLow!, corrMean, corrStd);
    } else if (market.marketType === "lower_tail") {
      // P(temp < threshold) = CDF(threshold)
      cdfProb = normalCdf(market.bracketLow!, corrMean, corrStd);
    } else {
      cdfProb =
        normalCdf(market.bracketHigh!, corrMean, corrStd) -
        normalCdf(market.bracketLow!, corrMean, corrStd);
    }

    // Blend counting and CDF based on ensemble size
    // For precip/snow, always use counting (cdfProb === countingProb)
    const countingWeight = isPrecipCategory
      ? 1.0
      : Math.min(1, correctedValues.length / 200);
    const probability = countingWeight * countingProb + (1 - countingWeight) * cdfProb;

    // Step 4: Compute confidence
    // Higher confidence when: more ensemble members, smaller spread, more bias data
    // For precip/snow, use relative spread (CoV) since absolute spread in inches is small

    const spreadNorm = isPrecipCategory
      ? (corrMean > 0 ? corrStd / corrMean : corrStd) // Coefficient of variation
      : corrStd;
    const spreadDivisor = isPrecipCategory ? 2 : 10;
    const spreadFactor = Math.max(0, 1 - spreadNorm / spreadDivisor);
    const biasFactor = biasCorrection
      ? Math.min(1, biasCorrection.sampleSize / 30) // More data → more confident
      : 0.5;
    const ensembleFactor = Math.min(1, ensembleValues.length / 120);

    const confidence = (spreadFactor * 0.4 + biasFactor * 0.4 + ensembleFactor * 0.2);

    const reasoning: ReasoningTrace = {
      stationId: market.stationId,
      targetDate: market.targetDate || "unknown",
      forecastHorizon,
      bracketLow: market.bracketLow,
      bracketHigh: market.bracketHigh ?? market.bracketLow!, // Tails use threshold as both
      rawEnsembleStats: { mean: rawMean, std: rawStd, count: ensembleValues.length },
      biasCorrection: biasCorrection
        ? { meanBias: biasCorrection.meanBias, sampleSize: biasCorrection.sampleSize }
        : null,
      correctedEnsembleStats: { mean: corrMean, std: corrStd },
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
      `conf=${confidence.toFixed(2)}, ${membersInBracket}/${correctedValues.length} members in bracket`
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
