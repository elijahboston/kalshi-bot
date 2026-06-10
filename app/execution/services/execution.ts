import { getConfig } from "@kcb/config";
import { getDb, orders, signals as signalsTable, positions, markets, eq, and, sql } from "@kcb/db";
import type { Position, Signal } from "@kcb/db";
import { KalshiClient } from "@kcb/kalshi-client";
import { bus, createLogger } from "@kcb/engine";

const log = createLogger("execution");

/**
 * Result of an `executeSignal` call. Exactly one of `orderId` and `skipReason`
 * is non-null. `skipReason` is what the orchestrator persists to
 * `signals.skip_reason` so we can attribute which guard fired in the DB.
 */
export interface ExecuteSignalResult {
  orderId: string | null;
  skipReason: string | null;
}

const skip = (reason: string): ExecuteSignalResult => ({
  orderId: null,
  skipReason: reason,
});
const placed = (orderId: string): ExecuteSignalResult => ({
  orderId,
  skipReason: null,
});

/** Per-ticker cooldown tracking: ticker → remaining ticks */
const cooldownMap = new Map<string, number>();

/** Tickers to hold until settlement — skip all exit evaluation */
const holdUntilSettlement = new Set<string>();

/** Track tickers where the last exit was a loss — requires higher edge to re-enter */
const recentLossMap = new Map<string, { lossAt: number; lossPct: number }>();

/** Whether we've rebuilt state from DB after a restart */
let stateRestored = false;

/**
 * Rebuild cooldown and loss state from recent orders in the DB.
 * Called on first tick after a process restart to survive watch-mode reloads.
 */
export async function restoreAntiChurnState(): Promise<void> {
  if (stateRestored) return;
  stateRestored = true;

  const config = getConfig();
  const db = getDb();
  const cooldownWindowMs = config.bot.exitCooldownTicks * config.bot.tickIntervalSec * 1000;
  const cooldownCutoff = new Date(Date.now() - cooldownWindowMs).toISOString();
  const lossCutoff = new Date(Date.now() - 2 * 60 * 60_000).toISOString(); // 2h

  // Find recent sell orders (exits) to rebuild cooldowns
  const recentSells = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.action, "sell"),
        eq(orders.status, "filled"),
        sql`${orders.createdAt} > ${cooldownCutoff}`
      )
    );

  for (const sell of recentSells) {
    const elapsedMs = Date.now() - new Date(sell.createdAt).getTime();
    const elapsedTicks = Math.floor(elapsedMs / (config.bot.tickIntervalSec * 1000));
    const remainingTicks = config.bot.exitCooldownTicks - elapsedTicks;

    if (remainingTicks > 0) {
      cooldownMap.set(sell.ticker, remainingTicks);
    }

    // Check if this sell was a losing exit (sold for less than avg entry)
    if (sell.createdAt > lossCutoff) {
      // Find the most recent buy for this ticker before this sell
      const [lastBuy] = await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.ticker, sell.ticker),
            eq(orders.action, "buy"),
            eq(orders.status, "filled"),
            sql`${orders.createdAt} < ${sell.createdAt}`
          )
        )
        .orderBy(sql`${orders.createdAt} DESC`)
        .limit(1);

      if (lastBuy && sell.limitPrice < lastBuy.limitPrice) {
        const lossPct = (sell.limitPrice - lastBuy.limitPrice) / lastBuy.limitPrice;
        recentLossMap.set(sell.ticker, {
          lossAt: new Date(sell.createdAt).getTime(),
          lossPct,
        });
      }
    }
  }

  const cooldowns = [...cooldownMap.entries()].map(([t, r]) => `${t}:${r}`);
  const losses = [...recentLossMap.keys()];
  if (cooldowns.length > 0 || losses.length > 0) {
    log.info(
      `Restored anti-churn state: ${cooldowns.length} cooldown(s)` +
      (cooldowns.length > 0 ? ` [${cooldowns.join(", ")}]` : "") +
      `, ${losses.length} loss flag(s)` +
      (losses.length > 0 ? ` [${losses.join(", ")}]` : "")
    );
  }
}

