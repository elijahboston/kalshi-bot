import {
  getDb,
  orders,
  trades,
  positions,
  markets,
  signals,
  calibration,
  stationBias,
  weatherForecasts,
  balanceHistory,
  eq,
  and,
  sql,
} from "@kcb/db";
import { getConfig } from "@kcb/config";
import { KalshiClient } from "@kcb/kalshi-client";
import { bus, createLogger } from "../events";
import { uuid, now } from "@kcb/shared";

const log = createLogger("reconciliation");

export class ReconciliationService {
  private kalshi: KalshiClient;

  constructor(kalshiClient?: KalshiClient) {
    this.kalshi = kalshiClient || new KalshiClient();
  }

  /** Run all reconciliation steps in sequence */
  async reconcile(): Promise<void> {
    try {
      await this.syncOrders();
      await this.syncHistoricalOrders();
      await this.ensureTradeRecords();
      await this.updatePositions();
      await this.syncPositionsFromKalshi();
      await this.syncSettlements();
      await this.checkResolutions();
      await this.snapshotBalance();
    } catch (err) {
      log.error(
        "Reconciliation error",
        err instanceof Error ? err.message : err
      );
      bus.emit("bot:error", {
        module: "reconciliation",
        message: err instanceof Error ? err.message : String(err),
        error: err,
      });
    }
  }

