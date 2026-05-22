export interface ExitEvaluationInput {
  /** Held-side edge at current market price (in probability units, 0-1) */
  edge: number;
  /** Open position state needed for drawdown math */
  position: { quantity: number; costBasis: number };
  /** Current market price (in cents, 0-100) for the held side */
  currentSidePrice: number;
  /** Market close timestamp (ISO) or null if unknown */
  closeTime: string | null;
  /** Current wall-clock epoch millis — injected for testability */
  now: number;
  /** Exit-related config values */
  config: {
    exitEdgeThreshold: number;
    stopLossPct: number;
    stopLossMinEdge: number;
    exitTimeDaysBeforeClose: number;
    exitTimeMinEdge: number;
  };
}

/**
 * Pure exit-decision logic. Returns a human-readable reason string if the
 * position should be exited this tick, or null to hold.
 *
 * Order of checks:
 *  1. Edge reversal — the model says this bet is no longer worth holding.
 *  2. Stop-loss — large drawdown AND edge has compressed. The edge gate is
 *     what keeps model-correct positions from being stopped out on mark-to-
 *     market noise (Kalshi binary contracts swing hard intraday).
 *  3. Time decay — inside the close window with edge too thin to justify
 *     holding to resolution.
 */
export function evaluateExit(input: ExitEvaluationInput): string | null {
  const { edge, position, currentSidePrice, closeTime, now, config } = input;

  if (edge < config.exitEdgeThreshold) {
    return `edge reversal (${(edge * 100).toFixed(1)}¢ < ${(config.exitEdgeThreshold * 100).toFixed(1)}¢ threshold)`;
  }

  if (position.costBasis > 0) {
    const liveUnrealized = position.quantity * currentSidePrice - position.costBasis;
    const lossPct = liveUnrealized / position.costBasis;
    if (lossPct < -config.stopLossPct && edge < config.stopLossMinEdge) {
      return `stop-loss (${(lossPct * 100).toFixed(1)}% loss, edge ${(edge * 100).toFixed(1)}¢ < ${(config.stopLossMinEdge * 100).toFixed(0)}¢)`;
    }
  }

  if (closeTime) {
    const daysUntilClose = (new Date(closeTime).getTime() - now) / (1000 * 60 * 60 * 24);
    if (daysUntilClose <= config.exitTimeDaysBeforeClose && edge < config.exitTimeMinEdge) {
      return `time decay (${(daysUntilClose * 24).toFixed(1)}h to close, edge ${(edge * 100).toFixed(1)}¢ < ${(config.exitTimeMinEdge * 100).toFixed(0)}¢)`;
    }
  }

  return null;
}