/** Record that a ticker was just exited; starts its cooldown timer. */
export function recordExit(ticker: string, wasLoss?: boolean, lossPct?: number): void {
  const config = getConfig();
  cooldownMap.set(ticker, config.bot.exitCooldownTicks);
  if (wasLoss) {
    recentLossMap.set(ticker, { lossAt: Date.now(), lossPct: lossPct ?? 0 });
  }
}

/** Check if a ticker had a recent loss exit. Returns the loss info or null. */
export function getRecentLoss(ticker: string): { lossAt: number; lossPct: number } | null {
  const entry = recentLossMap.get(ticker);
  if (!entry) return null;
  // Expire after 2 hours
  if (Date.now() - entry.lossAt > 2 * 60 * 60_000) {
    recentLossMap.delete(ticker);
    return null;
  }
  return entry;
}

/** Reset loss tracking (for testing). */
export function resetLossTracking(): void {
  recentLossMap.clear();
}

/** Mark a ticker to hold until settlement — no exits will be attempted. */
export function holdTicker(ticker: string): void {
  holdUntilSettlement.add(ticker);
}

/** Check if a ticker is on hold. */
export function isTickerHeld(ticker: string): boolean {
  return holdUntilSettlement.has(ticker);
}

/** Decrement all cooldown counters by 1 (call at tick start). */
export function tickCooldowns(): void {
  for (const [ticker, remaining] of cooldownMap) {
    if (remaining <= 1) {
      cooldownMap.delete(ticker);
    } else {
      cooldownMap.set(ticker, remaining - 1);
    }
  }
}

/** Get remaining cooldown ticks for a ticker (0 = no cooldown). Exported for testing. */
export function getCooldown(ticker: string): number {
  return cooldownMap.get(ticker) ?? 0;
}

/** Reset all cooldowns (for testing). */
export function resetCooldowns(): void {
  cooldownMap.clear();
}

/** Reset restored flag (for testing). */
export function resetRestoredFlag(): void {
  stateRestored = false;
}

export class ExecutionService {
  private kalshi: KalshiClient;

  constructor(kalshiClient?: KalshiClient) {
    this.kalshi = kalshiClient || new KalshiClient();
  }

  /**
   * Execute a signal: compute position size via Kelly, place order.
   * Returns `{orderId}` on success, `{skipReason}` on any guard failure.
   * The specific skip reason is what gets persisted to `signals.skip_reason`
   * so we can attribute which guard is biting most often.
   */
  async executeSignal(signal: Signal, balance: number): Promise<ExecuteSignalResult> {
    const config = getConfig();

    if (signal.recommendation === "skip" || !signal.side) {
      return skip("recommendation=skip or missing side");
    }

    // Check position limits
    const db = getDb();
    const openPositions = await db.select().from(positions);

    if (openPositions.length >= config.bot.maxOpenPositions) {
      const reason = `max positions reached (${openPositions.length}/${config.bot.maxOpenPositions})`;
      log.info(`Skipping ${signal.ticker}: ${reason}`);
      return skip(reason);
    }

    // Authoritative "already hold this ticker?" check against the orders table.
    // Computes net held quantity as sum(buy.filled) - sum(sell.filled) across all
    // non-cancelled orders, regardless of age. This is correct even when the
    // positions table is lagging on reconciliation and whether the last buy was
    // 5 minutes or 5 hours ago. Covers both resting/partial buys (filled_quantity
    // may be 0 but any open-side buy still counts as intent to hold).
    const [netRow] = await db
      .select({
        netHeld: sql<number>`COALESCE(SUM(
          CASE
            WHEN ${orders.action} = 'buy' THEN
              CASE WHEN ${orders.status} IN ('open', 'partial') THEN ${orders.quantity}
                   ELSE ${orders.filledQuantity} END
            ELSE -${orders.filledQuantity}
          END
        ), 0)`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.ticker, signal.ticker),
          sql`${orders.status} IN ('open', 'partial', 'filled')`
        )
      );
    const netHeld = Number(netRow?.netHeld ?? 0);
    if (netHeld > 0) {
      const reason = `already hold ${netHeld} contract(s)`;
      log.info(`Skipping ${signal.ticker}: ${reason} per orders table`);
      return skip(reason);
    }

