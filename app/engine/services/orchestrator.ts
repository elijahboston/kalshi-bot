import { getDb, markets, signals, positions, balanceHistory, eq, and, sql, desc } from "@kcb/db";
import type { Market } from "@kcb/db";
import { getConfig } from "@kcb/config";
import { KalshiClient, KalshiFeed } from "@kcb/kalshi-client";
import { bus, createLogger } from "../events";
import { registerTick, startLoop, stopLoop, getLoopState } from "./loop";
import { discoverMarkets } from "./discovery";
import { startFeed, stopFeed, subscribeToTickers } from "./feed";
import { EnsembleService, NwsService } from "@kcb/data";
import { ProbabilityEstimator, getEffectiveThreshold, evaluateTailGate } from "@kcb/signals";
import type { EstimateResult, ObservationAdjustment } from "@kcb/signals";
import { ExecutionService, computeKelly, recordExit, tickCooldowns, isTickerHeld, restoreAntiChurnState } from "@kcb/execution";
import { ReconciliationService } from "./reconciliation";
import { evaluateExit } from "./exit-eval";
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
  const nwsService = new NwsService();
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
    // Restore anti-churn state from DB on first tick after restart
    await restoreAntiChurnState();

    // Decrement post-exit cooldowns before evaluating new signals
    tickCooldowns();

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

    // Cache same-day observations per station to avoid redundant NWS calls
    const observationCache = new Map<string, ObservationAdjustment | null>();

    for (const market of activeMarkets) {
      if (!market.stationId || !market.category) continue;
      // Tails (upper_tail/lower_tail) intentionally store bracketHigh=null —
      // bracketLow is the threshold and the estimator branches on marketType.
      // Only brackets need both bounds populated.
      if (market.bracketLow == null) continue;
      const isTail =
        market.marketType === "upper_tail" || market.marketType === "lower_tail";
      if (!isTail && market.bracketHigh == null) continue;

      try {
        // Compute forecast horizon in hours for HRRR/blending
        const forecastHorizonHours = market.closeTime
          ? Math.max(0, (new Date(market.closeTime).getTime() - Date.now()) / (1000 * 60 * 60))
          : market.targetDate
            ? Math.max(0, (new Date(market.targetDate + "T23:59:00Z").getTime() - Date.now()) / (1000 * 60 * 60))
            : undefined;

        const category = market.category as Parameters<typeof ensembleService.getEnsembleValues>[2];
        const ensembleValues = await ensembleService.getEnsembleValues(
          market.stationId,
          market.targetDate!,
          category,
          forecastHorizonHours
        );

        // Fetch same-day observation for temperature markets (improvement #4)
        let observation: ObservationAdjustment | undefined;
        if (
          market.category === "high_temp" &&
          forecastHorizonHours != null &&
          forecastHorizonHours <= 24
        ) {
          if (!observationCache.has(market.stationId)) {
            const obs = await nwsService.getLatestObservation(market.stationId);
            observationCache.set(
              market.stationId,
              obs ? { observedTemp: obs.tempF, observedAt: obs.timestamp } : null
            );
          }
          observation = observationCache.get(market.stationId) ?? undefined;
        }

        const marketPriceForEstimator =
          market.lastYesPrice != null ? market.lastYesPrice / 100 : undefined;
        const estimate = await estimator.estimate(
          market,
          ensembleValues,
          observation,
          marketPriceForEstimator
        );
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
      // Skip markets with no price data — placing orders at the 50¢ default
      // creates resting orders that never fill and churn through cancel/re-place cycles
      if (market.lastYesPrice == null) {
        log.debug(`Skipping ${market.ticker}: no price data yet`);
        continue;
      }

      const marketPrice = market.lastYesPrice / 100;

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

      // Get effective threshold (adaptive per-bucket) + per-station surcharge.
      // The surcharge requires historically loss-making stations to clear a
      // bigger edge bar — see improvements/per-station-surcharge-2026-05-29.md.
      const baseThreshold = await getEffectiveThreshold(
        estimate.probability,
        market.seriesTicker
      );
      const stationSurcharge = market.stationId
        ? (config.bot.stationEdgeSurcharge[market.stationId] ?? 0)
        : 0;
      const edgeThreshold = baseThreshold + stationSurcharge;

      // Determine recommendation
      let recommendation: "buy_yes" | "buy_no" | "scout" | "skip" = "skip";
      let skipReason: string | null = null;

      // Sniper mode: gate entry based on forecast horizon
      const sniperHorizon = config.bot.sniperHorizonHours;
      let forecastHorizonHours: number | undefined;
      if (market.closeTime) {
        forecastHorizonHours = Math.max(
          0,
          (new Date(market.closeTime).getTime() - Date.now()) / (1000 * 60 * 60)
        );
      } else if (market.targetDate) {
        forecastHorizonHours = Math.max(
          0,
          (new Date(market.targetDate + "T23:59:00Z").getTime() - Date.now()) / (1000 * 60 * 60)
        );
      }

      const inSniperWindow =
        sniperHorizon === 0 || // disabled
        forecastHorizonHours == null ||
        forecastHorizonHours <= sniperHorizon;

      // Tail-market entry gate. Tails historically bled on mid-priced contracts
      // (audit window: 11% win, -$38 across 9 resolved trades, losses spanning
      // 20-62¢ entries). When enabled, only allow tail entries whose contract
      // price is ≤ tailMaxEntryPrice. See improvements/tail-gate-2026-05-29.md.
      const tailGate = side
        ? evaluateTailGate({
            market,
            side,
            marketPrice,
            tailMaxEntryPrice: config.bot.tailMaxEntryPrice,
          })
        : { allowed: true as const };

      if (!side || edge <= 0) {
        skipReason = "no edge";
      } else if (!inSniperWindow) {
        recommendation = "scout";
        skipReason = `scout mode (${forecastHorizonHours!.toFixed(1)}h > ${sniperHorizon}h sniper window)`;
      } else if (edge < edgeThreshold) {
        skipReason =
          stationSurcharge > 0
            ? `edge ${(edge * 100).toFixed(1)}¢ < threshold ${(baseThreshold * 100).toFixed(1)}¢ + ${(stationSurcharge * 100).toFixed(0)}¢ ${market.stationId} surcharge`
            : `edge ${(edge * 100).toFixed(1)}¢ < threshold ${(edgeThreshold * 100).toFixed(1)}¢`;
      } else if (estimate.confidence < config.bot.minConfidence) {
        skipReason = `confidence ${estimate.confidence.toFixed(2)} < ${config.bot.minConfidence}`;
      } else if (!tailGate.allowed) {
        skipReason = tailGate.reason ?? "tail gate blocked";
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
        dryRun: getConfig().bot.dryRun,
      });

      if (recommendation !== "skip" && recommendation !== "scout" && side) {
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

    // Deduplicate: positions table has a unique ticker PK, but guard against
    // any race that might produce duplicate rows in the same tick.
    const seenTickers = new Set<string>();

    for (const position of openPositions) {
      if (seenTickers.has(position.ticker)) continue;
      seenTickers.add(position.ticker);

      // Skip tickers marked for hold-until-settlement
      if (isTickerHeld(position.ticker)) continue;

      try {
        const side = position.side as "yes" | "no";

        // Look up the market for current price and close time
        const [market] = await db
          .select()
          .from(markets)
          .where(eq(markets.ticker, position.ticker))
          .limit(1);
        if (!market) continue;
        if (market.lastYesPrice == null) continue; // no price data

        const marketPrice = market.lastYesPrice / 100;

        // Find the latest estimate for this ticker
        const est = estimates.find((e) => e.market.ticker === position.ticker);
        if (!est) continue; // no fresh estimate, skip exit evaluation

        // Compute held-side edge
        const edge = side === "yes"
          ? est.estimate.probability - marketPrice
          : (1 - est.estimate.probability) - (1 - marketPrice);

        const currentSidePrice = side === "yes"
          ? (market.lastYesPrice ?? 50)
          : (market.lastNoPrice ?? 50);

        const exitReason = evaluateExit({
          edge,
          position: { quantity: position.quantity, costBasis: position.costBasis },
          currentSidePrice,
          closeTime: market.closeTime,
          now: Date.now(),
          config: {
            exitEdgeThreshold: config.bot.exitEdgeThreshold,
            stopLossPct: config.bot.stopLossPct,
            stopLossMinEdge: config.bot.stopLossMinEdge,
            exitTimeDaysBeforeClose: config.bot.exitTimeDaysBeforeClose,
            exitTimeMinEdge: config.bot.exitTimeMinEdge,
          },
        });

        if (exitReason) {
          // Determine if this exit is a loss for re-entry guard purposes
          const liveUnrealized = position.quantity * currentSidePrice - position.costBasis;
          const lossPct = position.costBasis > 0 ? liveUnrealized / position.costBasis : 0;
          const isLoss = liveUnrealized < 0;

          const exitOrderId = await executionService.executeExit(position, exitReason, market.lastYesPrice ?? 50);
          if (exitOrderId) {
            recordExit(position.ticker, isLoss, lossPct);
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("insufficient_balance") || errMsg.includes("insufficient balance")) {
          log.warn(`Exit failed for ${position.ticker}: insufficient balance (will retry next tick at a viable price)`);
        } else {
          log.error(`Exit evaluation failed for ${position.ticker}: ${errMsg}`);
        }
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

      // Reserve enough cash to exit all open positions.
      // Worst case: sell at 2¢ (floor), counterparty collateral = (100 - 2) = 98¢ per contract.
      // But selling a position we OWN doesn't cost us — we receive proceeds.
      // The reserve is for the scenario where prices move against us and we need
      // cash to cover any resting order collateral. Use 2¢ per contract as buffer.
      const openPositions = await db.select({ quantity: positions.quantity }).from(positions);
      const exitReserve = openPositions.reduce((sum, p) => sum + p.quantity * 2, 0);
      const balanceFloor = config.bot.minBalanceFloor;

      // Profit reserve: lock away a percentage of gains above seed capital.
      // Skipped in dry_run mode — paper bankroll has no "deposited capital" to
      // protect, and a stale seedCapital (e.g., 17556¢ from an earlier balance
      // snapshot) silently locks away large fractions of paper gains
      // (~$150/$473 = 35% of effective capital, per 2026-05-26 audit).
      const totalEquity = balance + openPositions.reduce((sum, p) => sum + (p.quantity ?? 0) * 2, 0); // rough equity
      const profit = Math.max(0, balance - config.bot.seedCapital);
      const profitReserve = config.bot.dryRun
        ? 0
        : Math.round(profit * config.bot.profitReservePct);

      const availableBalance = Math.max(0, balance - exitReserve - balanceFloor - profitReserve);

      if (availableBalance <= 0) {
        log.info(
          `Balance ${balance}¢ at or below reserves ` +
          `(${balanceFloor}¢ floor + ${exitReserve}¢ exits + ${profitReserve}¢ profit reserve) — skipping execution`
        );
      } else if (availableBalance < balance) {
        log.debug(
          `Reserves: ${balanceFloor}¢ floor + ${exitReserve}¢ exits + ${profitReserve}¢ profit (${(config.bot.profitReservePct * 100).toFixed(0)}%), ` +
          `available: ${availableBalance}¢ of ${balance}¢`
        );
      }

      const maxOrdersPerTick = 3;
      let ordersPlacedThisTick = 0;

      for (const signal of actionableSignals) {
        if (ordersPlacedThisTick >= maxOrdersPerTick) {
          log.info(`Reached max orders per tick (${maxOrdersPerTick}), deferring remaining signals`);
          break;
        }

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

          const result = await executionService.executeSignal(
            signalRecord,
            availableBalance
          );

          // Update signal with result
          if (result.orderId) {
            ordersPlacedThisTick++;
            await db
              .update(signals)
              .set({ acted: true, orderId: result.orderId })
              .where(eq(signals.id, signal.id));
          } else {
            await db
              .update(signals)
              .set({ skipReason: result.skipReason ?? "execution skipped" })
              .where(eq(signals.id, signal.id));
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);

          // Stop placing orders this tick if we're out of money
          if (errMsg.includes("insufficient_balance") || errMsg.includes("insufficient balance")) {
            log.warn(`Insufficient balance — skipping remaining ${actionableSignals.length - actionableSignals.indexOf(signal) - 1} signals this tick`);
            await db
              .update(signals)
              .set({ skipReason: "insufficient balance" })
              .where(eq(signals.id, signal.id));
            break;
          }

          log.error(
            `Execution failed for ${signal.ticker}: ${errMsg}`
          );
          await db
            .update(signals)
            .set({
              skipReason: `execution error: ${errMsg}`,
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
