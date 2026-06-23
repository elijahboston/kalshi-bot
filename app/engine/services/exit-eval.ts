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
  /** When the position was opened (ISO string). Used by the minimum hold guard. */
  entryTime: string | null;
  /**
   * How the position was entered. Confirmation positions ("the market is
   * right, follow it") carry model edge ≤ 0 BY DESIGN, so the edge-reversal
   * and time-decay exits — which key on model edge — must never apply to them
   * (first live night 2026-06-05: edge-reversal fired one tick after every
   * confirmation entry, churning 4 winning positions into realized losses).
   * Their exit policy is: hold to settlement; stop-loss still applies; bail
   * only when the market's own conviction collapses (see
   * confirmationExitConvictionFloor). Defaults to "contrarian".
   */
  entryKind?: "contrarian" | "confirmation";
  /** Exit-related config values */
  config: {
    exitEdgeThreshold: number;
    stopLossPct: number;
    stopLossMinEdge: number;
    exitTimeDaysBeforeClose: number;
    exitTimeMinEdge: number;
    /**
     * Winner-hold carve-out threshold, in PROBABILITY units (0-1). When our
     * side's market price is at or above this level (i.e. the market agrees we
     * have won) and the position is close to settlement and in profit, suppress
     * edge-reversal and time-decay exits so the confirmed winner rides to
     * settlement. Stop-loss still fires. Absent/0 disables the carve-out.
     * Configured default: 0.90.
     */
    exitHoldWinnerPrice?: number;
    /**
     * Max hours-to-close for the winner-hold carve-out to apply. Defaults to 6
     * when the carve-out is enabled (exitHoldWinnerPrice > 0) but this is absent.
     */
    exitHoldWinnerMaxHoursToClose?: number;
    /**
     * Confirmation-position bail-out: exit when our side's market price (the
     * market's conviction — the entire thesis of a confirmation entry) drops
     * below this, in probability units (0-1). Absent/0 disables. Default 0.60.
     */
    confirmationExitConvictionFloor?: number;
    /**
     * Minimum seconds after position open before discretionary exits (edge
     * reversal, conviction floor, time decay) fire. Stop-loss is always
     * immediate. 0 = disabled. Default 1200 (20 min).
     */
    exitMinHoldSeconds?: number;
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
 *
 * Winner-hold carve-out (N8, win-rate-80-addendum-2026-06-05.md, Finding 8):
 * The exit counterfactual on 79 settled paper exits showed 65 exited positions
 * would have WON at settlement (avg exit 88.6¢ — foregone ≈ $107), while 14
 * would have lost (saved ≈ $176). Exits stay net-positive, so the logic
 * remains — but when our side already trades like a confirmed winner near
 * settlement we suppress the discretionary exits to recover most of that ~$107
 * without giving back the ~$176 of dodged losses. Concretely, when our side's
 * price ≥ exitHoldWinnerPrice (default 0.90), hours-to-close is within the
 * carve-out window, AND the position is in profit, the edge-reversal and
 * time-decay branches are skipped. Stop-loss is intentionally left untouched
 * (an in-profit ≥90¢ position cannot trip it anyway, but ordering stays
 * defensive). Absent/0 exitHoldWinnerPrice disables the carve-out entirely.
 */
export function evaluateExit(input: ExitEvaluationInput): string | null {
  const { edge, position, currentSidePrice, closeTime, now, config } = input;

  // Minimum hold guard: suppress discretionary exits (conviction floor, edge
  // reversal, time decay) within the first exitMinHoldSeconds after entry.
  // Stop-loss is intentionally exempt — a catastrophic drawdown should stop
  // regardless of hold time. 0 = disabled.
  const minHoldSeconds = config.exitMinHoldSeconds ?? 0;
  const withinMinHold =
    minHoldSeconds > 0 && input.entryTime != null
      ? now - new Date(input.entryTime).getTime() < minHoldSeconds * 1000
      : false;

  // Confirmation positions: model-edge-based exits never apply (their edge is
  // ≤ 0 by construction). Hold to settlement unless (a) stop-loss, or (b) the
  // market's own conviction — the thesis — collapses below the floor.
  if (input.entryKind === "confirmation") {
    if (!withinMinHold) {
      const convictionFloor = config.confirmationExitConvictionFloor ?? 0;
      if (convictionFloor > 0 && currentSidePrice < convictionFloor * 100) {
        return (
          `confirmation conviction collapsed ` +
          `(${currentSidePrice}¢ < ${(convictionFloor * 100).toFixed(0)}¢ floor)`
        );
      }
    }
    if (position.costBasis > 0) {
      const liveUnrealized = position.quantity * currentSidePrice - position.costBasis;
      const lossPct = liveUnrealized / position.costBasis;
      if (lossPct < -config.stopLossPct) {
        return `stop-loss (${(lossPct * 100).toFixed(1)}% loss on confirmation position)`;
      }
    }
    return null;
  }

  // Winner-hold determination (computed up front; consulted by the
  // discretionary exit branches below).
  const holdPrice = config.exitHoldWinnerPrice ?? 0;
  const holdMaxHours = config.exitHoldWinnerMaxHoursToClose ?? 6;
  let holdWinner = false;
  if (holdPrice > 0 && closeTime) {
    const hoursToClose = (new Date(closeTime).getTime() - now) / 3_600_000;
    const liveUnrealized = position.quantity * currentSidePrice - position.costBasis;
    // currentSidePrice is in CENTS (0-100); holdPrice is in probability units
    // (0-1) — multiply by 100 to compare on the same scale.
    holdWinner =
      currentSidePrice >= holdPrice * 100 && // our side trades ≥ ~90¢ — market agrees we won
      hoursToClose >= 0 &&
      hoursToClose <= holdMaxHours &&
      liveUnrealized > 0; // position is in profit
  }

  if (!holdWinner && !withinMinHold && edge < config.exitEdgeThreshold) {
    return `edge reversal (${(edge * 100).toFixed(1)}¢ < ${(config.exitEdgeThreshold * 100).toFixed(1)}¢ threshold)`;
  }

  if (position.costBasis > 0) {
    const liveUnrealized = position.quantity * currentSidePrice - position.costBasis;
    const lossPct = liveUnrealized / position.costBasis;
    if (lossPct < -config.stopLossPct && edge < config.stopLossMinEdge) {
      return `stop-loss (${(lossPct * 100).toFixed(1)}% loss, edge ${(edge * 100).toFixed(1)}¢ < ${(config.stopLossMinEdge * 100).toFixed(0)}¢)`;
    }
  }

  if (!holdWinner && !withinMinHold && closeTime) {
    const daysUntilClose = (new Date(closeTime).getTime() - now) / (1000 * 60 * 60 * 24);
    if (daysUntilClose <= config.exitTimeDaysBeforeClose && edge < config.exitTimeMinEdge) {
      return `time decay (${(daysUntilClose * 24).toFixed(1)}h to close, edge ${(edge * 100).toFixed(1)}¢ < ${(config.exitTimeMinEdge * 100).toFixed(0)}¢)`;
    }
  }

  return null;
}