    // Post-exit cooldown: skip if ticker was recently exited
    const remaining = getCooldown(signal.ticker);
    if (remaining > 0) {
      const reason = `cooldown (${remaining} tick(s) remaining)`;
      log.info(`Skipping ${signal.ticker}: ${reason}`);
      return skip(reason);
    }

    // Confirmation-mode entry (win-rate-80-plan-2026-06-05.md #2): the model
    // intentionally disagrees with paying a confident market 80–93¢; we trust
    // the market here. These signals BYPASS the Kelly EV-sign gate and the
    // minContractPrice floor, size flat, and are capped by confirmationMaxEntryPrice.
    const isConfirmation =
      signal.recommendation === "confirm_yes" || signal.recommendation === "confirm_no";

    // Loss-based re-entry guard: require 1.5x normal edge after a recent loss exit.
    // This prevents the buy-exit-rebuy churn loop where the bot keeps re-entering
    // a position that the market is moving against.
    //
    // Confirmation entries are exempt: their model edge is ≤ 0 by construction
    // (entry is at/above market price), so an edge-based bar is unsatisfiable —
    // one loss exit permanently locked the ticker out for the 2h loss window.
    // Their re-entry bar is the confirmation gate itself re-firing (market
    // conviction back ≥ minMarketConviction and price ≤ cap). Post-regime data
    // 2026-06-10: 12/15 recent-loss-blocked signals would have won.
    const recentLoss = getRecentLoss(signal.ticker);
    if (recentLoss && !isConfirmation) {
      const requiredEdge = signal.edgeThreshold * 1.5;
      if (signal.edge < requiredEdge) {
        const reason =
          `recent-loss elevated edge (${(signal.edge * 100).toFixed(1)}¢ < ` +
          `${(requiredEdge * 100).toFixed(1)}¢ required after loss)`;
        log.info(`Skipping ${signal.ticker}: ${reason}`);
        return skip(reason);
      }
      log.info(`${signal.ticker}: allowing re-entry after loss (edge ${(signal.edge * 100).toFixed(1)}¢ >= ${(requiredEdge * 100).toFixed(1)}¢)`);
    }

    const side = signal.side as "yes" | "no";

    // Market-book lookup (addendum N4): price the entry against what we'd
    // actually pay — the ask for YES, 100−bid for NO — instead of the stale
    // last-trade price. Falls back to last-trade-derived pricing when the book
    // side we need is absent (thin market / no ticker yet).
    const [book] = await db
      .select({
        yesBid: markets.yesBid,
        yesAsk: markets.yesAsk,
        lastYesPrice: markets.lastYesPrice,
      })
      .from(markets)
      .where(eq(markets.ticker, signal.ticker))
      .limit(1);
    const yesBid = book?.yesBid ?? null;
    const yesAsk = book?.yesAsk ?? null;

    // Spread guard: a wide book means the last-trade edge is phantom and a live
    // limit at the crossing price would fill only on adverse selection. Skip
    // when both sides are present and the spread exceeds the configured max.
    // Applies to confirmation entries too. 0 = disabled.
    if (
      config.bot.maxSpreadCents > 0 &&
      yesBid != null &&
      yesAsk != null &&
      yesAsk - yesBid > config.bot.maxSpreadCents
    ) {
      const spread = yesAsk - yesBid;
      const reason = `spread ${spread}¢ > max ${config.bot.maxSpreadCents}¢`;
      log.info(`Skipping ${signal.ticker}: ${reason}`);
      return skip(reason);
    }

    // Crossing-price entry (addendum N4): YES pays the ask, NO pays 100−bid.
    // When the relevant book side is missing, fall back to the prior
    // last-trade-derived pricing (Math.round(marketPrice·100) for YES / inverse
    // for NO). Price is in cents, clamped to a tradable [1, 99].
    const lastTradeYes = Math.round(signal.marketPrice * 100);
    const lastTradeNo = Math.round((1 - signal.marketPrice) * 100);
    const rawPrice = side === "yes"
      ? (yesAsk ?? lastTradeYes)
      : (yesBid != null ? 100 - yesBid : lastTradeNo);
    const price = Math.max(1, Math.min(99, rawPrice));

