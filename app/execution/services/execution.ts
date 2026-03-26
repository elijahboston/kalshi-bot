import { getConfig } from "@kcb/config";
import { getDb, orders, signals as signalsTable, positions, eq, and, sql } from "@kcb/db";
import type { Position, Signal } from "@kcb/db";
import { KalshiClient } from "@kcb/kalshi-client";
import { bus, createLogger } from "@kcb/engine";

const log = createLogger("execution");

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
   */
  async executeSignal(signal: Signal, balance: number): Promise<string | null> {
    const config = getConfig();

    if (signal.recommendation === "skip" || !signal.side) {
      return null;
    }

    // Check position limits
    const db = getDb();
    const openPositions = await db.select().from(positions);

    if (openPositions.length >= config.bot.maxOpenPositions) {
      log.info(`Skipping ${signal.ticker}: max positions reached (${openPositions.length})`);
      return null;
    }

    // Already have a position in this market?
    const existing = openPositions.find((p) => p.ticker === signal.ticker);
    if (existing) {
      log.info(`Skipping ${signal.ticker}: already have position`);
      return null;
    }

    // Already have a resting or recently filled buy order for this ticker?
    const recentCutoff = new Date(Date.now() - 60 * 60_000).toISOString(); // 1 hour
    const [existingBuy] = await db
      .select({ orderId: orders.orderId, status: orders.status })
      .from(orders)
      .where(
        and(
          eq(orders.ticker, signal.ticker),
          eq(orders.action, "buy"),
          sql`(${orders.status} IN ('open', 'partial') OR (${orders.status} = 'filled' AND ${orders.createdAt} > ${recentCutoff}))`
        )
      )
      .limit(1);
    if (existingBuy) {
      log.info(`Skipping ${signal.ticker}: buy order ${existingBuy.orderId} already ${existingBuy.status}`);
      return null;
    }

    // Post-exit cooldown: skip if ticker was recently exited
    const remaining = getCooldown(signal.ticker);
    if (remaining > 0) {
      log.info(`Skipping ${signal.ticker}: cooldown (${remaining} tick(s) remaining)`);
      return null;
    }

    // Loss-based re-entry guard: require 1.5x normal edge after a recent loss exit.
    // This prevents the buy-exit-rebuy churn loop where the bot keeps re-entering
    // a position that the market is moving against.
    const recentLoss = getRecentLoss(signal.ticker);
    if (recentLoss) {
      const requiredEdge = signal.edgeThreshold * 1.5;
      if (signal.edge < requiredEdge) {
        log.info(
          `Skipping ${signal.ticker}: recent loss exit, edge ${(signal.edge * 100).toFixed(1)}¢ < ` +
          `elevated threshold ${(requiredEdge * 100).toFixed(1)}¢ (1.5x after loss)`
        );
        return null;
      }
      log.info(`${signal.ticker}: allowing re-entry after loss (edge ${(signal.edge * 100).toFixed(1)}¢ >= ${(requiredEdge * 100).toFixed(1)}¢)`);
    }

    // Kelly criterion sizing
    const side = signal.side as "yes" | "no";
    const kellyFraction = computeKelly(
      signal.estimatedProb,
      signal.marketPrice,
      side
    );

    const cappedKelly = Math.min(kellyFraction, config.bot.maxKellyFraction);
    if (cappedKelly <= 0) {
      log.info(`Skipping ${signal.ticker}: Kelly fraction ≤ 0`);
      return null;
    }

    // Compute contracts
    const betAmount = Math.floor(balance * cappedKelly);
    const price = side === "yes"
      ? Math.round(signal.marketPrice * 100) // price in cents
      : Math.round((1 - signal.marketPrice) * 100);
    let contracts = Math.min(
      Math.floor(betAmount / price),
      config.bot.maxContractsPerOrder
    );

    if (contracts <= 0) {
      log.info(`Skipping ${signal.ticker}: 0 contracts at ${price}¢`);
      return null;
    }

    // Minimum contract price filter: skip cheap lottery tickets
    if (price < config.bot.minContractPrice) {
      log.info(`Skipping ${signal.ticker}: price ${price}¢ < min ${config.bot.minContractPrice}¢`);
      return null;
    }

    // Per-ticker exposure limit — use current position cost basis (not historical orders)
    const [existingPosition] = await db
      .select({ costBasis: positions.costBasis })
      .from(positions)
      .where(eq(positions.ticker, signal.ticker))
      .limit(1);
    const currentExposure = existingPosition?.costBasis ?? 0;
    const remainingRoom = config.bot.maxExposurePerTicker - currentExposure;
    if (remainingRoom <= 0) {
      log.info(`Skipping ${signal.ticker}: already at max exposure ${currentExposure}¢`);
      return null;
    }
    // Size down contracts to fit within exposure limit
    contracts = Math.min(contracts, Math.floor(remainingRoom / price));
    if (contracts <= 0) {
      log.info(`Skipping ${signal.ticker}: price ${price}¢ exceeds remaining exposure room ${remainingRoom}¢`);
      return null;
    }

    log.info(
      `Executing: ${side.toUpperCase()} ${signal.ticker} × ${contracts} @ ${price}¢ ` +
      `(Kelly: ${cappedKelly.toFixed(4)}, edge: ${(signal.edge * 100).toFixed(1)}¢)`
    );

    if (config.bot.dryRun) {
      // Simulate order
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
        kellyFraction: cappedKelly,
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

      return orderId;
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
      kellyFraction: cappedKelly,
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

    return result.order.order_id;
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
      `Exiting ${side.toUpperCase()} ${position.ticker} × ${position.quantity} @ ${price}¢ — ${reason}`
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
        quantity: position.quantity,
        filledQuantity: position.quantity,
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
        quantity: position.quantity,
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
      count: position.quantity,
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
      quantity: position.quantity,
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
      quantity: position.quantity,
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

export { computeKelly };
