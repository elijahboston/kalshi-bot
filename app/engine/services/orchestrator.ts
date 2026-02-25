import { getDb, markets, signals, positions, balanceHistory, eq, and, sql, desc } from "@kcb/db";
import type { Market } from "@kcb/db";
import { getConfig } from "@kcb/config";
import { KalshiClient, KalshiFeed } from "@kcb/kalshi-client";
import { bus, createLogger } from "../events";
import { registerTick, startLoop, stopLoop, getLoopState } from "./loop";
import { discoverMarkets } from "./discovery";
import { startFeed, stopFeed, subscribeToTickers } from "./feed";
import { EnsembleService } from "@kcb/data";
import { ProbabilityEstimator, getEffectiveThreshold } from "@kcb/signals";
import type { EstimateResult } from "@kcb/signals";
import { ExecutionService, computeKelly } from "@kcb/execution";
import { ReconciliationService } from "./reconciliation";
import { uuid, now, seriesCategory } from "@kcb/shared";

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
  const kalshi = new KalshiClient();
  const feed = new KalshiFeed();
  const ensembleService = new EnsembleService();
  const estimator = new ProbabilityEstimator();
  const executionService = new ExecutionService(kalshi);
  const reconciliationService = new ReconciliationService(kalshi);

  log.info("Initializing orchestrator");

  // Sync portfolio from Kalshi immediately so the TUI shows data on launch
  await reconciliationService.syncHistoricalOrders();
  await reconciliationService.syncSettlements();
  await reconciliationService.syncPositionsFromKalshi();

  // Start the WebSocket feed before the first tick
  startFeed(feed);

  registerTick(async () => {
    // Phase 1: Discovery (REST for bulk load, WS handles ongoing updates)
    log.debug("Phase 1: Market discovery");
    try {
      const newCount = await discoverMarkets(kalshi);

      // After discovery, subscribe to ticker updates for all tracked markets
      if (newCount > 0) {
        const tracked = await db
          .select({ ticker: markets.ticker })
          .from(markets)
          .where(eq(markets.status, "open"));
        const tickers = tracked.map((m) => m.ticker);
        subscribeToTickers(tickers);
      }
    } catch (err) {
      log.error("Discovery failed", err);
      bus.emit("bot:error", {
        module: "discovery",
        message: err instanceof Error ? err.message : String(err),
        error: err,
      });
    }

    // Phase 2: Estimate — Fetch weather data, run probability estimation
    log.debug("Phase 2: Probability estimation");

    const today = new Date().toISOString().slice(0, 10);
    const activeMarkets = await db
      .select()
      .from(markets)
      .where(
        and(
          sql`${markets.status} != 'settled'`,
          sql`${markets.targetDate} >= ${today}`
        )
      );

    const estimates: Array<{ market: Market; estimate: EstimateResult }> = [];

    for (const market of activeMarkets) {
      if (!market.stationId || !market.category) continue;
      if (market.bracketLow == null || market.bracketHigh == null) continue;

      try {
        const category = market.category as Parameters<typeof ensembleService.getEnsembleValues>[2];
        const ensembleValues = await ensembleService.getEnsembleValues(
          market.stationId,
          market.targetDate!,
          category
        );
        const estimate = await estimator.estimate(market, ensembleValues);
        estimates.push({ market, estimate });
      } catch (err) {
        log.warn(
          `Estimation failed for ${market.ticker}: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    if (estimates.length > 0) {
      log.info(`Estimated ${estimates.length} market(s)`);
    }

    // Phase 3: Evaluate — Compare estimates to prices, generate signals
    log.debug("Phase 3: Signal evaluation");

    interface ActionableSignal {
      id: string;
      ticker: string;
      seriesTicker: string;
      estimatedProb: number;
      confidence: number;
      marketPrice: number;
      edge: number;
      edgeThreshold: number;
      recommendation: string;
      side: "yes" | "no" | null;
      kellyFraction: number | null;
      ensembleSize: number;
      reasoning: string;
    }

    const actionableSignals: ActionableSignal[] = [];

    for (const { market, estimate } of estimates) {
      const marketPrice = (market.lastYesPrice ?? 50) / 100;

      // Determine side and edge
      const yesEdge = estimate.probability - marketPrice;
      const noEdge = (1 - estimate.probability) - (1 - marketPrice);

      let side: "yes" | "no" | null = null;
      let edge = 0;

      if (yesEdge > 0 && yesEdge >= Math.abs(noEdge)) {
        side = "yes";
        edge = yesEdge;
      } else if (noEdge > 0) {
        side = "no";
        edge = noEdge;
      }

      // Get effective threshold (adaptive per-bucket)
      const edgeThreshold = await getEffectiveThreshold(
        estimate.probability,
        market.seriesTicker
      );

      // Determine recommendation
      let recommendation: "buy_yes" | "buy_no" | "skip" = "skip";
      let skipReason: string | null = null;

      if (!side || edge <= 0) {
        skipReason = "no edge";
      } else if (edge < edgeThreshold) {
        skipReason = `edge ${(edge * 100).toFixed(1)}¢ < threshold ${(edgeThreshold * 100).toFixed(1)}¢`;
      } else if (estimate.confidence < config.bot.minConfidence) {
        skipReason = `confidence ${estimate.confidence.toFixed(2)} < ${config.bot.minConfidence}`;
      } else {
        recommendation = side === "yes" ? "buy_yes" : "buy_no";
      }

      // Compute Kelly fraction
      const kellyFraction =
        side && recommendation !== "skip"
          ? computeKelly(estimate.probability, marketPrice, side)
          : null;

      const signalId = uuid();

      // Insert signal record
      await db.insert(signals).values({
        id: signalId,
        ticker: market.ticker,
        seriesTicker: market.seriesTicker,
        estimatedProb: estimate.probability,
        confidence: estimate.confidence,
        marketPrice,
        edge,
        edgeThreshold,
        recommendation,
        side,
        kellyFraction,
        ensembleSize: estimate.ensembleSize,
        reasoning: JSON.stringify(estimate.reasoning),
        acted: false,
        skipReason,
        createdAt: now(),
      });

      if (recommendation !== "skip" && side) {
        actionableSignals.push({
          id: signalId,
          ticker: market.ticker,
          seriesTicker: market.seriesTicker,
          estimatedProb: estimate.probability,
          confidence: estimate.confidence,
          marketPrice,
          edge,
          edgeThreshold,
          recommendation,
          side,
          kellyFraction,
          ensembleSize: estimate.ensembleSize,
          reasoning: JSON.stringify(estimate.reasoning),
        });

        bus.emit("signal:new", {
          id: signalId,
          ticker: market.ticker,
          side,
          edge,
          confidence: estimate.confidence,
          recommendation,
          estimatedProb: estimate.probability,
          marketPrice,
        });
      }
    }

    log.info(
      `Generated ${estimates.length} signals (${actionableSignals.length} actionable)`
    );

    // Phase 3.5: Exit evaluation — Check open positions for exit triggers
    log.debug("Phase 3.5: Exit evaluation");

    const openPositions = await db.select().from(positions);

    for (const position of openPositions) {
      try {
        const side = position.side as "yes" | "no";

        // Look up the market for current price and close time
        const [market] = await db
          .select()
          .from(markets)
          .where(eq(markets.ticker, position.ticker))
          .limit(1);
        if (!market) continue;

        const marketPrice = (market.lastYesPrice ?? 50) / 100;

        // Find the latest estimate for this ticker
        const est = estimates.find((e) => e.market.ticker === position.ticker);
        if (!est) continue; // no fresh estimate, skip exit evaluation

        // Compute held-side edge
        const edge = side === "yes"
          ? est.estimate.probability - marketPrice
          : (1 - est.estimate.probability) - (1 - marketPrice);

        // Check exit triggers
        let exitReason: string | null = null;

        // 1. Edge reversal
        if (edge < config.bot.exitEdgeThreshold) {
          exitReason = `edge reversal (${(edge * 100).toFixed(1)}¢ < ${(config.bot.exitEdgeThreshold * 100).toFixed(1)}¢ threshold)`;
        }

        // 2. Stop-loss
        if (!exitReason && position.costBasis > 0) {
          const lossPct = position.unrealizedPnl / position.costBasis;
          if (lossPct < -config.bot.stopLossPct) {
            exitReason = `stop-loss (${(lossPct * 100).toFixed(1)}% loss > ${(config.bot.stopLossPct * 100).toFixed(0)}% limit)`;
          }
        }

        // 3. Time decay
        if (!exitReason && market.closeTime) {
          const closeDate = new Date(market.closeTime);
          const nowDate = new Date();
          const daysUntilClose = (closeDate.getTime() - nowDate.getTime()) / (1000 * 60 * 60 * 24);
          if (daysUntilClose <= config.bot.exitTimeDaysBeforeClose && edge < config.bot.exitTimeMinEdge) {
            exitReason = `time decay (${(daysUntilClose * 24).toFixed(1)}h to close, edge ${(edge * 100).toFixed(1)}¢ < ${(config.bot.exitTimeMinEdge * 100).toFixed(0)}¢)`;
          }
        }

        if (exitReason) {
          await executionService.executeExit(position, exitReason, market.lastYesPrice ?? 50);
        }
      } catch (err) {
        log.error(
          `Exit evaluation failed for ${position.ticker}: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    // Phase 4: Execute — Place/cancel orders based on signals
    log.debug("Phase 4: Order execution");

    if (actionableSignals.length > 0) {
      // Get balance
      let balance: number;
      if (config.bot.dryRun) {
        const lastRecord = await db
          .select()
          .from(balanceHistory)
          .orderBy(desc(balanceHistory.recordedAt))
          .limit(1);
        balance = lastRecord[0]?.balance ?? 10000; // default $100
      } else {
        const kalshiBalance = await kalshi.getBalance();
        balance = kalshiBalance.balance;
      }

      for (const signal of actionableSignals) {
        try {
          // Build a signal-like object matching the Signal type
          const signalRecord = {
            id: signal.id,
            ticker: signal.ticker,
            seriesTicker: signal.seriesTicker,
            estimatedProb: signal.estimatedProb,
            confidence: signal.confidence,
            marketPrice: signal.marketPrice,
            edge: signal.edge,
            edgeThreshold: signal.edgeThreshold,
            recommendation: signal.recommendation,
            side: signal.side,
            kellyFraction: signal.kellyFraction,
            ensembleSize: signal.ensembleSize,
            reasoning: signal.reasoning,
            acted: false,
            orderId: null,
            skipReason: null,
            createdAt: now(),
          };

          const orderId = await executionService.executeSignal(
            signalRecord,
            balance
          );

          // Update signal with result
          if (orderId) {
            await db
              .update(signals)
              .set({ acted: true, orderId })
              .where(eq(signals.id, signal.id));
          } else {
            await db
              .update(signals)
              .set({ skipReason: "execution skipped (position/size limits)" })
              .where(eq(signals.id, signal.id));
          }
        } catch (err) {
          log.error(
            `Execution failed for ${signal.ticker}: ${err instanceof Error ? err.message : err}`
          );
          await db
            .update(signals)
            .set({
              skipReason: `execution error: ${err instanceof Error ? err.message : err}`,
            })
            .where(eq(signals.id, signal.id));
        }
      }
    }

    // Phase 5: Reconcile — Sync positions, check resolutions, update calibration
    log.debug("Phase 5: Reconciliation");
    try {
      await reconciliationService.reconcile();
    } catch (err) {
      log.error("Reconciliation failed", err);
      bus.emit("bot:error", {
        module: "reconciliation",
        message: err instanceof Error ? err.message : String(err),
        error: err,
      });
    }
  });

  log.info("Orchestrator initialized — ready to start");
}

export { startLoop as start, stopLoop as stop, getLoopState as getState, stopFeed };
