import { getConfig } from "@kcb/config";
import { getDb, orders, signals as signalsTable, positions, eq, and, sql } from "@kcb/db";
import type { Position, Signal } from "@kcb/db";
import { KalshiClient } from "@kcb/kalshi-client";
import { bus, createLogger } from "@kcb/engine";

const log = createLogger("execution");

/** Per-ticker cooldown tracking: ticker → remaining ticks */
const cooldownMap = new Map<string, number>();

/** Record that a ticker was just exited; starts its cooldown timer. */
export function recordExit(ticker: string): void {
  const config = getConfig();
  cooldownMap.set(ticker, config.bot.exitCooldownTicks);
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

    // Post-exit cooldown: skip if ticker was recently exited
    const remaining = getCooldown(signal.ticker);
    if (remaining > 0) {
      log.info(`Skipping ${signal.ticker}: cooldown (${remaining} tick(s) remaining)`);
      return null;
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
    const contracts = Math.min(
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

    // Per-ticker accumulated exposure limit
    const existingExposure = await db
      .select({ total: sql<number>`COALESCE(SUM(${orders.limitPrice} * ${orders.filledQuantity}), 0)` })
      .from(orders)
      .where(
        and(
          eq(orders.ticker, signal.ticker),
          eq(orders.action, "buy"),
          sql`${orders.signalId} IS NOT NULL`
        )
      );
    const currentExposure = existingExposure[0]?.total ?? 0;
    const newExposure = contracts * price;
    if (currentExposure + newExposure > config.bot.maxExposurePerTicker) {
      log.info(
        `Skipping ${signal.ticker}: exposure ${currentExposure + newExposure}¢ would exceed max ${config.bot.maxExposurePerTicker}¢`
      );
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

    // Price the sell at the current bid side to fill quickly.
    // Sell 1¢ below the current price to cross the spread.
    const price = side === "yes"
      ? Math.max(1, currentYesPrice - 1)
      : Math.max(1, (100 - currentYesPrice) - 1);

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
