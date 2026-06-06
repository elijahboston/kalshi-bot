/**
 * @kcb/signals — Probability estimation and signal generation
 *
 * Pipeline:
 * 1. Receive weather forecast data for a market's target date/station
 * 2. Apply station bias corrections from historical calibration
 * 3. Compute bracket probability from ensemble distribution
 * 4. Compare to market price → generate signal with edge/confidence
 * 5. Apply adaptive threshold based on recent calibration per bucket
 */

export { ProbabilityEstimator } from "./services/estimator";
export type { EstimateResult, ReasoningTrace, ObservationAdjustment } from "./services/estimator";
export {
  getEffectiveThreshold,
  persistAdaptiveThresholds,
  computeBucketThreshold,
} from "./services/adaptive-threshold";
export {
  evaluateTailGate,
  evaluateEntryGates,
  evaluateConfirmation,
} from "./services/entry-gates";
export type {
  TailGateInput,
  TailGateResult,
  EntryGateInput,
  EntryGateResult,
  ConfirmationInput,
  ConfirmationResult,
} from "./services/entry-gates";
export {
  evaluateStationHealth,
  updateStationHealthGate,
} from "./services/station-health";
export type {
  StationTradeOutcome,
  StationHealthDecision,
} from "./services/station-health";