    // Kelly criterion sizing. computeKelly gates the EV sign for the regular
    // path; the confirmation path deliberately skips that gate (see above).
    const kellyFraction = computeKelly(
      signal.estimatedProb,
      signal.marketPrice,
      side
    );

    const cappedKelly = Math.min(kellyFraction, config.bot.maxKellyFraction);
    if (cappedKelly <= 0 && !isConfirmation) {
      const reason = "Kelly fraction <= 0 (no positive EV)";
      log.info(`Skipping ${signal.ticker}: ${reason}`);
      return skip(reason);
    }

    // Confirmation entry-price cap: re-check at execution time because the book
    // may have moved since signal eval. Keeps the minimum payoff ≥ (1 − cap).
    if (isConfirmation) {
      const capCents = Math.round(config.bot.confirmationMaxEntryPrice * 100);
      if (price > capCents) {
        const reason = `confirmation entry ${price}¢ > cap ${capCents}¢`;
        log.info(`Skipping ${signal.ticker}: ${reason}`);
        return skip(reason);
      }
    }

    // Compute contracts. Flat sizing (when configured) bypasses Kelly's dollar
    // amount but still requires cappedKelly > 0 above — Kelly gates the EV sign
    // (except confirmation entries). Confirmation entries size flat at
    // confirmationBetSizeCents. High-confidence signals scale up to
    // highConfidenceBetSizeCents when their confidence meets the threshold
    // (per 2026-05-23 perf analysis).
    const isHighConfidence =
      config.bot.highConfidenceThreshold > 0 &&
      signal.confidence >= config.bot.highConfidenceThreshold &&
      config.bot.highConfidenceBetSizeCents > 0;

    // Confidence-scaled %-of-balance sizing (2026-06-09). When enabled it is the
    // sizing method for EVERY entry — a confidence-ramped fraction of available
    // balance (`balance` here is already net of exit reserve / floor / profit
    // reserve, set in the orchestrator) — taking precedence over the flat /
    // confirmation / high-confidence / Kelly dollar paths. The EV-sign gate
    // above still applies to non-confirmation entries.
    const pctMode = config.bot.confidenceSizePctEnabled;
    let betAmount: number;
    let sizingPct = 0;
    let sizingFloored = false;
    if (pctMode) {
      sizingPct = confidenceSizedPct(
        signal.confidence,
        config.bot.confidenceSizeFloorConfidence,
        config.bot.confidenceSizeMinPct,
        config.bot.confidenceSizeMaxPct
      );
      const rawBet = Math.floor(balance * sizingPct);
      // Floor the wager to minBetSizeCents ($5): a low-confidence / small-balance
      // bet (1% of a sub-$500 bankroll is < $5) earns too little to clear Kalshi
      // fees. minBetSizeCents=0 disables the floor. The minBetSizeCents *skip*
      // guard below stays bypassed in pct mode — integer division at 80-93¢ makes
      // exact ≥floor spend impossible, so we floor the budget and still place.
      betAmount = Math.max(rawBet, config.bot.minBetSizeCents);
      sizingFloored = betAmount > rawBet;
    } else {
      const flatSize = isConfirmation
        ? config.bot.confirmationBetSizeCents
        : isHighConfidence
          ? config.bot.highConfidenceBetSizeCents
          : config.bot.flatBetSizeCents;
      betAmount = flatSize > 0
        ? flatSize
        : Math.floor(balance * cappedKelly);
    }

