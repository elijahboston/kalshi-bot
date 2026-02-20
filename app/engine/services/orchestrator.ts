import { getDb } from "@kcb/db";
import { getConfig } from "@kcb/config";
import { bus, createLogger } from "../events";
import { registerTick, startLoop, stopLoop, getLoopState } from "./loop";

const log = createLogger("orchestrator");

/**
 * The orchestrator wires together the pipeline stages and
 * registers the tick function with the main loop.
 *
 * Each tick:
 *   1. Discovery  — find new/updated markets from Kalshi
 *   2. Estimate   — run probability estimator on active markets
 *   3. Evaluate   — compare estimates to market prices, generate signals
 *   4. Execute    — place/cancel orders based on signals
 *   5. Reconcile  — update positions, check resolutions, run calibration
 */
export async function initOrchestrator(): Promise<void> {
  const config = getConfig();
  const db = getDb(config.db.path);

  log.info("Initializing orchestrator");

  registerTick(async () => {
    // Phase 1: Discovery
    // TODO: Implement market discovery service
    log.debug("Phase 1: Market discovery");

    // Phase 2: Estimate
    // TODO: Fetch weather data, run probability estimation
    log.debug("Phase 2: Probability estimation");

    // Phase 3: Evaluate
    // TODO: Compare estimates to prices, generate signals
    log.debug("Phase 3: Signal evaluation");

    // Phase 4: Execute
    // TODO: Place/cancel orders based on signals
    log.debug("Phase 4: Order execution");

    // Phase 5: Reconcile
    // TODO: Sync positions, check resolutions, update calibration
    log.debug("Phase 5: Reconciliation");
  });

  log.info("Orchestrator initialized — ready to start");
}

export { startLoop as start, stopLoop as stop, getLoopState as getState };
