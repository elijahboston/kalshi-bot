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
  /** Latest observed temperature in F (existing semantics — newest reading). */
  observedTemp: number;
  /** Timestamp of the latest observation. */
  observedAt: string;
  /**
   * Max of today's local-calendar-day observations (°F) — a HARD FLOOR on the
   * daily high (addendum N3). When present + fresh, the estimator clamps its
   * distribution at this value (mass below it folds onto the point runningMax).
   * Optional for back-compat with callers that only have a single reading.
   */
  runningMax?: number;
  /**
   * Minutes since the latest observation, measured against the orchestrator's
   * clock (addendum N3). Drives the staleness guard: obs older than
   * `obsMaxAgeMinutes` are ignored entirely (no mean shift, no collapse, no
   * clamp). Optional/back-compat: when absent, the obs is treated as fresh.
   */
  latestAgeMinutes?: number;
  /** Number of usable (non-null temp) observations backing the window (N3). */
  obsCount?: number;
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
  /** Sigma floor that clipped the blend (plan #4), or null when it didn't bind. */
  sigmaFloorApplied?: number | null;
  /**
   * Same-day observation adjustment applied. The base fields
   * (`observedTemp`/`sigmaBefore`/`sigmaAfter`/`meanShift`) keep their existing
   * semantics; addendum N3 adds:
   * - `runningMax` — the day's observed running max (the clamp floor), or null
   *   when the obs carried no running max;
   * - `postPeakCollapse` — true when the post-peak branch fired (local hour ≥
   *   `obsPeakHour`, fresh obs, runningMax present): mean set to
   *   `runningMax + obsPostPeakMeanOffset`, sigma to `obsPostPeakSigma` (which
   *   may legitimately sit below the sigma floor — real same-day information);
   * - `latestAgeMinutes` — staleness of the latest reading at decision time.
   */
  observationAdjustment: {
    observedTemp: number;
    sigmaBefore: number;
    sigmaAfter: number;
    meanShift: number;
    runningMax: number | null;
    postPeakCollapse: boolean;
    latestAgeMinutes: number | null;
  } | null;
  /**
   * True when a same-day observation was supplied but ignored because it was
   * staler than `obsMaxAgeMinutes` (addendum N3). `observationAdjustment` is
   * null in that case (no mean shift / collapse / clamp); this flag makes the
   * orchestrator's "obs stale in sniper window" skip decision auditable from the
   * trace. false/absent when no obs was supplied or the obs was fresh.
   */
  obsStale?: boolean;
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
  /**
   * Market-prior blend applied (null when weight=0 or marketPrice not provided).
   * `weight` is the *effective* applied weight after the disagreement ramp;
   * `baseWeight` is the flat floor (config.bot.marketPriorWeight); `disagreement`
   * is |pModel − marketPrice| measured immediately before this blend.
   */
  marketPriorBlend: {
    weight: number;
    baseWeight: number;
    disagreement: number;
    marketPrice: number;
    probabilityBefore: number;
    probabilityAfter: number;
  } | null;
  /**
   * Per-source ensemble member counts that fed this estimate, AFTER horizon
   * weighting (addendum N5 — source attribution). Passed through from
   * EnsembleService.getEnsembleWithSources so reasoning traces are queryable by
   * which models were present (e.g. HRRR-less days). Labels: hrrr/gfs/ecmwf/
   * icon/gem/arpege/tomorrow_io/other on the fresh path; `cached` when served
   * from the untagged DB cache (hrrr-unknown). null when the caller didn't
   * supply it (back-compat — most callers don't yet).
   */
  sourceMix?: Record<string, number> | null;
  /**
   * Event-coherence telemetry (addendum N2). Populated only by
   * {@link ProbabilityEstimator.estimateEvent}; null on the legacy per-market
   * path. Lets the Finding-2 incoherence query (bracket probs summing to
   * 0.79–1.69) be checked directly from a reasoning trace: `finalSum` should
   * track `rawCdfSum` (= coverage) to within the floor/clamp drift.
   */
  eventCoherence?: {
    eventTicker: string;
    /** Number of markets (brackets + tails) jointly estimated for the event. */
    markets: number;
    /** Σ of the raw per-market CDF/counting blends = coverage (≈1 when the set partitions ℝ; <1 with listing gaps). */
    rawCdfSum: number;
    /** Σ of the final returned probabilities across the event's markets. */
    finalSum: number;
    /** The TV-ramped event-level market-prior weight, or null when the blend is off. */
    eventBlendWeight: number | null;
  } | null;
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
   * @param marketPrice Optional market-implied P(YES) in [0, 1] used as a final-stage Bayesian prior (gated by config.bot.marketPriorWeight)
   * @param sourceMix Optional per-source ensemble member counts (N5) from
   *   EnsembleService.getEnsembleWithSources, stored verbatim into the
   *   ReasoningTrace (null when absent). Does not affect any computation.
   */
  async estimate(
    market: Market,
    ensembleValues: number[],
    observation?: ObservationAdjustment,
    marketPrice?: number,
    sourceMix?: Record<string, number>
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

    // Members counting + countingProb are computed AFTER the observation
    // adjustment (Step 3.6) so the N3 running-max clamp can fold sub-runningMax
    // members before bucketing. The distribution stats are needed up front for
    // the sigma blend, though.
    const rawMean = mean(ensembleValues);
    const rawStd = std(ensembleValues);
    let corrMean = mean(correctedValues);
    const corrStd = std(correctedValues);
    const corrMeanBaseline = corrMean; // pre-obs mean, for the trace's meanShift

    // Step 3.5: Determine sigma for CDF computation
    // Blend empirical sigma (std of historical forecast errors) with ensemble spread,
    // weighted by sample size, capped at MAX_EMPIRICAL_SIGMA_WEIGHT. The residuals
    // fit on a small bias-correction window are systematically tighter than
    // out-of-sample errors (overfit to the same data the bias was estimated on).
    // Per 2026-05-27 validation, even at n>=50 the empirical sigma consistently
    // underestimates real forecast variability — the cap keeps 30% ensemble
    // spread permanently in the blend, preventing the CDF from collapsing to
    // overconfident point estimates on tight near-mean brackets.
    let sigmaSource: "empirical" | "ensemble" = "ensemble";
    let sigmaUsed = corrStd;
    let empiricalSigmaWeight: number | null = null;
    let obsAdj: ReasoningTrace["observationAdjustment"] = null;
    let obsStale = false;
    // N3 running-max clamp floor for the bracket/tail integrals + member
    // counting (null = no clamp: no fresh obs, stale, or non-high_temp).
    let runningMaxForClamp: number | null = null;

    if (!isPrecipCategory && biasCorrection && biasCorrection.sampleSize > 0) {
      const empiricalSigma = (biasCorrection as any).stdBias as number | undefined;
      if (empiricalSigma != null && empiricalSigma > 0) {
        const w = Math.min(MAX_EMPIRICAL_SIGMA_WEIGHT, biasCorrection.sampleSize / 50);
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

    // Step 3.55: Sigma floor (win-rate-80 plan #4). The blended sigma is fit on
    // the bias window's own residuals and can collapse below the bracket scale,
    // making the CDF mechanically overconfident when the mean sits just outside
    // a tight bracket — the "mean 1°F out → 15% YES" trap that generated the
    // contra-market NO book. Floor sigma at a fraction of the bracket width
    // (tails use width 1.0). Deliberately applied BEFORE the observation
    // adjustment: post-peak obs knowledge (addendum N3) is real same-day
    // information, not overfit, and may legitimately collapse sigma below this
    // floor. See improvements/win-rate-80-plan-2026-06-05.md §4.4.
    let sigmaFloorApplied: number | null = null;
    if (!isPrecipCategory) {
      const floorFactor = getConfig().bot.sigmaFloorBracketWidthFactor;
      const bracketWidth =
        !isTail && market.bracketHigh != null
          ? market.bracketHigh - market.bracketLow!
          : 1.0;
      const sigmaFloor = floorFactor * bracketWidth;
      if (floorFactor > 0 && sigmaUsed < sigmaFloor) {
        log.debug(
          `${market.ticker}: sigma floor ${sigmaFloor.toFixed(2)}F applied (was ${sigmaUsed.toFixed(2)}F)`
        );
        sigmaUsed = sigmaFloor;
        sigmaFloorApplied = sigmaFloor;
      }
    }

    // Step 3.6: Apply same-day observation adjustment (high_temp only, N3).
    // Shared helper: staleness guard → post-peak collapse (≥ obsPeakHour) →
    // pre-peak implied-high logic → running-max clamp floor. Identical to the
    // estimateEvent path so the vector stays coherent.
    if (observation && market.category === "high_temp" && forecastHorizon <= 1) {
      const r = applyObservationAdjustment(
        observation,
        market.stationId,
        corrMean,
        sigmaUsed,
        corrMeanBaseline
      );
      corrMean = r.corrMean;
      sigmaUsed = r.sigmaUsed;
      runningMaxForClamp = r.runningMaxForClamp;
      obsAdj = r.obsAdj;
      obsStale = r.obsStale;

      if (obsAdj) {
        log.debug(
          `${market.ticker}: obs adjustment: observed=${observation.observedTemp.toFixed(1)}F, ` +
          `runningMax=${obsAdj.runningMax == null ? "n/a" : obsAdj.runningMax.toFixed(1)}F, ` +
          `postPeak=${obsAdj.postPeakCollapse}, sigma ${obsAdj.sigmaBefore.toFixed(2)} → ${sigmaUsed.toFixed(2)}, ` +
          `mean shift=${obsAdj.meanShift.toFixed(2)}`
        );
      } else if (obsStale) {
        log.debug(
          `${market.ticker}: obs ignored — stale ${observation.latestAgeMinutes?.toFixed(0)}m > ${getConfig().bot.obsMaxAgeMinutes}m`
        );
      }
    }

    // Step 3: Count members matching this market's condition. N3 clamps each
    // member to max(member, runningMax) before bucketing (consistent with the
    // clamped CDF) when a fresh running max is present.
    const membersInBracket = countMembersInMarket(market, correctedValues, runningMaxForClamp);
    const countingProb = membersInBracket / correctedValues.length;

    // CDF-fitted probability: use normal CDF for temperature, empirical for precip/snow
    const cdfProb = cdfProbForMarket(
      market,
      corrMean,
      sigmaUsed,
      countingProb,
      isPrecipCategory,
      runningMaxForClamp
    );

    // Blend CDF and counting, weighted by ensemble size. With many members
    // (>=100), the sigma estimate is reliable and the normal-CDF integral over
    // a tight bracket is much smoother than the raw count of members landing
    // inside that bracket. With few members, sigma is shaky so we lean on
    // counting instead. Previously the weighting was inverted (counting
    // dominated at large ensembles), which crushed CDF's correct ~30-40%
    // estimates on tight near-mean brackets down to counting's noisy 5-10%.
    const cdfWeight = cdfBlendWeight(correctedValues.length, isPrecipCategory);
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

    // Market-prior blend with a *disagreement-adaptive* weight. The market is
    // empirically better-calibrated than the estimator on tight near-mean
    // brackets (Brier 0.134 vs 0.143 over the 2026-05 audit window), and the
    // model's worst errors are exactly its boldest disagreements: the 40–60pp
    // implied-edge bucket wins only ~19% (-$93 PnL across 109 trades). A flat
    // weight of 0.3 is too weak to neutralize those false edges.
    //
    // So instead of a constant pull we ramp the weight UP with disagreement:
    //   - at |pModel − pMarket| ≤ rampStart (0.30): stay at the base 0.3, so
    //     small-edge trades are left unblunted;
    //   - between rampStart and rampEnd (0.60): linearly interpolate base → max;
    //   - at ≥ rampEnd: clamp to max (0.7), aggressively dragging "wild" model
    //     outputs back toward the market.
    //
    // Worked example — KNYC 2026-06-05 (the loss that motivated this):
    //   model raw 0.19, market 0.80 → disagreement 0.61.
    //   • Flat w=0.3: blended = 0.7·0.19 + 0.3·0.80 = 0.37 → NO edge
    //     0.80−0.37 = 0.43 > 0.20 threshold → bot bets NO → loses (actual YES).
    //     That 43pp "false edge" is the residual the flat weight leaves on.
    //   • Adaptive w=0.7 (disagreement ≥ rampEnd): blended = 0.3·0.19 + 0.7·0.80
    //     = 0.62 → NO edge 0.80−0.62 = 0.18 < 0.20 threshold → correctly dropped.
    //
    // Gated by config.bot.marketPriorWeight > 0 (0 = disabled, preserves
    // ship-dark semantics) and only applies when a marketPrice is supplied.
    // See win-rate-80-plan-2026-06-05.md §4.3 and market-prior-2026-05-29.md.
    const config = getConfig();
    const marketPriorWeight = config.bot.marketPriorWeight;
    let marketPriorBlend: ReasoningTrace["marketPriorBlend"] = null;
    if (marketPriorWeight > 0 && marketPrice != null) {
      const base = clamp01(marketPriorWeight);
      const max = Math.max(base, clamp01(config.bot.marketPriorMaxWeight));
      const disagreement = Math.abs(blendedProbability - marketPrice); // measured BEFORE this blend
      const rampStart = config.bot.marketPriorRampStart;
      const rampEnd = Math.max(config.bot.marketPriorRampEnd, rampStart + 1e-9);
      const t = Math.min(1, Math.max(0, (disagreement - rampStart) / (rampEnd - rampStart)));
      const weight = base + (max - base) * t;

      const before = blendedProbability;
      blendedProbability = (1 - weight) * before + weight * marketPrice;
      marketPriorBlend = {
        weight,
        baseWeight: base,
        disagreement,
        marketPrice,
        probabilityBefore: before,
        probabilityAfter: blendedProbability,
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
      sigmaFloorApplied,
      observationAdjustment: obsAdj,
      obsStale,
      membersInBracket,
      cdfProbability: cdfProb,
      countingProbability: countingProb,
      historicalHitRate,
      historicalPriorBlend,
      marketPriorBlend,
      sourceMix: sourceMix ?? null,
      eventCoherence: null,
    };

    log.debug(
      `${market.ticker}: P=${probability.toFixed(3)} (counting=${countingProb.toFixed(3)}, cdf=${cdfProb.toFixed(3)}), ` +
      `conf=${confidence.toFixed(2)}, sigma=${sigmaUsed.toFixed(2)} (${sigmaSource}), ` +
      `${membersInBracket}/${correctedValues.length} members in bracket`
    );

    return { probability, confidence, ensembleSize: ensembleValues.length, reasoning };
  }

  /**
   * Event-coherent estimation (addendum N2). Estimates ALL markets of one event
   * (same station + targetDate + category — the mutually-exclusive bracket set)
   * from a SINGLE shared temperature distribution, so the returned P(YES) vector
   * sums to the partition's coverage (≈1 when the brackets+tails tile ℝ) instead
   * of the 0.79–1.69 incoherence of independent per-market estimation (Finding 2).
   *
   * Why a single shared distribution: per-market sigma floors and per-market
   * mean/sigma would each shift the integral, so the bracket probabilities would
   * no longer be slices of one CDF and could not sum coherently. We therefore
   * compute bias → corrected mean → sigma blend → an EVENT-level sigma floor
   * (floorFactor × median regular-bracket width) → observation adjustment ONCE,
   * then derive every market's raw probability from it.
   *
   * Blends are applied vector-wise and sum-preserving (historical prior →
   * renormalize back to coverage; market prior via one event-level
   * total-variation-ramped weight on the de-vigged market vector), so coherence
   * survives the priors that inflated the legacy wings.
   *
   * @param eventMarkets All markets of one event. Must be non-empty and share
   *   stationId/targetDate/category; precip/snow events are supported but skip
   *   the temperature-only sigma floor + observation adjustment.
   * @param marketPrices ticker → market P(YES) in [0,1] (mid/last). Optional;
   *   when ≥2 markets have prices and marketPriorWeight>0, drives the vector blend.
   * @returns ticker → EstimateResult (same shape as estimate(); Phase 3 consumes
   *   per-market entries unchanged).
   */
  async estimateEvent(
    eventMarkets: Market[],
    ensembleValues: number[],
    observation?: ObservationAdjustment,
    marketPrices?: Map<string, number>,
    sourceMix?: Record<string, number>
  ): Promise<Map<string, EstimateResult>> {
    if (eventMarkets.length === 0) {
      throw new Error("estimateEvent called with no markets");
    }
    // All markets of an event share station/targetDate/category. Validate each
    // market's own bracket data (same guard as estimate()).
    for (const m of eventMarkets) {
      const isTail = m.marketType === "upper_tail" || m.marketType === "lower_tail";
      if (!m.stationId || m.bracketLow == null || (!isTail && m.bracketHigh == null)) {
        throw new Error(`Market ${m.ticker} missing station/bracket data`);
      }
    }

    const ref = eventMarkets[0]!;
    const stationId = ref.stationId!;
    const category = ref.category;
    const eventTicker = ref.eventTicker;
    const isPrecipCategory = category === "precip" || category === "snowfall";

    // Forecast horizon (days), floored at 1 — identical to estimate(). Same-day
    // markets resolve at midnight-UTC so this can go <= 0; station_bias rows are
    // stored at horizon >= 1.
    const forecastHorizon = ref.targetDate
      ? Math.max(1, Math.ceil((new Date(ref.targetDate).getTime() - Date.now()) / 86400_000))
      : 1;

    // ── Step 1: Shared distribution (computed ONCE for the whole event) ──
    const biasCorrection = await this.getBiasCorrection(stationId, forecastHorizon, category);

    let correctedValues = biasCorrection
      ? ensembleValues.map((v) => v - biasCorrection.meanBias)
      : [...ensembleValues];
    if (isPrecipCategory) {
      correctedValues = correctedValues.map((v) => Math.max(0, v));
    }

    const rawMean = mean(ensembleValues);
    const rawStd = std(ensembleValues);
    let corrMean = mean(correctedValues);
    const corrStd = std(correctedValues);
    const corrMeanBeforeObs = corrMean; // for the observation meanShift trace

    // Sigma blend (empirical/ensemble, sample-size-weighted, capped) — identical
    // logic to estimate(), applied once.
    let sigmaSource: "empirical" | "ensemble" = "ensemble";
    let sigmaUsed = corrStd;
    let empiricalSigmaWeight: number | null = null;
    if (!isPrecipCategory && biasCorrection && biasCorrection.sampleSize > 0) {
      const empiricalSigma = (biasCorrection as any).stdBias as number | undefined;
      if (empiricalSigma != null && empiricalSigma > 0) {
        const w = Math.min(MAX_EMPIRICAL_SIGMA_WEIGHT, biasCorrection.sampleSize / 50);
        sigmaUsed = w * empiricalSigma + (1 - w) * corrStd;
        sigmaSource = w >= 0.5 ? "empirical" : "ensemble";
        empiricalSigmaWeight = w;
      }
    }

    // Event-level sigma floor: floorFactor × MEDIAN regular-bracket width. A
    // single shared floor (not per-market) is what keeps the vector coherent —
    // per-market floors would each reshape the integral. Tail-only events fall
    // back to width 1.0 (same convention as the per-market floor's tail case).
    let sigmaFloorApplied: number | null = null;
    if (!isPrecipCategory) {
      const floorFactor = getConfig().bot.sigmaFloorBracketWidthFactor;
      const medianWidth = medianRegularBracketWidth(eventMarkets);
      const sigmaFloor = floorFactor * medianWidth;
      if (floorFactor > 0 && sigmaUsed < sigmaFloor) {
        sigmaUsed = sigmaFloor;
        sigmaFloorApplied = sigmaFloor;
      }
    }

    // Observation adjustment (high_temp, same-day) — same shared helper as
    // estimate(), applied ONCE to the shared mean/sigma so it stays coherent
    // across brackets. Resolves the N3 running-max clamp floor for every slot.
    let obsAdj: ReasoningTrace["observationAdjustment"] = null;
    let obsStale = false;
    let runningMaxForClamp: number | null = null;
    if (observation && category === "high_temp" && forecastHorizon <= 1) {
      const r = applyObservationAdjustment(
        observation,
        stationId,
        corrMean,
        sigmaUsed,
        corrMeanBeforeObs
      );
      corrMean = r.corrMean;
      sigmaUsed = r.sigmaUsed;
      runningMaxForClamp = r.runningMaxForClamp;
      obsAdj = r.obsAdj;
      obsStale = r.obsStale;
    }

    // ── Step 2: Raw vector from the SAME distribution ──
    // Per market: counting from the shared corrected pool, CDF integral from the
    // shared mean/sigma, blended by the shared size weight. coverage = Σ raw.
    // Both consume the shared N3 running-max clamp so the vector stays coherent
    // (each P(YES) remains a slice of the SAME clamped CDF).
    const cdfWeight = cdfBlendWeight(correctedValues.length, isPrecipCategory);
    interface Slot {
      market: Market;
      isTail: boolean;
      membersInBracket: number;
      countingProb: number;
      cdfProb: number;
      raw: number; // mutated through the pipeline → final probability
      hasMarketPrice: boolean;
      marketPrice: number | null;
    }
    const slots: Slot[] = eventMarkets.map((m) => {
      const isTail = m.marketType === "upper_tail" || m.marketType === "lower_tail";
      const membersInBracket = countMembersInMarket(m, correctedValues, runningMaxForClamp);
      const countingProb = membersInBracket / correctedValues.length;
      const cdfProb = cdfProbForMarket(m, corrMean, sigmaUsed, countingProb, isPrecipCategory, runningMaxForClamp);
      const raw = cdfWeight * cdfProb + (1 - cdfWeight) * countingProb;
      const mp = marketPrices?.get(m.ticker);
      return {
        market: m,
        isTail,
        membersInBracket,
        countingProb,
        cdfProb,
        raw,
        hasMarketPrice: mp != null,
        marketPrice: mp ?? null,
      };
    });

    const coverage = slots.reduce((s, x) => s + x.raw, 0);

    // ── Step 3: Historical prior per market, then renormalize back to coverage ──
    // The prior inflates the vector (each bracket pulled toward its baseline hit
    // rate); rescaling to `coverage` keeps the partition's total mass fixed so
    // the wings can't accrue the phantom probability of the legacy path.
    const priorWeight = getConfig().bot.historicalPriorWeight;
    const histTraces = new Map<string, ReasoningTrace["historicalPriorBlend"]>();
    // Per-market historical hit rate (surfaced in the trace even when the blend
    // is off, matching estimate()). Computed once whenever priorWeight>0 — when
    // weight=0 it's left null, same as the legacy path skipping the lookup is
    // immaterial since the trace field is informational.
    const hitRates = new Map<string, number | null>();
    if (priorWeight > 0) {
      const clampedWeight = Math.min(1, Math.max(0, priorWeight));
      for (const slot of slots) {
        const hitRate = await this.getHistoricalHitRate(
          slot.market.stationId!,
          category,
          slot.market.bracketLow!,
          slot.market.bracketHigh ?? null
        );
        hitRates.set(slot.market.ticker, hitRate);
        if (hitRate != null) {
          const before = slot.raw;
          const blended = (1 - clampedWeight) * before + clampedWeight * hitRate;
          slot.raw = blended;
          histTraces.set(slot.market.ticker, {
            weight: clampedWeight,
            rawProbability: before,
            blendedProbability: blended,
          });
        }
      }
      renormalizeToCoverage(slots, coverage);
    }

    // ── Step 4: Market-prior blend, vector-wise & sum-preserving ──
    // De-vig the market price vector (strip overround), put it on the same total
    // mass as the model (× coverage), then mix with ONE event-level weight ramped
    // by total-variation distance through the existing knobs. Sum-preserving by
    // construction: each output is a convex combo of two coverage-summing vectors.
    const cfg = getConfig();
    const marketPriorWeight = cfg.bot.marketPriorWeight;
    const pricedSlots = slots.filter((s) => s.hasMarketPrice);
    let eventBlendWeight: number | null = null;
    const marketTraces = new Map<string, ReasoningTrace["marketPriorBlend"]>();
    if (marketPriorWeight > 0 && pricedSlots.length >= 2) {
      const mktSum = pricedSlots.reduce((s, x) => s + (x.marketPrice ?? 0), 0);
      const modelSumPriced = pricedSlots.reduce((s, x) => s + x.raw, 0);
      if (mktSum > 0) {
        // De-vigged market vector on the model's priced-mass scale, so the TV
        // distance compares like with like (both normalized vectors sum to 1).
        const base = clamp01(marketPriorWeight);
        const max = Math.max(base, clamp01(cfg.bot.marketPriorMaxWeight));
        const rampStart = cfg.bot.marketPriorRampStart;
        const rampEnd = Math.max(cfg.bot.marketPriorRampEnd, rampStart + 1e-9);

        // Total-variation distance between the two probability simplices.
        let tv = 0;
        for (const s of pricedSlots) {
          const pModelNorm = modelSumPriced > 0 ? s.raw / modelSumPriced : 0;
          const pMktNorm = (s.marketPrice ?? 0) / mktSum;
          tv += Math.abs(pModelNorm - pMktNorm);
        }
        tv *= 0.5;

        const t = Math.min(1, Math.max(0, (tv - rampStart) / (rampEnd - rampStart)));
        const weight = base + (max - base) * t;
        eventBlendWeight = weight;

        // Market mass on the priced-model scale: priced de-vigged vector × the
        // priced model mass, so the blend preserves Σ over the priced slots
        // (unpriced markets keep their model value, excluded from this denom).
        for (const s of pricedSlots) {
          const pMktOnScale = ((s.marketPrice ?? 0) / mktSum) * modelSumPriced;
          const before = s.raw;
          s.raw = (1 - weight) * before + weight * pMktOnScale;
          marketTraces.set(s.market.ticker, {
            weight,
            baseWeight: base,
            disagreement: tv,
            marketPrice: s.marketPrice ?? 0,
            probabilityBefore: before,
            probabilityAfter: s.raw,
          });
        }
      }
    }

    // ── Step 5: Tail floor → renormalize to coverage → final clamp (no renorm
    // after the clamp; it binds rarely and coherence telemetry catches drift). ──
    const hasEmpirical = biasCorrection != null && biasCorrection.sampleSize >= 10;
    const floor = isPrecipCategory ? 0 : hasEmpirical ? 0.01 : 0.03;
    if (!isPrecipCategory && floor > 0) {
      for (const s of slots) {
        if (s.raw < floor) s.raw = floor;
      }
      renormalizeToCoverage(slots, coverage);
      for (const s of slots) {
        s.raw = Math.min(1 - floor, Math.max(floor, s.raw));
      }
    }

    // ── Step 6: Confidence — computed ONCE per event, identical for every market. ──
    const spreadNorm = isPrecipCategory
      ? (corrMean > 0 ? corrStd / corrMean : corrStd)
      : sigmaUsed;
    const spreadDivisor = isPrecipCategory ? 2 : 10;
    const spreadFactor = Math.max(0, 1 - spreadNorm / spreadDivisor);
    const biasFactor = biasCorrection ? Math.min(1, biasCorrection.sampleSize / 30) : 0.5;
    const ensembleFactor = Math.min(1, ensembleValues.length / 120);
    const confidence = spreadFactor * 0.4 + biasFactor * 0.4 + ensembleFactor * 0.2;

    const finalSum = slots.reduce((s, x) => s + x.raw, 0);

    // ── Step 7: Build per-market results + shared eventCoherence telemetry. ──
    const eventCoherence: NonNullable<ReasoningTrace["eventCoherence"]> = {
      eventTicker,
      markets: slots.length,
      rawCdfSum: coverage,
      finalSum,
      eventBlendWeight,
    };
    if (Math.abs(finalSum - coverage) > 0.05) {
      log.info(
        `event ${eventTicker}: coherence drift finalSum=${finalSum.toFixed(3)} vs coverage=${coverage.toFixed(3)} ` +
        `(${slots.length} markets, blendW=${eventBlendWeight == null ? "off" : eventBlendWeight.toFixed(2)})`
      );
    }

    const results = new Map<string, EstimateResult>();
    for (const s of slots) {
      const reasoning: ReasoningTrace = {
        stationId,
        targetDate: ref.targetDate || "unknown",
        forecastHorizon,
        bracketLow: s.market.bracketLow!,
        bracketHigh: s.market.bracketHigh ?? s.market.bracketLow!,
        rawEnsembleStats: { mean: rawMean, std: rawStd, count: ensembleValues.length },
        biasCorrection: biasCorrection
          ? { meanBias: biasCorrection.meanBias, sampleSize: biasCorrection.sampleSize }
          : null,
        correctedEnsembleStats: { mean: corrMean, std: corrStd },
        sigmaSource,
        sigmaUsed,
        empiricalSigmaWeight,
        sigmaFloorApplied,
        observationAdjustment: obsAdj,
        obsStale,
        membersInBracket: s.membersInBracket,
        cdfProbability: s.cdfProb,
        countingProbability: s.countingProb,
        historicalHitRate: hitRates.get(s.market.ticker) ?? null,
        historicalPriorBlend: histTraces.get(s.market.ticker) ?? null,
        marketPriorBlend: marketTraces.get(s.market.ticker) ?? null,
        sourceMix: sourceMix ?? null,
        eventCoherence,
      };
      results.set(s.market.ticker, {
        probability: s.raw,
        confidence,
        ensembleSize: ensembleValues.length,
        reasoning,
      });
    }
    return results;
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

/** Cap on empirical-sigma blend weight. The empirical std is residuals-on-its-
 * own-bias-window — systematically tighter than out-of-sample forecast error.
 * Capping at 0.7 keeps 30% ensemble spread permanently in the blend, which
 * prevents the CDF from collapsing to overconfident estimates on tight
 * near-mean brackets (the dominant failure mode of the post-restart bot). */
const MAX_EMPIRICAL_SIGMA_WEIGHT = 0.7;

// ── Helpers ────────────────────────────────────────────────

/** Clamp a value into the [0, 1] probability/weight range. */
export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

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

/**
 * Count corrected ensemble members satisfying a market's bracket/tail condition.
 * Shared by the legacy `estimate()` and the event-coherent `estimateEvent()`
 * paths so both count from the SAME corrected pool with identical edge
 * semantics (upper_tail `> low`, lower_tail `< low`, bracket `[low, high)`).
 *
 * When `runningMax` is provided (addendum N3 — same-day observation anchor for
 * `high_temp`), each member is first CLAMPED to `max(member, runningMax)` before
 * the bucket test: the settled daily high cannot be below what we have already
 * observed today, so any forecast member below the running max folds onto the
 * point `runningMax`. This makes the counting path consistent with the clamped
 * CDF in {@link cdfProbForMarket}. `null`/`undefined` (the back-compat default,
 * stale/absent obs, or non-`high_temp`) leaves the raw members untouched.
 */
export function countMembersInMarket(
  market: Market,
  correctedValues: number[],
  runningMax?: number | null
): number {
  const clamp =
    runningMax != null
      ? (v: number) => Math.max(v, runningMax)
      : (v: number) => v;
  if (market.marketType === "upper_tail") {
    return correctedValues.filter((v) => clamp(v) > market.bracketLow!).length;
  }
  if (market.marketType === "lower_tail") {
    return correctedValues.filter((v) => clamp(v) < market.bracketLow!).length;
  }
  return correctedValues.filter((v) => {
    const c = clamp(v);
    return c >= market.bracketLow! && c < market.bracketHigh!;
  }).length;
}

/**
 * CDF-fitted YES probability for a single market under a shared normal
 * distribution (mean `corrMean`, sigma `sigmaUsed`). Falls back to the supplied
 * counting probability for precip/snow (zero-inflated, non-Gaussian) and when
 * sigma collapses to 0. Shared by both estimation paths so the event vector's
 * bracket `Φ(hi)−Φ(lo)` / tail `1−Φ(lo)` / `Φ(lo)` integrals are byte-identical
 * to the per-market path. Addendum N2.
 *
 * Addendum N3 — observation running-max CLAMP (NOT truncation): when
 * `runningMax` is provided, the settled high is `H = max(X, runningMax)`, so the
 * forecast CDF is clamped at `runningMax`: all mass below it folds onto the point
 * `runningMax`. The clamped CDF is `F_H(x) = 0` for `x < runningMax` and
 * `Φ((x−μ)/σ)` for `x ≥ runningMax` (the point mass at `runningMax` lives inside
 * the `Φ` evaluated at `x ≥ runningMax`). Every YES probability is then a slice
 * of this same clamped CDF, so the event vector stays coherent automatically:
 *   - bracket [lo,hi): `clampedCdf(hi) − clampedCdf(lo)` — folds the sub-rm mass
 *     INTO the bracket that contains rm, and is 0 for brackets fully below rm;
 *   - lower tail (< th): `clampedCdf(th)` = 0 when `th ≤ rm`, else `Φ((th−μ)/σ)`;
 *   - upper tail (> th): 1 when `th < rm` (the observed max already exceeds it),
 *     else `1 − Φ((th−μ)/σ)`.
 * `null`/`undefined` (back-compat default, stale/absent obs, non-`high_temp`)
 * gives the original un-clamped integrals.
 */
export function cdfProbForMarket(
  market: Market,
  corrMean: number,
  sigmaUsed: number,
  countingProb: number,
  isPrecipCategory: boolean,
  runningMax?: number | null
): number {
  if (isPrecipCategory || sigmaUsed === 0) return countingProb;

  // Clamped normal CDF of the settled high H = max(X, runningMax). Below the
  // running max the high is impossible, so F_H = 0; at/above it the mass equals
  // the (folded) forecast CDF Φ. Without an obs, this is the plain Φ.
  const clampedCdf = (x: number): number =>
    runningMax != null && x < runningMax ? 0 : normalCdf(x, corrMean, sigmaUsed);

  if (market.marketType === "upper_tail") {
    const th = market.bracketLow!;
    // th below the observed max ⇒ P(H > th) = 1 exactly (point mass at rm > th).
    if (runningMax != null && th < runningMax) return 1;
    return 1 - clampedCdf(th);
  }
  if (market.marketType === "lower_tail") {
    return clampedCdf(market.bracketLow!);
  }
  return clampedCdf(market.bracketHigh!) - clampedCdf(market.bracketLow!);
}

/**
 * Size-weighted CDF↔counting blend weight (addendum N2 shares this with the
 * legacy path). With many members (≥200) the sigma estimate is reliable and the
 * smooth normal integral beats the noisy raw count; with few members sigma is
 * shaky so counting dominates. Precip/snow always use counting (weight 0).
 */
export function cdfBlendWeight(memberCount: number, isPrecipCategory: boolean): number {
  return isPrecipCategory ? 0 : Math.min(1, memberCount / 200);
}

/**
 * Median width of an event's regular `bracket`-type markets, used as the
 * event-level sigma-floor scale (addendum N2). Tails (bracketHigh null) are
 * excluded — their "width" is undefined. Falls back to 1.0 for tail-only events
 * (matching the per-market floor's tail convention) so the floor never crashes.
 */
export function medianRegularBracketWidth(eventMarkets: Market[]): number {
  const widths = eventMarkets
    .filter((m) => m.marketType === "bracket" && m.bracketHigh != null && m.bracketLow != null)
    .map((m) => m.bracketHigh! - m.bracketLow!)
    .filter((w) => w > 0)
    .sort((a, b) => a - b);
  if (widths.length === 0) return 1.0;
  const mid = Math.floor(widths.length / 2);
  return widths.length % 2 === 1
    ? widths[mid]!
    : (widths[mid - 1]! + widths[mid]!) / 2;
}

/**
 * Resolved same-day observation state for a `high_temp` event, computed ONCE and
 * shared by both estimation paths (addendum N3). `corrMean`/`sigmaUsed` are the
 * post-observation distribution; `runningMaxForClamp` is the hard floor passed
 * into the bracket/tail integrals + member counting (null = no clamp); `obsAdj`
 * is the trace record (null when the obs was ignored); `obsStale` flags the
 * staleness-guard rejection for the orchestrator's audit.
 */
interface ObsAdjustmentResult {
  corrMean: number;
  sigmaUsed: number;
  runningMaxForClamp: number | null;
  obsAdj: ReasoningTrace["observationAdjustment"];
  obsStale: boolean;
}

/**
 * Apply the same-day observation adjustment to a shared `(corrMean, sigmaUsed)`
 * distribution for a `high_temp` market/event (addendum N3, replacing the bare
 * diurnal sigma tweak of Finding 5). Factored out of {@link
 * ProbabilityEstimator.estimate} and `estimateEvent` so BOTH paths run identical
 * staleness / post-peak / pre-peak / clamp logic and stay event-coherent.
 *
 * Flow (matches the N3 design):
 *  1. **Staleness guard** — if `latestAgeMinutes > obsMaxAgeMinutes`, ignore the
 *     obs entirely: no mean shift, no collapse, no clamp; `obsStale = true`.
 *  2. **Post-peak collapse** — local hour at the station ≥ `obsPeakHour` AND
 *     `runningMax != null`: set `corrMean = runningMax + obsPostPeakMeanOffset`
 *     and `sigmaUsed = obsPostPeakSigma`. This may drop sigma BELOW the plan-#4
 *     floor by design (real same-day information, not bias-window overfit).
 *  3. **Pre-peak** — the existing implied-high logic (diurnal offset; agree
 *     → ×0.7 sigma; diverge → blend mean toward implied + ×0.85 sigma).
 *  4. The running max (when present + fresh) is returned as the clamp floor
 *     regardless of pre/post peak.
 *
 * @param corrMean current corrected mean (mutated copy returned)
 * @param sigmaUsed current sigma (post sigma-floor; mutated copy returned)
 * @param meanBaseline the corrected mean BEFORE any obs adjustment (for the
 *   trace's `meanShift`, identical to estimate()/estimateEvent() semantics)
 */
function applyObservationAdjustment(
  observation: ObservationAdjustment,
  stationId: string,
  corrMean: number,
  sigmaUsed: number,
  meanBaseline: number
): ObsAdjustmentResult {
  const cfg = getConfig().bot;
  const ageMin = observation.latestAgeMinutes ?? null;

  // 1. Staleness guard — ignore stale obs entirely (no clamp/shift/collapse).
  if (ageMin != null && ageMin > cfg.obsMaxAgeMinutes) {
    return { corrMean, sigmaUsed, runningMaxForClamp: null, obsAdj: null, obsStale: true };
  }

  const runningMax = observation.runningMax ?? null;
  const runningMaxForClamp = runningMax; // fresh obs ⇒ clamp at the running max
  const sigmaBefore = sigmaUsed;
  const obsHour = localHourAtStation(observation.observedAt, stationId);

  // 2. Post-peak collapse: after ~peak hour the day's high ≈ runningMax + ε.
  const postPeakCollapse =
    obsHour >= cfg.obsPeakHour && runningMax != null;
  if (postPeakCollapse) {
    corrMean = runningMax! + cfg.obsPostPeakMeanOffset;
    sigmaUsed = cfg.obsPostPeakSigma; // may go below the sigma floor — intended
  } else {
    // 3. Pre-peak: project obs to an implied afternoon high, compare to mean.
    const diurnalOffset = estimateDiurnalOffset(obsHour);
    const impliedHigh = observation.observedTemp + diurnalOffset;
    const divergence = Math.abs(impliedHigh - corrMean);
    if (divergence <= 2) {
      sigmaUsed = sigmaUsed * 0.7;
    } else {
      corrMean = 0.7 * corrMean + 0.3 * impliedHigh;
      sigmaUsed = sigmaUsed * 0.85;
    }
  }

  return {
    corrMean,
    sigmaUsed,
    runningMaxForClamp,
    obsAdj: {
      observedTemp: observation.observedTemp,
      sigmaBefore,
      sigmaAfter: sigmaUsed,
      meanShift: corrMean - meanBaseline,
      runningMax,
      postPeakCollapse,
      latestAgeMinutes: ageMin,
    },
    obsStale: false,
  };
}

/**
 * Rescale a slot vector so Σ raw == `coverage` again (sum-preserving step used
 * after the historical-prior and tail-floor inflations in estimateEvent — N2).
 * No-op when the current sum is 0 (vector is all-zero; nothing to preserve).
 */
function renormalizeToCoverage(slots: Array<{ raw: number }>, coverage: number): void {
  const current = slots.reduce((s, x) => s + x.raw, 0);
  if (current === 0) return;
  const k = coverage / current;
  for (const s of slots) s.raw *= k;
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
