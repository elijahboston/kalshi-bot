import { getDb, markets, signals, positions, balanceHistory, eq, and, sql, desc } from "@kcb/db";
import type { Market } from "@kcb/db";
import { getConfig } from "@kcb/config";
import { KalshiClient, KalshiFeed } from "@kcb/kalshi-client";
import { bus, createLogger } from "../events";
import { registerTick, startLoop, stopLoop, getLoopState } from "./loop";
import { discoverMarkets } from "./discovery";
import { startFeed, stopFeed, subscribeToTickers } from "./feed";
import { EnsembleService, NwsService } from "@kcb/data";
import { ProbabilityEstimator, getEffectiveThreshold, evaluateTailGate, evaluateEntryGates, evaluateConfirmation } from "@kcb/signals";
import type { EstimateResult, ObservationAdjustment } from "@kcb/signals";
import { ExecutionService, computeKelly, recordExit, tickCooldowns, isTickerHeld, restoreAntiChurnState } from "@kcb/execution";
import { ReconciliationService } from "./reconciliation";
import { evaluateExit } from "./exit-eval";
import { uuid, now, seriesCategory } from "@kcb/shared";

const log = createLogger("orchestrator");

/**
 * A signal the bot intends to act on this tick (passed Phase 3's ladder/
 * confirmation filters). Lifted to module scope so the N2 argmax helper
 * ({@link selectArgmaxPerEvent}) and its unit test can share the shape.
 */
export interface ActionableSignal {
  id: string;
  ticker: string;
  seriesTicker: string;
  /** Event this market belongs to — drives the N2 argmax-per-event selection. */
  eventTicker: string;
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

/**
 * Argmax-per-event selection for CONTRARIAN entries (addendum N2 §3). The
 * event-coherent vector means at most ONE bracket of an event resolves YES, so
 * stacking several correlated contrarian NO bets across one event (Finding 3 —
 * up to 4 `no,no,no,no` per event) is structurally unsound. Among an event's
 * `buy_yes`/`buy_no` signals keep only the highest-edge one; demote the rest.
 *
 * `confirm_yes`/`confirm_no` are EXEMPT: multiple confirmations within an event
 * are jointly coherent (each says "this popular bracket resolves YES"), and at
 * most one can pay — they don't stack correlated risk the way contrarian bets do.
 *
 * Pure function (no DB / no mutation of inputs) so it's unit-testable in
 * isolation. The caller persists the demotions (recommendation→skip, acted=false,
 * skipReason) and drops the demoted signals from the execution list.
 *
 * @returns `kept` — the surviving signals (winners + all exempt confirmations);
 *   `demoted` — losing contrarian signals paired with the winner that beat them.
 */
export function selectArgmaxPerEvent(signals: ActionableSignal[]): {
  kept: ActionableSignal[];
  demoted: Array<{ signal: ActionableSignal; winner: ActionableSignal }>;
} {
  const isContrarian = (s: ActionableSignal) =>
    s.recommendation === "buy_yes" || s.recommendation === "buy_no";

  // Highest-edge contrarian signal per event. Ties resolve to the first seen
  // (stable — input order is the Phase 3 evaluation order).
  const winnerByEvent = new Map<string, ActionableSignal>();
  for (const s of signals) {
    if (!isContrarian(s)) continue;
    const cur = winnerByEvent.get(s.eventTicker);
    if (!cur || s.edge > cur.edge) winnerByEvent.set(s.eventTicker, s);
  }

  const kept: ActionableSignal[] = [];
  const demoted: Array<{ signal: ActionableSignal; winner: ActionableSignal }> = [];
  for (const s of signals) {
    if (!isContrarian(s)) {
      kept.push(s); // confirmations (and anything non-contrarian) pass through
      continue;
    }
    const winner = winnerByEvent.get(s.eventTicker)!;
    if (winner.id === s.id) kept.push(s);
    else demoted.push({ signal: s, winner });
  }
  return { kept, demoted };
}

/**
 * The exact skip-reason format written to demoted contrarian signals' DB rows
 * (addendum N2). Shared between the orchestrator and tests so the wording can't
 * drift. Cents shown to one decimal: e.g.
 * "event argmax: KXHIGHNY-26JUN05-B81 has higher edge (6.2¢ > 3.1¢)".
 */
export function argmaxSkipReason(winner: ActionableSignal, loser: ActionableSignal): string {
  return (
    `event argmax: ${winner.ticker} has higher edge ` +
    `(${(winner.edge * 100).toFixed(1)}¢ > ${(loser.edge * 100).toFixed(1)}¢)`
  );
}

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