    // Per-ticker exposure cap. In pct mode it scales to a fraction of available
    // balance (when maxExposurePctOfBalance > 0) so it tracks the bankroll
    // instead of the fixed $10 tuned for the old $5 flats; otherwise the fixed
    // cap stands. The per-order contract cap likewise scales: in pct mode the
    // bet is already bounded by the exposure cap, so the fixed
    // maxContractsPerOrder must not clip it — derive the ceiling from the
    // (scaled) exposure cap instead.
    const effectiveMaxExposure =
      pctMode && config.bot.maxExposurePctOfBalance > 0
        ? Math.round(balance * config.bot.maxExposurePctOfBalance)
        : config.bot.maxExposurePerTicker;
    const effectiveMaxContracts =
      pctMode && config.bot.maxExposurePctOfBalance > 0
        ? Math.floor(effectiveMaxExposure / price)
        : config.bot.maxContractsPerOrder;

    let contracts = Math.min(
      Math.floor(betAmount / price),
      effectiveMaxContracts
    );

    if (pctMode) {
      log.info(
        `${signal.ticker}: pct-size conf ${signal.confidence.toFixed(2)} → ` +
        `${(sizingPct * 100).toFixed(1)}% of ${balance}¢ = ${betAmount}¢` +
        `${sizingFloored ? ` (floored to ${config.bot.minBetSizeCents}¢ min)` : ""} → ` +
        `${contracts} @ ${price}¢ (exposure cap ${effectiveMaxExposure}¢)`
      );
    }

    if (contracts <= 0) {
      const reason = `0 contracts at ${price}¢ (betAmount=${betAmount}¢)`;
      log.info(`Skipping ${signal.ticker}: ${reason}`);
      return skip(reason);
    }

    // Minimum contract price filter: skip cheap lottery tickets — but bypass
    // for high-confidence AND confirmation signals. Per 2026-05-26 audit, the
    // 15¢ floor was silently dropping every actionable tail signal (1,807 over
    // 11 days, some at conf=0.92 / edge=27¢ on 1¢ markets — i.e., the highest-EV
    // trades on the board). The Kelly EV-sign gate above already filters
    // genuinely bad bets; the price floor was only a safety net against
    // low-confidence "lottery ticket" bets that this gate doesn't catch.
    // Confirmation entries pay 80–93¢ by construction, so they never trip this
    // floor in practice, but we bypass explicitly to keep the intent clear.
    const bypassPriceFloor = isHighConfidence || isConfirmation;
    if (price < config.bot.minContractPrice && !bypassPriceFloor) {
      const reason = `price ${price}¢ < min ${config.bot.minContractPrice}¢ (low-conf lottery filter)`;
      log.info(`Skipping ${signal.ticker}: ${reason}`);
      return skip(reason);
    }
    if (price < config.bot.minContractPrice && bypassPriceFloor) {
      log.info(
        `${signal.ticker}: bypassing minContractPrice (${price}¢ < ${config.bot.minContractPrice}¢) — ` +
        (isConfirmation
          ? "confirmation entry"
          : `confidence ${signal.confidence.toFixed(2)} >= ${config.bot.highConfidenceThreshold}`)
      );
    }

    // Per-ticker exposure limit — use current position cost basis (not historical orders)
    const [existingPosition] = await db
      .select({ costBasis: positions.costBasis })
      .from(positions)
      .where(eq(positions.ticker, signal.ticker))
      .limit(1);
    const currentExposure = existingPosition?.costBasis ?? 0;
    const remainingRoom = effectiveMaxExposure - currentExposure;
    if (remainingRoom <= 0) {
      const reason = `at max exposure ${currentExposure}¢/${effectiveMaxExposure}¢`;
      log.info(`Skipping ${signal.ticker}: ${reason}`);
      return skip(reason);
    }
    // Size down contracts to fit within exposure limit
    contracts = Math.min(contracts, Math.floor(remainingRoom / price));
    if (contracts <= 0) {
      const reason = `price ${price}¢ exceeds remaining exposure room ${remainingRoom}¢`;
      log.info(`Skipping ${signal.ticker}: ${reason}`);
      return skip(reason);
    }

