import { getConfig } from "@kcb/config";
import { getDb, orders, positions, eq } from "@kcb/db";
import { KalshiClient } from "@kcb/kalshi-client";
import { bus, createLogger } from "@kcb/engine";
import type { Signal } from "@kcb/db";

const log = createLogger("execution");

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