    const estimates: Array<{
      market: Market;
      estimate: EstimateResult;
      sourceMix: Record<string, number>;
    }> = [];

    // Cache same-day observations per station to avoid redundant NWS calls
    const observationCache = new Map<string, ObservationAdjustment | null>();

    // Filter to estimable markets, then group by event (addendum N2). Tails
    // intentionally store bracketHigh=null (bracketLow is the threshold); only
    // brackets need both bounds. Markets missing station/category are dropped.
    const estimable = activeMarkets.filter((m) => {
      if (!m.stationId || !m.category) return false;
      if (m.bracketLow == null) return false;
      const isTail = m.marketType === "upper_tail" || m.marketType === "lower_tail";
      if (!isTail && m.bracketHigh == null) return false;
      return true;
    });

    const eventGroups = new Map<string, Market[]>();
    for (const m of estimable) {
      const arr = eventGroups.get(m.eventTicker);
      if (arr) arr.push(m);
      else eventGroups.set(m.eventTicker, [m]);
    }

    const eventCoherent = config.bot.eventCoherentEstimation;

    for (const group of eventGroups.values()) {
      // One ensemble fetch / observation lookup / price map per event. Use the
      // group's MIN forecast-horizon (the soonest-closing bracket) so a same-day
      // event uses the freshest sniper-window pool for the whole group.
      const ref = group[0]!;
      try {
        const horizons = group.map((m) => forecastHorizonHoursOf(m)).filter((h): h is number => h != null);
        const groupHorizonHours = horizons.length > 0 ? Math.min(...horizons) : undefined;

        const category = ref.category as Parameters<typeof ensembleService.getEnsembleValues>[2];
        // Source-attributed fetch (addendum N5): sourceMix records member counts
        // per model so the HRRR sniper gate and post-hoc win-rate splits can see
        // which sources actually fed each estimate.
        const { values: ensembleValues, sourceMix } =
          await ensembleService.getEnsembleWithSources(
            ref.stationId!,
            ref.targetDate!,
            category,
            groupHorizonHours
          );

        // Fetch same-day observation for temperature markets (improvement #4)
        let observation: ObservationAdjustment | undefined;
        if (
          ref.category === "high_temp" &&
          groupHorizonHours != null &&
          groupHorizonHours <= 24
        ) {
          if (!observationCache.has(ref.stationId!)) {
            const obs = await nwsService.getLatestObservation(ref.stationId!);
            observationCache.set(
              ref.stationId!,
              obs ? { observedTemp: obs.tempF, observedAt: obs.timestamp } : null
            );
          }
          observation = observationCache.get(ref.stationId!) ?? undefined;
        }

        // Book mid per ticker (N4) for the vector market-prior blend.
        const marketPrices = new Map<string, number>();
        for (const m of group) {
          const mid = marketMid(m);
          if (mid != null) marketPrices.set(m.ticker, mid);
        }

        if (eventCoherent) {
          // Event-coherent path (N2): one shared distribution → a P(YES) vector
          // that sums to the partition's coverage. Push each market's result into
          // `estimates` exactly as the legacy loop did (Phase 3 unchanged).
          const eventResults = await estimator.estimateEvent(
            group,
            ensembleValues,
            observation,
            marketPrices,
            sourceMix
          );
          for (const m of group) {
            const est = eventResults.get(m.ticker);
            if (est) estimates.push({ market: m, estimate: est, sourceMix });
          }
        } else {
          // Legacy per-market path (kill switch off): byte-identical to the
          // prior behavior — each market estimated independently.
          for (const m of group) {
            try {
              const estimate = await estimator.estimate(
                m,
                ensembleValues,
                observation,
                marketPrices.get(m.ticker),
                sourceMix
              );
              estimates.push({ market: m, estimate, sourceMix });
            } catch (err) {
              log.warn(
                `Estimation failed for ${m.ticker}: ${err instanceof Error ? err.message : err}`
              );
            }
          }
        }
      } catch (err) {
        log.warn(
          `Estimation failed for event ${ref.eventTicker}: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    if (estimates.length > 0) {
      log.info(`Estimated ${estimates.length} market(s)`);
    }

    // Phase 3: Evaluate — Compare estimates to prices, generate signals
    log.debug("Phase 3: Signal evaluation");

    const actionableSignals: ActionableSignal[] = [];

    for (const { market, estimate, sourceMix } of estimates) {
      // Skip markets with no price data — placing orders at the 50¢ default
      // creates resting orders that never fill and churn through cancel/re-place cycles.
      // Price is the book mid when both sides are quoted (addendum N4 — last trade
      // can be stale on thin markets and manufactures phantom edge), else last trade.
      const midPrice = marketMid(market);
      if (midPrice == null) {
        log.debug(`Skipping ${market.ticker}: no price data yet`);
        continue;
      }

      const marketPrice = midPrice;

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
      let recommendation:
        | "buy_yes"
        | "buy_no"
        | "confirm_yes"
        | "confirm_no"
        | "scout"
        | "skip" = "skip";
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

      // True only when the market is genuinely inside an enabled sniper window
      // (not the degenerate "sniper disabled / horizon unknown" cases above).
      // Used by the HRRR data-quality gate and the confirmation pathway, both
      // of which assume near-close market conditions.
      const inActualSniperWindow =
        sniperHorizon > 0 &&
        forecastHorizonHours != null &&
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

      // Win-rate-80 entry gates. The bot loses by fading confident markets
      // (buy_no into a ≥65¢ market won 19.4% / −$85), by acting on large
      // model/market disagreement (|edge|>25pp ran 47%), and by trading
      // coin-flip 45-55¢ markets (48.7% win). These hard gates strip that
      // contra-market posture. See improvements/win-rate-80-plan-2026-06-05.md
      // (#1/#7) and improvements/win-rate-80-addendum-2026-06-05.md (N7).
      const entryGates = side
        ? evaluateEntryGates({
            side,
            estimatedProb: estimate.probability,
            marketPrice,
            stationId: market.stationId,
            config: {
              disagreementCap: config.bot.disagreementCap,
              noSideMaxMarketPrice: config.bot.noSideMaxMarketPrice,
              yesSideMinMarketPrice: config.bot.yesSideMinMarketPrice,
              coinFlipZoneLow: config.bot.coinFlipZoneLow,
              coinFlipZoneHigh: config.bot.coinFlipZoneHigh,
              disabledStations: config.bot.disabledStations,
            },
          })
        : { allowed: true as const };

      if (!side || edge <= 0) {
        skipReason = "no edge";
      } else if (!inSniperWindow) {
        recommendation = "scout";
        skipReason = `scout mode (${forecastHorizonHours!.toFixed(1)}h > ${sniperHorizon}h sniper window)`;
      } else if (
        config.bot.requireHrrrInSniper &&
        inActualSniperWindow &&
        (sourceMix["hrrr"] ?? 0) === 0
      ) {
        // Data-quality gate (addendum N5): HRRR is 40-70% of the intended pool
        // inside the sniper window; its silent absence reshapes every probability.
        // Contrarian entries require it. Confirmation entries (below) deliberately
        // don't — their information source is the market itself. `cached`-labeled
        // pools count as hrrr-absent: N6's sniper-entry refresh means a healthy
        // HRRR would have been blended fresh by now.
        skipReason = "hrrr unavailable in sniper window";
      } else if (edge < edgeThreshold) {
        skipReason =
          stationSurcharge > 0
            ? `edge ${(edge * 100).toFixed(1)}¢ < threshold ${(baseThreshold * 100).toFixed(1)}¢ + ${(stationSurcharge * 100).toFixed(0)}¢ ${market.stationId} surcharge`
            : `edge ${(edge * 100).toFixed(1)}¢ < threshold ${(edgeThreshold * 100).toFixed(1)}¢`;
      } else if (estimate.confidence < config.bot.minConfidence) {
        skipReason = `confidence ${estimate.confidence.toFixed(2)} < ${config.bot.minConfidence}`;
      } else if (!tailGate.allowed) {
        skipReason = tailGate.reason ?? "tail gate blocked";
      } else if (!entryGates.allowed) {
        skipReason = entryGates.reason ?? "entry gate blocked";
      } else {
        recommendation = side === "yes" ? "buy_yes" : "buy_no";
      }

      // Confirmation-mode pathway (win-rate-80 plan #2): when the contrarian
      // ladder skips but the market is highly convinced (≥80¢) and the model
      // agrees on direction, take the popular side flat. Replay 2026-04→06:
      // YES arm 15/15 (+7.1¢/contract), NO arm 95.3%. Deliberately NOT routed
      // through evaluateEntryGates — its concordance cap would veto legitimate
      // agreement trades (e.g. est 0.55 / market 0.97). Station health and the
      // sniper window still apply; tails are allowed (the confirmationMaxEntryPrice
      // cap and the market-conviction filter are the guards there). Execution
      // bypasses the Kelly EV-sign gate for confirm_* and sizes flat — see
      // executeSignal.
      if (recommendation === "skip" && inActualSniperWindow) {
        const confirmation = evaluateConfirmation({
          estimatedProb: estimate.probability,
          marketPrice,
          config: {
            enabled: config.bot.confirmationModeEnabled,
            minMarketConviction: config.bot.confirmationMinMarketConviction,
            minModelAgreement: config.bot.confirmationMinModelAgreement,
            maxEntryPrice: config.bot.confirmationMaxEntryPrice,
          },
        });
        const stationDisabled =
          market.stationId != null &&
          config.bot.disabledStations.includes(market.stationId);
        if (confirmation.fire && !stationDisabled) {
          side = confirmation.side;
          // Held-side model edge, recorded for telemetry only — confirmation
          // trades claim market edge, not model edge, so this may be ≤ 0.
          edge =
            confirmation.side === "yes"
              ? estimate.probability - marketPrice
              : marketPrice - estimate.probability;
          recommendation =
            confirmation.side === "yes" ? "confirm_yes" : "confirm_no";
          skipReason = null;
        }
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
          eventTicker: market.eventTicker,
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

    // Phase 3 (argmax-per-event, addendum N2 §3): an event-coherent vector means
    // at most one bracket resolves YES, so the bot must not stack several
    // correlated contrarian bets across one event (Finding 3). Keep only the
    // highest-edge buy_yes/buy_no per event; demote the rest to skip. Confirmation
    // signals are exempt (jointly coherent). Gated by eventCoherentEstimation so
    // the legacy per-market path is byte-identical when the kill switch is off.
    if (config.bot.eventCoherentEstimation && actionableSignals.length > 0) {
      const { demoted } = selectArgmaxPerEvent(actionableSignals);
      for (const { signal, winner } of demoted) {
        const reason = argmaxSkipReason(winner, signal);
        await db
          .update(signals)
          .set({ recommendation: "skip", acted: false, skipReason: reason })
          .where(eq(signals.id, signal.id));
        log.debug(`${signal.ticker}: demoted by ${reason}`);
      }
      if (demoted.length > 0) {
        const demotedIds = new Set(demoted.map((d) => d.signal.id));
        for (let i = actionableSignals.length - 1; i >= 0; i--) {
          if (demotedIds.has(actionableSignals[i]!.id)) actionableSignals.splice(i, 1);
        }
        log.info(
          `Event argmax demoted ${demoted.length} correlated contrarian signal(s) across ${
            new Set(demoted.map((d) => d.signal.eventTicker)).size
          } event(s)`
        );
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
            // Winner-hold carve-out (addendum N8): let near-settled winners ride
            // instead of selling at ~89¢ for a position that pays 100¢ at close.
            exitHoldWinnerPrice: config.bot.exitHoldWinnerPrice,
            exitHoldWinnerMaxHoursToClose: config.bot.exitHoldWinnerMaxHoursToClose,
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

/**
 * Forecast horizon in hours for a market: time to closeTime when present, else
 * to end-of-target-day (23:59Z). Floored at 0. Returns undefined when neither
 * closeTime nor targetDate is set. Used to pick a group's min horizon for the
 * ensemble fetch (addendum N2) and mirrors the per-market computation Phase 3
 * still does inline for the sniper-window gate.
 */
function forecastHorizonHoursOf(market: Market): number | undefined {
  if (market.closeTime) {
    return Math.max(0, (new Date(market.closeTime).getTime() - Date.now()) / (1000 * 60 * 60));
  }
  if (market.targetDate) {
    return Math.max(
      0,
      (new Date(market.targetDate + "T23:59:00Z").getTime() - Date.now()) / (1000 * 60 * 60)
    );
  }
  return undefined;
}

/**
 * Market-implied P(YES) in [0,1]: book mid when both sides are quoted
 * (addendum N4 — the last trade can be arbitrarily stale on thin markets and
 * manufactures phantom edge), falling back to the last trade price. Returns
 * undefined when no price information exists at all.
 */
function marketMid(market: Market): number | undefined {
  if (market.yesBid != null && market.yesAsk != null) {
    return (market.yesBid + market.yesAsk) / 200;
  }
  return market.lastYesPrice != null ? market.lastYesPrice / 100 : undefined;
}

export { startLoop as start, stopLoop as stop, getLoopState as getState, stopFeed };