    // Per-EVENT exposure cap: the per-ticker cap above can't see that several
    // tickers in one event are a single correlated thesis (NO on adjacent
    // brackets + YES on the center bracket all lose together on a 1-bracket
    // forecast miss). Cap the summed cost basis across every open position in
    // the signal's event at a fraction of available balance. 0 = disabled.
    if (config.bot.maxEventExposurePctOfBalance > 0) {
      const [marketRow] = await db
        .select({ eventTicker: markets.eventTicker })
        .from(markets)
        .where(eq(markets.ticker, signal.ticker))
        .limit(1);
      const eventTicker = marketRow?.eventTicker ?? null;
      if (eventTicker) {
        const [expRow] = await db
          .select({ s: sql<number>`COALESCE(SUM(${positions.costBasis}), 0)` })
          .from(positions)
          .innerJoin(markets, eq(positions.ticker, markets.ticker))
          .where(eq(markets.eventTicker, eventTicker));
        const eventExposure = Number(expRow?.s ?? 0);
        const eventCap = Math.round(balance * config.bot.maxEventExposurePctOfBalance);
        const eventRoom = eventCap - eventExposure;
        if (eventRoom <= 0) {
          const reason = `event exposure ${eventExposure}¢/${eventCap}¢ (${eventTicker})`;
          log.info(`Skipping ${signal.ticker}: ${reason}`);
          return skip(reason);
        }
        const fitted = Math.min(contracts, Math.floor(eventRoom / price));
        if (fitted <= 0) {
          const reason =
            `price ${price}¢ exceeds remaining event exposure room ${eventRoom}¢ (${eventTicker})`;
          log.info(`Skipping ${signal.ticker}: ${reason}`);
          return skip(reason);
        }
        if (fitted < contracts) {
          log.info(
            `${signal.ticker}: sized down ${contracts} → ${fitted} contracts by event cap ` +
            `(${eventExposure}¢ held of ${eventCap}¢ across ${eventTicker})`
          );
          contracts = fitted;
        }
      }
    }

    // Minimum bet size filter. When the Kelly- and cap-sized spend falls below
    // the floor, skip the signal entirely rather than placing a micro-position
    // that doesn't move the needle. 0 = disabled.
    //
    // Confirmation entries are exempt: at 80-93¢ contract prices,
    // floor(confirmationBetSizeCents / price) × price is structurally below the
    // flat target (e.g. 5 × 91¢ = 455¢ < 500¢ for ANY price that doesn't divide
    // it evenly), so the guard would silently reject every confirmation trade —
    // caught live 2026-06-05, first tick after the pathway shipped. The guard's
    // intent is to kill Kelly dust-bets, not deliberately-flat market-follow
    // entries whose size is already pinned by config.
    // pct mode is also exempt from the *skip*: the wager budget is already
    // floored to minBetSizeCents above, but integer division at 80-93¢ leaves
    // actualSpend a few cents under it (5 × 87¢ = 435 < 500) — the same rounding
    // quirk confirmation entries hit. Skipping here would drop a legitimately
    // floored wager; the floor on betAmount is what enforces the $5 minimum.
    const actualSpend = contracts * price;
    if (
      !isConfirmation &&
      !pctMode &&
      config.bot.minBetSizeCents > 0 &&
      actualSpend < config.bot.minBetSizeCents
    ) {
      const reason =
        `bet ${actualSpend}¢ (${contracts} × ${price}¢) < min ${config.bot.minBetSizeCents}¢`;
      log.info(`Skipping ${signal.ticker}: ${reason}`);
      return skip(reason);
    }

    // kellyFraction stored on the order row: confirmation entries store 0 (not
    // null) to mark "sizing deliberately bypassed Kelly" — null already means
    // "exit / not Kelly-sized" elsewhere, so 0 keeps confirmation entries
    // distinguishable from exits while signalling no-Kelly sizing.
    const recordedKelly = isConfirmation ? 0 : cappedKelly;

    const tierTag = pctMode
      ? ` PCT(${(sizingPct * 100).toFixed(1)}%)`
      : isConfirmation
        ? ` CONFIRM`
        : isHighConfidence
          ? ` HIGH-CONF(${signal.confidence.toFixed(2)})`
          : "";
    log.info(
      `Executing:${tierTag} ${side.toUpperCase()} ${signal.ticker} × ${contracts} @ ${price}¢ ` +
      `(Kelly: ${cappedKelly.toFixed(4)}, edge: ${(signal.edge * 100).toFixed(1)}¢, ` +
      `bet: ${betAmount}¢)`
    );