  /**
   * A. Sync open orders with Kalshi (live mode only).
   * Poll for fill status, update DB, create trade records for newly filled.
   */
  private async syncOrders(): Promise<void> {
    const config = getConfig();
    if (config.bot.dryRun) return;

    const db = getDb();
    const openOrders = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.status, "open"),
          eq(orders.dryRun, false)
        )
      );

    if (openOrders.length === 0) return;

    log.debug(`Syncing ${openOrders.length} open order(s)`);

    for (const order of openOrders) {
      try {
        const result = await this.kalshi.getOrders({ ticker: order.ticker });
        const kalshiOrder = result.orders?.find(
          (o) => o.order_id === order.orderId
        );

        if (!kalshiOrder) continue;

        const count = kalshiOrder.count ?? 0;
        const filled = kalshiOrder.status === "executed" ? count : Math.max(0, count - (kalshiOrder.remaining_count ?? count));

        const newStatus =
          kalshiOrder.status === "executed"
            ? "filled"
            : kalshiOrder.status === "canceled"
              ? "canceled"
              : filled > 0 && filled < count
                ? "partial"
                : "open";

        const prevFilled = order.filledQuantity;
        const timestamp = now();

        await db
          .update(orders)
          .set({
            filledQuantity: filled,
            status: newStatus,
            updatedAt: timestamp,
          })
          .where(eq(orders.orderId, order.orderId));

        // Create trade record for newly filled quantity
        if (filled > prevFilled) {
          const newFills = filled - prevFilled;
          const price =
            order.side === "yes"
              ? kalshiOrder.yes_price
              : kalshiOrder.no_price;

          await db.insert(trades).values({
            id: uuid(),
            orderId: order.orderId,
            ticker: order.ticker,
            side: order.side,
            price,
            quantity: newFills,
            action: order.action,
            filledAt: timestamp,
          });
        }

        bus.emit("order:update", {
          orderId: order.orderId,
          status: newStatus,
          filledQuantity: filled,
          ticker: order.ticker,
        });
      } catch (err) {
        log.warn(
          `Failed to sync order ${order.orderId}: ${err instanceof Error ? err.message : err}`
        );
      }
    }
  }

  /**
   * B. Ensure trade records exist for filled orders.
   * Dry-run orders get status "filled" immediately but no trade record.
   */
  private async ensureTradeRecords(): Promise<void> {
    const db = getDb();

    // Find filled orders that don't have a corresponding trade record
    const filledOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.status, "filled"));

    for (const order of filledOrders) {
      const existingTrades = await db
        .select()
        .from(trades)
        .where(eq(trades.orderId, order.orderId));

      const tradedQty = existingTrades.reduce((s, t) => s + t.quantity, 0);
      const gap = order.filledQuantity - tradedQty;

      if (gap > 0) {
        await db.insert(trades).values({
          id: uuid(),
          orderId: order.orderId,
          ticker: order.ticker,
          side: order.side,
          price: order.limitPrice,
          quantity: gap,
          action: order.action,
          filledAt: order.createdAt,
        });
        log.debug(
          `Created trade record for order ${order.orderId} (${gap} contracts)`
        );
      }
    }
  }

  /**
   * C. Recompute positions from trades and update the positions table.
   */
  private async updatePositions(): Promise<void> {
    const db = getDb();

    // Get all trades grouped by ticker
    const allTrades = await db.select().from(trades);

    // Group trades by ticker
    const byTicker = new Map<
      string,
      { side: string; totalQty: number; totalCost: number; firstAt: string }
    >();

    for (const t of allTrades) {
      let pos = byTicker.get(t.ticker);
      if (!pos) {
        pos = { side: t.side, totalQty: 0, totalCost: 0, firstAt: t.filledAt };
        byTicker.set(t.ticker, pos);
      }

      if (t.action === "buy") {
        pos.totalQty += t.quantity;
        pos.totalCost += t.quantity * t.price;
      } else {
        // sell reduces position
        pos.totalQty -= t.quantity;
        pos.totalCost -= t.quantity * t.price;
      }
    }

    // Get current market prices
    const allMarkets = await db.select().from(markets);
    const marketPrices = new Map(
      allMarkets.map((m) => [m.ticker, m])
    );

    const timestamp = now();

    for (const [ticker, pos] of byTicker) {
      if (pos.totalQty <= 0) {
        // No position — delete if exists
        await db.delete(positions).where(eq(positions.ticker, ticker));
        continue;
      }

      const avgEntry = pos.totalCost / pos.totalQty;
      const market = marketPrices.get(ticker);
      const currentPrice =
        pos.side === "yes"
          ? (market?.lastYesPrice ?? avgEntry)
          : (market?.lastNoPrice ?? avgEntry);
      const marketValue = pos.totalQty * currentPrice;
      const unrealizedPnl = marketValue - pos.totalCost;

      // Upsert position
      const existing = await db
        .select()
        .from(positions)
        .where(eq(positions.ticker, ticker))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(positions)
          .set({
            side: pos.side,
            quantity: pos.totalQty,
            avgEntryPrice: avgEntry,
            costBasis: pos.totalCost,
            marketValue,
            unrealizedPnl,
            updatedAt: timestamp,
          })
          .where(eq(positions.ticker, ticker));
      } else {
        await db.insert(positions).values({
          ticker,
          side: pos.side,
          quantity: pos.totalQty,
          avgEntryPrice: avgEntry,
          costBasis: pos.totalCost,
          marketValue,
          unrealizedPnl,
          openedAt: pos.firstAt,
          updatedAt: timestamp,
        });
      }

      bus.emit("position:update", {
        ticker,
        side: pos.side,
        quantity: pos.totalQty,
        unrealizedPnl,
        avgEntryPrice: avgEntry,
      });
    }
  }

  /**
   * C2. Sync positions from Kalshi API into local DB (non-dry-run only).
   * This ensures externally opened positions (or any drift) are reflected locally.
   */
  async syncPositionsFromKalshi(): Promise<void> {
    // Always sync from Kalshi even in dry-run mode — the user may have
    // positions from manual trading or prior live runs.
    const config = getConfig();
    if (!config.kalshi.apiKey) return;

    try {
      const response = await this.kalshi.getPositions();
      const kalshiPositions = response.market_positions || [];

      const db = getDb();
      const timestamp = now();
      const kalshiTickers = new Set<string>();

      if (kalshiPositions.length > 0) {
        // Log the shape of the first position so we can see what the API returns
        log.debug(
          `Kalshi positions response (${kalshiPositions.length}): ${JSON.stringify(kalshiPositions[0])}`,
        );
      }

      for (const kp of kalshiPositions) {
        const ticker = kp.ticker;
        if (!ticker) continue;

        // Derive quantity: prefer explicit `position` field, fall back to exposure math
        const exposure = Number(kp.market_exposure) || 0;
        const restExposure = Number(kp.rest_of_market_exposure) || 0;
        let quantity = typeof kp.position === "number"
          ? Math.abs(kp.position)
          : Math.round((exposure + restExposure) / 100);

        if (!quantity || quantity <= 0) continue;

        kalshiTickers.add(ticker);

        // Determine side from explicit position sign, or infer from market price
        let side = "yes";
        let avgEntry = exposure > 0 ? exposure / quantity : 0;

        const [market] = await db
          .select()
          .from(markets)
          .where(eq(markets.ticker, ticker))
          .limit(1);

        if (typeof kp.position === "number" && kp.position < 0) {
          side = "no";
          quantity = Math.abs(kp.position);
        } else if (market?.lastYesPrice != null && avgEntry > 0) {
          const yesPrice = market.lastYesPrice;
          const noPrice = 100 - yesPrice;
          side =
            Math.abs(avgEntry - yesPrice) <= Math.abs(avgEntry - noPrice)
              ? "yes"
              : "no";
        }

        const currentPrice =
          side === "yes"
            ? (market?.lastYesPrice ?? avgEntry)
            : (market?.lastNoPrice ?? (100 - avgEntry));
        const marketValue = quantity * currentPrice;
        const costBasis = exposure || quantity * avgEntry;
        const unrealizedPnl = marketValue - costBasis;

        // Upsert position
        const existing = await db
          .select()
          .from(positions)
          .where(eq(positions.ticker, ticker))
          .limit(1);

        if (existing.length > 0) {
          await db
            .update(positions)
            .set({
              side,
              quantity,
              avgEntryPrice: avgEntry,
              costBasis,
              marketValue,
              unrealizedPnl,
              updatedAt: timestamp,
            })
            .where(eq(positions.ticker, ticker));
        } else {
          await db.insert(positions).values({
            ticker,
            side,
            quantity,
            avgEntryPrice: avgEntry,
            costBasis,
            marketValue,
            unrealizedPnl,
            openedAt: timestamp,
            updatedAt: timestamp,
          });
        }

        bus.emit("position:update", {
          ticker,
          side,
          quantity,
          unrealizedPnl,
          avgEntryPrice: avgEntry,
        });
      }

      // Remove local positions that Kalshi no longer reports (settled/closed)
      const localPositions = await db.select().from(positions);
      let removed = 0;
      for (const lp of localPositions) {
        if (!kalshiTickers.has(lp.ticker)) {
          await db.delete(positions).where(eq(positions.ticker, lp.ticker));
          removed++;
        }
      }

      if (kalshiTickers.size > 0 || removed > 0) {
        log.info(
          `Synced ${kalshiTickers.size} position(s) from Kalshi` +
          (removed > 0 ? `, removed ${removed} stale position(s)` : "")
        );
      }
    } catch (err) {
      log.warn(
        `Failed to sync positions from Kalshi: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * C3. Sync historical orders from Kalshi into local orders table.
   * Ensures orders placed outside the bot (e.g. web UI) are tracked.
   */
  async syncHistoricalOrders(): Promise<void> {
    const config = getConfig();
    if (!config.kalshi.apiKey) return;

    try {
      const kalshiOrders = await this.kalshi.getAllOrders();
      if (kalshiOrders.length === 0) return;

      const db = getDb();
      let imported = 0;

      for (const ko of kalshiOrders) {
        // Skip if we already have this order
        const existing = await db
          .select()
          .from(orders)
          .where(eq(orders.orderId, ko.order_id))
          .limit(1);

        if (existing.length > 0) continue;

        const count = ko.count ?? 0;
        const remaining = ko.remaining_count ?? count;
        // For executed orders, Kalshi returns remaining_count equal to count
        // instead of 0. Trust the status field over remaining_count arithmetic.
        const filled = ko.status === "executed" ? count : Math.max(0, count - remaining);

        const status =
          ko.status === "executed"
            ? "filled"
            : ko.status === "canceled"
              ? "canceled"
              : filled > 0 && filled < count
                ? "partial"
                : "open";

        const timestamp = ko.created_time || now();

        await db.insert(orders).values({
          orderId: ko.order_id,
          ticker: ko.ticker,
          action: ko.action,
          side: ko.side,
          limitPrice: ko.side === "yes" ? ko.yes_price : ko.no_price,
          quantity: count,
          filledQuantity: filled,
          status,
          dryRun: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        imported++;
      }

      if (imported > 0) {
        log.info(`Imported ${imported} historical order(s) from Kalshi`);
      }
    } catch (err) {
      log.warn(
        `Failed to sync historical orders: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * C4. Sync settlements from Kalshi into calibration table.
   * This imports realized PnL from settled markets the user traded.
   */
  async syncSettlements(): Promise<void> {
    const config = getConfig();
    if (!config.kalshi.apiKey) return;

    try {
      const settlements = await this.kalshi.getAllSettlements();
      if (settlements.length === 0) return;

      const db = getDb();
      let imported = 0;

      for (const s of settlements) {
        if (!s.ticker) continue;

        // Skip if calibration record already exists for this ticker
        const existing = await db
          .select()
          .from(calibration)
          .where(eq(calibration.ticker, s.ticker))
          .limit(1);

        if (existing.length > 0) continue;

        // Look up market for metadata
        const [market] = await db
          .select()
          .from(markets)
          .where(eq(markets.ticker, s.ticker))
          .limit(1);

        // Look up signal if the bot generated one
        const [signal] = await db
          .select()
          .from(signals)
          .where(eq(signals.ticker, s.ticker))
          .limit(1);

        const actualOutcome =
          s.market_result === "yes" || s.market_result === "all_yes" ? 1 : 0;

        // Only count settlements where the bot actually placed an order
        // (has a signal_id). syncHistoricalOrders imports ALL Kalshi orders
        // including manual trades, so checking orders alone isn't enough.
        const botOrder = await db
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.ticker, s.ticker),
              sql`${orders.signalId} IS NOT NULL`
            )
          )
          .limit(1);
        const traded = botOrder.length > 0;

        if (!traded) {
          // Still record for calibration but without PnL
          if (signal) {
            await db.insert(calibration).values({
              id: uuid(),
              ticker: s.ticker,
              seriesTicker: market?.seriesTicker ?? "",
              category: market?.category ?? "",
              stationId: market?.stationId ?? null,
              predictedProb: signal.estimatedProb,
              actualOutcome,
              marketPrice: signal.marketPrice,
              edge: signal.edge,
              realizedPnl: null,
              traded: false,
              forecastHorizon: null,
              resolvedAt: s.settled_time || now(),
            });
          }
          continue;
        }

        // Compute PnL from bot-attributable orders only (signal_id IS NOT NULL).
        // This includes bot buys (signal_id = signal UUID) and bot exit sells
        // (signal_id = signal UUID or "bot-exit"), but excludes manual trades
        // imported by syncHistoricalOrders.
        const botOrders = await db
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.ticker, s.ticker),
              eq(orders.status, "filled"),
              sql`${orders.signalId} IS NOT NULL`
            )
          );

        // Compute from trades linked to bot orders for accuracy
        let totalBuyCost = 0;
        let totalBuyQty = 0;
        let totalSellProceeds = 0;
        let totalSellQty = 0;
        let tradeSide: string | null = null;
        for (const o of botOrders) {
          if (o.action === "buy") {
            totalBuyCost += o.limitPrice * o.filledQuantity;
            totalBuyQty += o.filledQuantity;
            if (!tradeSide) tradeSide = o.side;
          } else {
            totalSellProceeds += o.limitPrice * o.filledQuantity;
            totalSellQty += o.filledQuantity;
          }
        }
        const remainingQty = Math.max(0, totalBuyQty - totalSellQty);
        const won =
          (tradeSide === "yes" && actualOutcome === 1) ||
          (tradeSide === "no" && actualOutcome === 0);
        const settlementPayout = won ? remainingQty * 100 : 0;
        const realizedPnl = settlementPayout + totalSellProceeds - totalBuyCost;

        // Compute market price from the bot's orders
        const botBuys = botFilledOrders.filter((o) => o.action === "buy");
        const marketPrice = signal?.marketPrice
          ?? (botBuys.length > 0
            ? botBuys.reduce((s, o) => s + o.limitPrice * o.filledQuantity, 0) /
              botBuys.reduce((s, o) => s + o.filledQuantity, 0) / 100
            : 0.5);

        const predictedProb = signal?.estimatedProb ?? marketPrice;
        const edge = signal?.edge ?? (predictedProb - marketPrice);

        await db.insert(calibration).values({
          id: uuid(),
          ticker: s.ticker,
          seriesTicker: market?.seriesTicker ?? "",
          category: market?.category ?? "",
          stationId: market?.stationId ?? null,
          predictedProb,
          actualOutcome,
          marketPrice,
          edge,
          realizedPnl,
          traded: true,
          forecastHorizon: null,
          resolvedAt: s.settled_time || now(),
        });

        bus.emit("calibration:updated", {
          ticker: s.ticker,
          predictedProb,
          actualOutcome,
          calibrationError: Math.abs(predictedProb - actualOutcome),
          brierScore: (predictedProb - actualOutcome) ** 2,
        });

        imported++;
      }

      if (imported > 0) {
        log.info(`Imported ${imported} settlement(s) from Kalshi`);
      }
    } catch (err) {
      log.warn(
        `Failed to sync settlements: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * D. Check for settled markets and create calibration records.
   */
  private async checkResolutions(): Promise<void> {
    const db = getDb();

    // Find settled markets that don't have calibration records yet
    const settledMarkets = await db
      .select()
      .from(markets)
      .where(eq(markets.status, "settled"));

    for (const market of settledMarkets) {
      if (!market.result) continue;

      // Check if calibration record already exists
      const existing = await db
        .select()
        .from(calibration)
        .where(eq(calibration.ticker, market.ticker))
        .limit(1);

      if (existing.length > 0) continue;

      // Find the most recent signal for this market
      const [signal] = await db
        .select()
        .from(signals)
        .where(eq(signals.ticker, market.ticker))
        .limit(1);

      if (!signal) continue; // No signal means we never evaluated this market

      // Compute realized PnL from bot-attributable orders only
      const botOrders = await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.ticker, market.ticker),
            eq(orders.status, "filled"),
            sql`${orders.signalId} IS NOT NULL`
          )
        );

      let realizedPnl: number | null = null;
      const traded = botOrders.length > 0;

      if (traded) {
        const outcome = market.result === "yes" ? 1 : 0;
        // PnL = settlement_payout + sell_proceeds - buy_cost
        let totalBuyCost = 0;
        let totalBuyQty = 0;
        let totalSellProceeds = 0;
        let totalSellQty = 0;
        let tradeSide: string | null = null;
        for (const o of botOrders) {
          if (o.action === "buy") {
            totalBuyCost += o.limitPrice * o.filledQuantity;
            totalBuyQty += o.filledQuantity;
            if (!tradeSide) tradeSide = o.side;
          } else {
            totalSellProceeds += o.limitPrice * o.filledQuantity;
            totalSellQty += o.filledQuantity;
          }
        }
        const remainingQty = Math.max(0, totalBuyQty - totalSellQty);
        const won =
          (tradeSide === "yes" && outcome === 1) ||
          (tradeSide === "no" && outcome === 0);
        const settlementPayout = won ? remainingQty * 100 : 0;
        realizedPnl = settlementPayout + totalSellProceeds - totalBuyCost;
      }

      const actualOutcome = market.result === "yes" ? 1 : 0;
      const timestamp = now();

      await db.insert(calibration).values({
        id: uuid(),
        ticker: market.ticker,
        seriesTicker: market.seriesTicker,
        category: market.category,
        stationId: market.stationId,
        predictedProb: signal.estimatedProb,
        actualOutcome,
        marketPrice: signal.marketPrice,
        edge: signal.edge,
        realizedPnl,
        traded,
        forecastHorizon: signal.ensembleSize, // closest proxy we have
        resolvedAt: timestamp,
      });

      // Backfill actual observed value in weather_forecasts if possible
      if (
        market.targetDate &&
        market.stationId &&
        new Date(market.targetDate) < new Date()
      ) {
        await this.backfillActualValue(market);
      }

      // Recompute station bias for this station
      if (market.stationId && market.targetDate) {
        await this.recomputeStationBias(market.stationId);
      }

      bus.emit("market:resolved", {
        ticker: market.ticker,
        result: market.result as "yes" | "no",
        predictedProb: signal.estimatedProb,
        realizedPnl: realizedPnl ?? undefined,
      });

      bus.emit("calibration:updated", {
        ticker: market.ticker,
        predictedProb: signal.estimatedProb,
        actualOutcome,
        calibrationError: Math.abs(signal.estimatedProb - actualOutcome),
        brierScore: (signal.estimatedProb - actualOutcome) ** 2,
      });

      log.info(
        `Calibration: ${market.ticker} predicted=${signal.estimatedProb.toFixed(2)} actual=${market.result} ` +
          (realizedPnl != null
            ? `PnL=${realizedPnl >= 0 ? "+" : ""}$${(realizedPnl / 100).toFixed(2)}`
            : "(not traded)")
      );
    }
  }

  /**
   * Try to backfill the actual observed value from NWS observations.
   */
  private async backfillActualValue(market: {
    stationId: string | null;
    targetDate: string | null;
    category: string;
  }): Promise<void> {
    if (!market.stationId || !market.targetDate) return;

    const db = getDb();

    // Check if we already have actual values
    const forecasts = await db
      .select()
      .from(weatherForecasts)
      .where(
        and(
          eq(weatherForecasts.stationId, market.stationId),
          eq(weatherForecasts.targetDate, market.targetDate)
        )
      );

    const needsBackfill = forecasts.some((f) => f.actualValue == null);
    if (!needsBackfill) return;

    try {
      const res = await fetch(
        `https://api.weather.gov/stations/${market.stationId}/observations?start=${market.targetDate}T00:00:00Z&end=${market.targetDate}T23:59:59Z`,
        { headers: { "User-Agent": "KalshiClimateBot/1.0" } }
      );
      if (!res.ok) return;

      const data = (await res.json()) as {
        features: Array<{
          properties: {
            maxTemperatureLast24Hours: { value: number | null };
            minTemperatureLast24Hours: { value: number | null };
            precipitationLastHour: { value: number | null };
          };
        }>;
      };

      if (!data.features?.length) return;

      // Extract max temp observation (in Celsius from NWS)
      let maxTemp: number | null = null;
      let minTemp: number | null = null;
      let totalPrecip = 0;

      for (const f of data.features) {
        const p = f.properties;
        if (p.maxTemperatureLast24Hours?.value != null) {
          const valF = p.maxTemperatureLast24Hours.value * 9/5 + 32;
          if (maxTemp == null || valF > maxTemp) maxTemp = valF;
        }
        if (p.minTemperatureLast24Hours?.value != null) {
          const valF = p.minTemperatureLast24Hours.value * 9/5 + 32;
          if (minTemp == null || valF < minTemp) minTemp = valF;
        }
        if (p.precipitationLastHour?.value != null) {
          totalPrecip += p.precipitationLastHour.value; // mm
        }
      }

      const actualMap: Record<string, number | null> = {
        high_temp: maxTemp,
        low_temp: minTemp,
        precip: totalPrecip > 0 ? totalPrecip / 25.4 : 0, // mm → inches
        snowfall: null, // NWS observations don't reliably report this
      };

      const actual = actualMap[market.category];
      if (actual == null) return;

      // Update all forecast records for this date/station
      for (const f of forecasts) {
        if (f.actualValue == null) {
          await db
            .update(weatherForecasts)
            .set({ actualValue: actual })
            .where(eq(weatherForecasts.id, f.id));
        }
      }

      log.debug(
        `Backfilled actual ${market.category} for ${market.stationId} on ${market.targetDate}: ${actual.toFixed(1)}`
      );
    } catch {
      // Non-critical — silently skip
    }
  }

  /**
   * Recompute rolling station bias for all horizons of a station.
   */
  private async recomputeStationBias(stationId: string): Promise<void> {
    const config = getConfig();
    const db = getDb();
    const windowDays = config.calibration.biasWindowDays;
    const cutoff = new Date(
      Date.now() - windowDays * 86400_000
    ).toISOString();

    // Get forecasts with actual values for this station in the window
    const forecasts = await db
      .select()
      .from(weatherForecasts)
      .where(
        and(
          eq(weatherForecasts.stationId, stationId),
          sql`${weatherForecasts.actualValue} IS NOT NULL`,
          sql`${weatherForecasts.fetchedAt} >= ${cutoff}`
        )
      );

    if (forecasts.length === 0) return;

    // Group by horizon
    const byHorizon = new Map<number, { errors: number[] }>();

    for (const f of forecasts) {
      if (f.pointForecast == null || f.actualValue == null) continue;
      const horizon = Math.min(f.forecastHorizon, 7);
      let group = byHorizon.get(horizon);
      if (!group) {
        group = { errors: [] };
        byHorizon.set(horizon, group);
      }
      group.errors.push(f.pointForecast - f.actualValue);
    }

    const timestamp = now();

    for (const [horizon, group] of byHorizon) {
      const n = group.errors.length;
      if (n === 0) continue;

      const meanBias = group.errors.reduce((a, b) => a + b, 0) / n;
      const variance =
        group.errors.reduce((s, e) => s + (e - meanBias) ** 2, 0) / n;
      const stdBias = Math.sqrt(variance);

      const biasId = `${stationId}_${horizon}`;

      // Upsert
      const existing = await db
        .select()
        .from(stationBias)
        .where(eq(stationBias.id, biasId))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(stationBias)
          .set({
            meanBias,
            stdBias,
            sampleSize: n,
            windowDays,
            updatedAt: timestamp,
          })
          .where(eq(stationBias.id, biasId));
      } else {
        await db.insert(stationBias).values({
          id: biasId,
          stationId,
          forecastHorizonDays: horizon,
          meanBias,
          stdBias,
          sampleSize: n,
          windowDays,
          updatedAt: timestamp,
        });
      }
    }

    log.debug(
      `Updated station bias for ${stationId}: ${byHorizon.size} horizon(s)`
    );
  }

  /**
   * E. Snapshot current balance and equity.
   */
  private async snapshotBalance(): Promise<void> {
    const config = getConfig();
    const db = getDb();

    let balance: number;

    if (config.bot.dryRun) {
      // Use last known balance (default $100 = 10000 cents)
      const lastRecord = await db
        .select()
        .from(balanceHistory)
        .orderBy(sql`${balanceHistory.recordedAt} DESC`)
        .limit(1);

      balance = lastRecord[0]?.balance ?? 10000;
    } else {
      const kalshiBalance = await this.kalshi.getBalance();
      balance = kalshiBalance.balance;
    }

    // Sum position market values
    const openPositions = await db.select().from(positions);
    const positionValue = openPositions.reduce(
      (sum, p) => sum + (p.marketValue ?? 0),
      0
    );

    // Sum realized PnL from all calibration records
    const calRecords = await db.select().from(calibration);
    const realizedPnl = calRecords.reduce(
      (sum, c) => sum + (c.realizedPnl ?? 0),
      0
    );

    const portfolio = balance + positionValue;

    await db.insert(balanceHistory).values({
      id: uuid(),
      balance,
      totalEquity: Math.round(portfolio),
      openPositions: openPositions.length,
      realizedPnl: Math.round(realizedPnl),
      recordedAt: now(),
    });

    bus.emit("balance:update", {
      cash: balance,
      portfolio: Math.round(portfolio),
    });

    log.info(
      `Snapshot: cash $${(balance / 100).toFixed(2)}, ${openPositions.length} positions, portfolio $${(portfolio / 100).toFixed(2)}`
    );
  }
}
