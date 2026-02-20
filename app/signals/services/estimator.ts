import { getDb, stationBias, eq, and } from "@kcb/db";
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
  /** Historical verification rate for this bracket */
  historicalHitRate: number | null;
}

export class ProbabilityEstimator {
  /**
   * Estimate the probability that a market resolves YES.
   *
   * For temperature markets: uses ensemble forecast distribution
   * with station-specific bias correction.
   */
  async estimate(
    market: Market,
    ensembleValues: number[]
  ): Promise<EstimateResult> {
    if (!market.stationId || market.bracketLow == null || market.bracketHigh == null) {
      throw new Error(`Market ${market.ticker} missing station/bracket data`);
    }

    const forecastHorizon = market.targetDate
      ? Math.ceil(
          (new Date(market.targetDate).getTime() - Date.now()) / 86400_000
        )
      : 1;

    // Step 1: Get bias correction for this station + horizon
    const biasCorrection = await this.getBiasCorrection(
      market.stationId,
      forecastHorizon
    );

    // Step 2: Apply bias correction to ensemble
    const correctedValues = biasCorrection
      ? ensembleValues.map((v) => v - biasCorrection.meanBias)
      : ensembleValues;

    // Step 3: Count members in bracket
    const membersInBracket = correctedValues.filter(
      (v) => v >= market.bracketLow! && v < market.bracketHigh!
    ).length;

    const probability = membersInBracket / correctedValues.length;

    // Step 4: Compute confidence
    // Higher confidence when: more ensemble members, smaller spread, more bias data
    const rawMean = mean(ensembleValues);
    const rawStd = std(ensembleValues);
    const corrMean = mean(correctedValues);
    const corrStd = std(correctedValues);

    const spreadFactor = Math.max(0, 1 - corrStd / 10); // Tighter spread → more confident
    const biasFactor = biasCorrection
      ? Math.min(1, biasCorrection.sampleSize / 30) // More data → more confident
      : 0.5;
    const ensembleFactor = Math.min(1, ensembleValues.length / 50);

    const confidence = (spreadFactor * 0.4 + biasFactor * 0.4 + ensembleFactor * 0.2);

    const reasoning: ReasoningTrace = {
      stationId: market.stationId,
      targetDate: market.targetDate || "unknown",
      forecastHorizon,
      bracketLow: market.bracketLow,
      bracketHigh: market.bracketHigh,
      rawEnsembleStats: { mean: rawMean, std: rawStd, count: ensembleValues.length },
      biasCorrection: biasCorrection
        ? { meanBias: biasCorrection.meanBias, sampleSize: biasCorrection.sampleSize }
        : null,
      correctedEnsembleStats: { mean: corrMean, std: corrStd },
      membersInBracket,
      historicalHitRate: null, // TODO: compute from calibration table
    };

    log.debug(
      `${market.ticker}: P=${probability.toFixed(3)}, conf=${confidence.toFixed(2)}, ` +
      `${membersInBracket}/${correctedValues.length} members in bracket`
    );

    return { probability, confidence, ensembleSize: ensembleValues.length, reasoning };
  }

  private async getBiasCorrection(stationId: string, horizon: number) {
    const db = getDb();
    const [bias] = await db
      .select()
      .from(stationBias)
      .where(
        and(
          eq(stationBias.stationId, stationId),
          eq(stationBias.forecastHorizonDays, Math.min(horizon, 7))
        )
      )
      .limit(1);

    return bias || null;
  }
}

// ── Helpers ────────────────────────────────────────────────

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