    if (config.bot.dryRun) {
      // Paper-fill model (addendum N10): the dry-run fill executes at `price`,
      // which is now the book's crossing price (ask for YES / 100−bid for NO)
      // computed above — honest slippage vs the old zero-spread last-trade fill.
      const orderId = `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      await db.insert(orders).values({
        orderId,
        ticker: signal.ticker,
        action: "buy",
        side,
        limitPrice: price,
        quantity: contracts,
        filledQuantity: contracts,
        status: "filled",
        signalId: signal.id,
        dryRun: true,
        kellyFraction: recordedKelly,
        createdAt: now,
        updatedAt: now,
      });

      bus.emit("order:placed", {
        orderId,
        ticker: signal.ticker,
        action: "buy",
        side,
        price,
        quantity: contracts,
        dryRun: true,
      });

      return placed(orderId);
    }

    // Real order
    const result = await this.kalshi.createOrder({
      ticker: signal.ticker,
      action: "buy",
      side,
      type: "limit",
      count: contracts,
      ...(side === "yes"
        ? { yes_price: price }
        : { no_price: price }),
    });

    const now = new Date().toISOString();
    await db.insert(orders).values({
      orderId: result.order.order_id,
      ticker: signal.ticker,
      action: "buy",
      side,
      limitPrice: price,
      quantity: contracts,
      filledQuantity: 0,
      status: "open",
      signalId: signal.id,
      dryRun: false,
      kellyFraction: recordedKelly,
      createdAt: now,
      updatedAt: now,
    });

    bus.emit("order:placed", {
      orderId: result.order.order_id,
      ticker: signal.ticker,
      action: "buy",
      side,
      price,
      quantity: contracts,
      dryRun: false,
    });

    return placed(result.order.order_id);
  }

  /**
   * Exit a position by placing a sell order for the full quantity.
   * @param currentYesPrice Current market yes price in cents (1-99)
   */
  async executeExit(position: Position, reason: string, currentYesPrice: number): Promise<string | null> {
    const config = getConfig();
    const db = getDb();
    const side = position.side as "yes" | "no";

    // Guard: skip if there's already an open/partial sell order for this ticker.
    // Without this check, the bot places a new sell every tick before reconciliation
    // updates the position, causing massive over-selling into new short positions.
    const [pendingSell] = await db
      .select({ orderId: orders.orderId })
      .from(orders)
      .where(
        and(
          eq(orders.ticker, position.ticker),
          eq(orders.action, "sell"),
          sql`${orders.status} IN ('open', 'partial')`
        )
      )
      .limit(1);

    if (pendingSell) {
      log.info(`Skipping exit for ${position.ticker}: sell order ${pendingSell.orderId} already pending`);
      return null;
    }

    // Authoritative net-held check against the orders table — the same source
    // of truth the buy path uses. The pending-sell guard above is blind in
    // dry-run mode (paper sells fill instantly, never 'open'), and the
    // positions table lags reconciliation by up to a tick; on 2026-06-05 that
    // combination double-sold every exited confirmation position into a
    // phantom short (buy 6 → sell 6 → sell 6 again). Sell at most what the
    // ledger says we actually hold.
    const [netRow] = await db
      .select({
        netHeld: sql<number>`COALESCE(SUM(
          CASE
            WHEN ${orders.action} = 'buy' THEN ${orders.filledQuantity}
            ELSE -${orders.filledQuantity}
          END
        ), 0)`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.ticker, position.ticker),
          sql`${orders.status} IN ('open', 'partial', 'filled')`
        )
      );
    const netHeld = Number(netRow?.netHeld ?? 0);
    if (netHeld <= 0) {
      log.info(
        `Skipping exit for ${position.ticker}: net held ${netHeld} per orders table (position row is stale)`
      );
      return null;
    }
    const sellQuantity = Math.min(position.quantity, netHeld);

    // Price the sell at the current bid side to fill quickly.
    // Sell 1¢ below the current price to cross the spread, but floor at 2¢.
    // Selling at 1¢ can fail with insufficient_balance on Kalshi due to
    // collateral requirements on the counterparty side.
    const price = side === "yes"
      ? Math.max(2, currentYesPrice - 1)
      : Math.max(2, (100 - currentYesPrice) - 1);

    // Look up the original signal for this ticker to link exit to it
    const [origSignal] = await db
      .select({ id: signalsTable.id })
      .from(signalsTable)
      .where(eq(signalsTable.ticker, position.ticker))
      .limit(1);
    const exitSignalId = origSignal?.id ?? "bot-exit";

    log.info(
      `Exiting ${side.toUpperCase()} ${position.ticker} × ${sellQuantity} @ ${price}¢ — ${reason}`
    );

    if (config.bot.dryRun) {
      const orderId = `dry-exit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const nowTs = new Date().toISOString();

      await db.insert(orders).values({
        orderId,
        ticker: position.ticker,
        action: "sell",
        side,
        limitPrice: price,
        quantity: sellQuantity,
        filledQuantity: sellQuantity,
        status: "filled",
        signalId: exitSignalId,
        dryRun: true,
        kellyFraction: null,
        createdAt: nowTs,
        updatedAt: nowTs,
      });

      bus.emit("order:placed", {
        orderId,
        ticker: position.ticker,
        action: "sell",
        side,
        price,
        quantity: sellQuantity,
        dryRun: true,
      });

      return orderId;
    }

    // Live mode
    const result = await this.kalshi.createOrder({
      ticker: position.ticker,
      action: "sell",
      side,
      type: "limit",
      count: sellQuantity,
      ...(side === "yes"
        ? { yes_price: price }
        : { no_price: price }),
    });

    const nowTs = new Date().toISOString();
    await db.insert(orders).values({
      orderId: result.order.order_id,
      ticker: position.ticker,
      action: "sell",
      side,
      limitPrice: price,
      quantity: sellQuantity,
      filledQuantity: 0,
      status: "open",
      signalId: exitSignalId,
      dryRun: false,
      kellyFraction: null,
      createdAt: nowTs,
      updatedAt: nowTs,
    });

    bus.emit("order:placed", {
      orderId: result.order.order_id,
      ticker: position.ticker,
      action: "sell",
      side,
      price,
      quantity: sellQuantity,
      dryRun: false,
    });

    return result.order.order_id;
  }
}

/**
 * Kelly criterion for binary outcome markets.
 *
 * f* = (p * b - q) / b
 *
 * where:
 *   p = our estimated probability of winning
 *   q = 1 - p
 *   b = net odds (payout / cost - 1)
 */
function computeKelly(
  estimatedProb: number,
  marketPrice: number,
  side: "yes" | "no"
): number {
  const p = side === "yes" ? estimatedProb : 1 - estimatedProb;
  const cost = side === "yes" ? marketPrice : 1 - marketPrice;
  const payout = 1; // Binary market: $1 payout
  const b = (payout / cost) - 1;
  const q = 1 - p;

  const kelly = (p * b - q) / b;
  return Math.max(0, kelly);
}

/**
 * Confidence-scaled fraction of balance to wager (2026-06-09 feature).
 *
 * Linear ramp: confidence ≤ `floorConfidence` → `minPct`; confidence 1.0 →
 * `maxPct`; in between, interpolated. Confidence is clamped to
 * [floorConfidence, 1] first, so the result is always within [minPct, maxPct]
 * regardless of input. A degenerate `floorConfidence ≥ 1` collapses to `maxPct`.
 *
 * Pure — exported for unit tests.
 */
function confidenceSizedPct(
  confidence: number,
  floorConfidence: number,
  minPct: number,
  maxPct: number
): number {
  if (floorConfidence >= 1) return maxPct;
  const clamped = Math.max(floorConfidence, Math.min(1, confidence));
  const t = (clamped - floorConfidence) / (1 - floorConfidence);
  return minPct + t * (maxPct - minPct);
}

export { computeKelly, confidenceSizedPct };
