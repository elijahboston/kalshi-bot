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
  inArray,
} from "@kcb/db";
import { getConfig } from "@kcb/config";
import { KalshiClient, parseOrderFields, parsePositionFields } from "@kcb/kalshi-client";
import { persistAdaptiveThresholds, updateStationHealthGate } from "@kcb/signals";
import { EnsembleService, NwsService } from "@kcb/data";
import { bus, createLogger } from "../events";
import { uuid, now, takerFeeCents } from "@kcb/shared";

const log = createLogger("reconciliation");

/**
 * IANA timezone per enabled station. Duplicated here (rather than imported from
 * @kcb/signals) on purpose: engine → signals would be a backwards dependency.
 * Keep in sync with STATION_TZ in app/signals/services/estimator.ts.
 */
const STATION_TZ: Record<string, string> = {
  KNYC: "America/New_York",
  KMIA: "America/New_York",
  KORD: "America/Chicago",
  KAUS: "America/Chicago",
  KDEN: "America/Denver",
  KLAX: "America/Los_Angeles",
};

const DEFAULT_TZ = "America/New_York";

/**
 * Compute the UTC instants bracketing a station's LOCAL calendar day.
 *
 * The legacy NWS obs query used `{date}T00:00:00Z → T23:59:59Z`, i.e. the UTC
 * day. For US stations that window starts in the *previous* local evening
 * (00–06Z) and clips the end of the local day, contaminating the max with the
 * prior evening and undersampling the true afternoon peak — a primary cause of
 * the ~70% ground-truth mismatch documented in win-rate-80-addendum-2026-06-05.md
 * (Finding 1 / N1). This returns `[startUtc, endUtc)` covering exactly the
 * station's local `targetDate` (00:00 local of targetDate up to, but excluding,
 * 00:00 local of the following day), plus the UTC instant of the local midnight
 * that ENDS the day (used to decide whether the day is complete).
 */
export function localDayWindowUtc(
  targetDate: string,
  tz: string,
): { startUtc: Date; endUtc: Date } {
  // The UTC offset (minutes) a timezone applies to a given instant. Positive
  // means local is behind UTC (e.g. New_York = +240/+300). Derived by formatting
  // a probe instant in the target tz and diffing the wall-clock from UTC.
  const offsetMinutes = (atUtcMs: number): number => {
    const d = new Date(atUtcMs);
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(d);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    // Wall-clock the tz reports for this instant, interpreted as if it were UTC.
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    return (asUtc - atUtcMs) / 60000;
  };

  // Resolve the UTC instant of a given local wall-clock midnight. Start from the
  // naive UTC guess, then correct by the offset that applies at that guess (one
  // pass is exact except across the ~2 DST transitions/year; a second pass
  // converges those).
  const localMidnightUtc = (dateStr: string): number => {
    const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
    let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
    for (let i = 0; i < 2; i++) {
      const off = offsetMinutes(guess);
      const corrected = Date.UTC(y, m - 1, d, 0, 0, 0) - off * 60000;
      if (corrected === guess) break;
      guess = corrected;
    }
    return guess;
  };

  const startMs = localMidnightUtc(targetDate);
  // Next local day = targetDate + 1 (date arithmetic via UTC noon to dodge DST
  // edge wobble, then re-resolve that day's local midnight).
  const nextDateStr = new Date(
    Date.UTC(
      ...(targetDate.split("-").map(Number) as [number, number, number]).map(
        (v, i) => (i === 1 ? v - 1 : v),
      ) as [number, number, number],
      12,
    ) + 86400_000,
  )
    .toISOString()
    .slice(0, 10);
  const endMs = localMidnightUtc(nextDateStr);

  return { startUtc: new Date(startMs), endUtc: new Date(endMs) };
}

/** Resolve a station's IANA timezone, defaulting to US Eastern. */
function stationTz(stationId: string): string {
  return STATION_TZ[stationId] ?? DEFAULT_TZ;
}

export class ReconciliationService {
  private kalshi: KalshiClient;
  private ensembleService: EnsembleService;
  private nwsService: NwsService;
  /** Timestamp gates to rate-limit periodic background work. */
  private lastMultiHorizonWarmAt = 0;
  private lastActualsBackfillAt = 0;
  private lastGroundTruthHealthAt = 0;
  private lastStationHealthAt = 0;

  constructor(
    kalshiClient?: KalshiClient,
    ensembleService?: EnsembleService,
    nwsService?: NwsService,
  ) {
    this.kalshi = kalshiClient || new KalshiClient();
    this.ensembleService = ensembleService || new EnsembleService();
    this.nwsService = nwsService || new NwsService();
  }

  /** Run all reconciliation steps in sequence */
  async reconcile(): Promise<void> {
    try {
      await this.syncOrders();
      await this.cancelStaleOrders();
      await this.syncHistoricalOrders();
      await this.ensureTradeRecords();
      await this.finalizeExpiredMarkets();
      await this.updatePositions();
      await this.syncPositionsFromKalshi();
      await this.syncSettlements();
      await this.checkResolutions();
      await this.repairCalibrationPnl();
      await persistAdaptiveThresholds();
      await this.warmMultiHorizonForecasts();
      await this.backfillHistoricalForecastActuals();
      await this.checkGroundTruthHealth();
      await this.runStationHealthGate();
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
          sql`${orders.status} IN ('open', 'partial')`,
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

        const parsed = parseOrderFields(kalshiOrder);
        const count = parsed.initialCount;
        const filled = parsed.fillCount || (kalshiOrder.status === "executed" ? count : Math.max(0, count - parsed.remainingCount));

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
              ? parsed.yesPrice
              : parsed.noPrice;

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

          log.info(`Order ${order.orderId} filled +${newFills} (${filled}/${count}) — ${order.action} ${order.side} ${order.ticker} @${price}¢`);
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
   * Cancel resting orders older than 30 minutes that haven't fully filled.
   * Stale orders tie up collateral and prevent new trades.
   */
  private async cancelStaleOrders(): Promise<void> {
    const config = getConfig();
    const db = getDb();

    const maxAgeMs = 30 * 60_000; // 30 minutes
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    const staleOrders = await db
      .select()
      .from(orders)
      .where(
        and(
          sql`${orders.status} IN ('open', 'partial')`,
          sql`${orders.createdAt} < ${cutoff}`
        )
      );

    if (staleOrders.length === 0) return;

    log.info(`Found ${staleOrders.length} stale order(s) older than 30 min`);

    for (const order of staleOrders) {
      try {
        if (!config.bot.dryRun && !order.dryRun) {
          await this.kalshi.cancelOrder(order.orderId);
          log.info(`Canceled stale order ${order.orderId} (${order.action} ${order.side} ${order.ticker}, ${order.filledQuantity}/${order.quantity} filled)`);
        }

        await db
          .update(orders)
          .set({ status: "canceled", updatedAt: now() })
          .where(eq(orders.orderId, order.orderId));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Order may already be canceled/filled on Kalshi — just update DB status
        if (msg.includes("not_found") || msg.includes("already")) {
          await db
            .update(orders)
            .set({ status: "canceled", updatedAt: now() })
            .where(eq(orders.orderId, order.orderId));
          log.debug(`Order ${order.orderId} already gone on Kalshi, marked canceled`);
        } else {
          log.warn(`Failed to cancel stale order ${order.orderId}: ${msg}`);
        }
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
  /**
   * Mark markets as finalized if their target date has passed and they're
   * still showing as active. This prevents updatePositions from rebuilding
   * phantom positions from old trades every tick.
   */
  private async finalizeExpiredMarkets(): Promise<void> {
    const db = getDb();
    const cutoff = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10); // 2 days ago

    const stale = await db
      .update(markets)
      .set({ status: "finalized", updatedAt: now() })
      .where(
        and(
          eq(markets.status, "active"),
          sql`${markets.targetDate} IS NOT NULL AND ${markets.targetDate} < ${cutoff}`
        )
      );
  }

  private async updatePositions(): Promise<void> {
    const db = getDb();

    // Only rebuild positions for markets that are NOT settled/finalized.
    // Without this filter, historical trades from settled markets create phantom
    // positions that syncPositionsFromKalshi immediately deletes every tick.
    const activeMarketRows = await db
      .select({ ticker: markets.ticker })
      .from(markets)
      .where(sql`${markets.status} NOT IN ('settled', 'finalized')`);
    const activeMarketTickers = new Set(activeMarketRows.map((m) => m.ticker));

    // Clean up positions whose underlying market has resolved. For LIVE
    // positions this used to happen via syncPositionsFromKalshi (Kalshi drops
    // settled markets from its positions response). For PAPER positions
    // syncPositionsFromKalshi was scoped to dry_run=false to protect them
    // from being wiped, which left paper rows on resolved markets stuck open
    // forever. Delete them explicitly here, regardless of dry_run mode.
    const resolvedMarketRows = await db
      .select({ ticker: markets.ticker })
      .from(markets)
      .where(inArray(markets.status, ["settled", "finalized"]));
    if (resolvedMarketRows.length > 0) {
      const resolvedTickers = resolvedMarketRows.map((m) => m.ticker);
      await db
        .delete(positions)
        .where(inArray(positions.ticker, resolvedTickers));
    }

    const allTrades = await db.select().from(trades);

    // Index orders by id to recover the dry_run flag on each trade — trades
    // don't carry the flag themselves but inherit through order_id. A position
    // is "paper" if any of its underlying trades came from a dry_run order.
    const allOrders = await db.select().from(orders);
    const orderModeById = new Map<string, boolean>();
    for (const o of allOrders) orderModeById.set(o.orderId, o.dryRun);

    // Group trades by ticker
    const byTicker = new Map<
      string,
      { side: string; totalQty: number; totalCost: number; firstAt: string; dryRun: boolean }
    >();

    for (const t of allTrades) {
      if (!activeMarketTickers.has(t.ticker)) continue;
      const tradeDryRun = orderModeById.get(t.orderId) ?? false;
      let pos = byTicker.get(t.ticker);
      if (!pos) {
        pos = { side: t.side, totalQty: 0, totalCost: 0, firstAt: t.filledAt, dryRun: tradeDryRun };
        byTicker.set(t.ticker, pos);
      } else if (tradeDryRun) {
        // If any contributing trade is paper, mark the whole position paper.
        // This biases toward "paper" when modes mix — protects paper rows
        // from being mistaken for live and wiped by syncPositionsFromKalshi.
        pos.dryRun = true;
      }

      if (t.action === "buy") {
        pos.totalQty += t.quantity;
        pos.totalCost += t.quantity * t.price;
      } else {
        // Sell reduces position quantity. Cost basis must drop proportionally
        // to the avg entry of contracts being closed — NOT by sell proceeds.
        // Subtracting proceeds was the prior bug: a profitable round-trip
        // (proceeds > cost) drove cost basis negative, then the next buy
        // inherited that negative starting point and produced an inverted
        // avg entry price.
        if (pos.totalQty > 0) {
          const avgCost = pos.totalCost / pos.totalQty;
          const closedQty = Math.min(t.quantity, pos.totalQty);
          pos.totalQty -= closedQty;
          pos.totalCost -= closedQty * avgCost;
        }
        // Snap to flat on full close so floating-point residue and overshoots
        // (sell qty exceeding holdings) can't poison the next buy's basis.
        if (pos.totalQty <= 0) {
          pos.totalQty = 0;
          pos.totalCost = 0;
        }
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
            dryRun: pos.dryRun,
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
          dryRun: pos.dryRun,
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

        const parsed = parsePositionFields(kp);
        let quantity = parsed.quantity;
        const exposure = parsed.exposure;

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

        // Check legacy position field for sign (negative = NO side)
        const rawPosition = parseFloat(String(kp.position_fp ?? kp.position ?? "0"));
        if (rawPosition < 0) {
          side = "no";
          quantity = Math.abs(rawPosition);
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
              dryRun: false,
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
            dryRun: false,
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

      // Remove local LIVE positions that Kalshi no longer reports
      // (settled/closed). Paper positions (dry_run=true) are NOT in Kalshi's
      // response by design — leave them alone or paper trading dashboard
      // breaks every tick.
      const localPositions = await db
        .select()
        .from(positions)
        .where(eq(positions.dryRun, false));
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

      let repaired = 0;

      for (const ko of kalshiOrders) {
        try {
        const existing = await db
          .select()
          .from(orders)
          .where(eq(orders.orderId, ko.order_id))
          .limit(1);

        const parsed = parseOrderFields(ko);

        if (existing.length > 0) {
          // Repair signalId if missing — cross-reference signals table
          const ex = existing[0]!;
          if (!ex.signalId) {
            const [matchedSignal] = await db
              .select({ id: signals.id })
              .from(signals)
              .where(and(eq(signals.orderId, ko.order_id), eq(signals.acted, true)))
              .limit(1);
            if (matchedSignal) {
              await db
                .update(orders)
                .set({ signalId: matchedSignal.id, updatedAt: now() })
                .where(eq(orders.orderId, ko.order_id));
            }
          }
          // Repair orders stuck with filledQuantity=0 despite being executed
          if (ex.filledQuantity === 0 && ko.status === "executed") {
            const filled = parsed.fillCount || parsed.initialCount;
            if (filled > 0) {
              await db
                .update(orders)
                .set({
                  filledQuantity: filled,
                  status: "filled",
                  updatedAt: now(),
                })
                .where(eq(orders.orderId, ko.order_id));

              // Also create the missing trade record
              const existingTrades = await db
                .select()
                .from(trades)
                .where(eq(trades.orderId, ko.order_id));
              const tradedQty = existingTrades.reduce((s, t) => s + t.quantity, 0);
              if (filled > tradedQty) {
                const price = ex.side === "yes" ? parsed.yesPrice : parsed.noPrice;
                await db.insert(trades).values({
                  id: uuid(),
                  orderId: ko.order_id,
                  ticker: ex.ticker,
                  side: ex.side,
                  price: price || ex.limitPrice,
                  quantity: filled - tradedQty,
                  action: ex.action,
                  filledAt: ko.created_time || ex.createdAt,
                });
              }

              repaired++;
              log.info(`Repaired order ${ko.order_id}: ${filled} fills + trade record (${ex.action} ${ex.side} ${ex.ticker})`);
            }
          }
          continue;
        }

        const count = parsed.initialCount;
        const filled = parsed.fillCount || (ko.status === "executed" ? count : Math.max(0, count - parsed.remainingCount));

        const status =
          ko.status === "executed"
            ? "filled"
            : ko.status === "canceled"
              ? "canceled"
              : filled > 0 && filled < count
                ? "partial"
                : "open";

        const timestamp = ko.created_time || now();

        const limitPrice = ko.side === "yes" ? parsed.yesPrice : parsed.noPrice;
        if (!limitPrice) {
          log.debug(`Skipping import of order ${ko.order_id}: no price data`);
          continue;
        }

        // Cross-reference signals table to recover signalId for bot orders
        const [matchedSignal] = await db
          .select({ id: signals.id })
          .from(signals)
          .where(and(eq(signals.orderId, ko.order_id), eq(signals.acted, true)))
          .limit(1);

        const result = await db.insert(orders).values({
          orderId: ko.order_id,
          ticker: ko.ticker,
          action: ko.action,
          side: ko.side,
          limitPrice,
          quantity: count,
          filledQuantity: filled,
          status,
          dryRun: false,
          signalId: matchedSignal?.id ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }).onConflictDoNothing();
        if (result.changes > 0) imported++;
        } catch (err) {
          log.warn(`Failed to process order ${ko.order_id}: ${err instanceof Error ? err.message : err}`);
        }
      }

      if (imported > 0 || repaired > 0) {
        log.info(
          `Historical orders: ${imported} imported, ${repaired} repaired`
        );
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

        if (existing.length > 0) {
          // Even if calibration exists, backfill market result if missing
          const [mkt] = await db.select().from(markets).where(eq(markets.ticker, s.ticker)).limit(1);
          if (mkt && !mkt.result) {
            const res = s.market_result === "all_yes" ? "yes" : s.market_result === "all_no" ? "no" : s.market_result;
            await db.update(markets).set({ result: res, status: "finalized", updatedAt: now() }).where(eq(markets.ticker, s.ticker));
          }
          continue;
        }

        // Look up market for metadata
        const [market] = await db
          .select()
          .from(markets)
          .where(eq(markets.ticker, s.ticker))
          .limit(1);

        // Backfill market result if missing
        if (market && !market.result) {
          const res = s.market_result === "all_yes" ? "yes" : s.market_result === "all_no" ? "no" : s.market_result;
          await db.update(markets).set({ result: res, status: "finalized", updatedAt: now() }).where(eq(markets.ticker, s.ticker));
        }

        // Look up signal if the bot generated one
        const [signal] = await db
          .select()
          .from(signals)
          .where(eq(signals.ticker, s.ticker))
          .limit(1);

        const actualOutcome =
          s.market_result === "yes" || s.market_result === "all_yes" ? 1 : 0;

        // Check if there are bot-attributable orders (signal_id IS NOT NULL).
        // Only bot orders count — manual trades imported by syncHistoricalOrders
        // have signal_id = NULL and must NOT be counted as bot-traded.
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

        const traded = botOrders.length > 0;

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

        // Compute PnL from bot-attributable orders only
        const realizedPnl = computePerSidePnl(botOrders, actualOutcome);

        // Compute market price from bot orders
        const buys = botOrders
          .filter((o) => o.action === "buy")
          .map((o) => ({ price: o.limitPrice, qty: o.filledQuantity }));
        const marketPrice = signal?.marketPrice
          ?? (buys.length > 0
            ? buys.reduce((s, r) => s + r.price * r.qty, 0) /
              buys.reduce((s, r) => s + r.qty, 0) / 100
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

        // Backfill actual observed value and recompute station bias
        if (market?.targetDate && market?.stationId) {
          await this.backfillActualValue(market);
          await this.recomputeStationBias(market.stationId);
        }

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

    // Find resolved markets that don't have calibration records yet. The bot's
    // lifecycle marks markets as 'finalized' on resolution (see lines 256, 678,
    // 693); 'settled' is a legacy value never written by current code. Without
    // 'finalized' here, this entire branch was dead — calibration only grew
    // via syncSettlements which is gated on the user having a position.
    const settledMarkets = await db
      .select()
      .from(markets)
      .where(inArray(markets.status, ["settled", "finalized"]));

    for (const market of settledMarkets) {
      if (!market.result) continue;

      // Check if calibration record already exists
      const existing = await db
        .select()
        .from(calibration)
        .where(eq(calibration.ticker, market.ticker))
        .limit(1);

      const calibrationAlreadyExists = existing.length > 0;

      if (!calibrationAlreadyExists) {
        // Find the most recent signal for this market
        const [signal] = await db
          .select()
          .from(signals)
          .where(eq(signals.ticker, market.ticker))
          .limit(1);

        if (!signal) {
          // No signal means we never evaluated this market — fall through to
          // backfill so weather_forecasts.actual_value can still be populated
          // for the empirical-sigma feedback loop.
        } else {
          // Compute realized PnL from bot-attributable orders, with trades as fallback
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
            realizedPnl = computePerSidePnl(botOrders, outcome);
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

      // Backfill weather_forecasts.actual_value and recompute station_bias for
      // every resolved market with a station, regardless of whether the
      // calibration row was just created or already exists. This makes the
      // weather feedback loop retroactively recoverable: if NWS didn't have
      // observations at the time the calibration was first inserted (e.g.
      // observations lag market settlement), a later tick will succeed and
      // fill the actuals. backfillActualValue itself is idempotent — it
      // returns early when all rows for the date already have actual_value
      // populated, so the cost on no-op ticks is one short SELECT per market.
      if (
        market.targetDate &&
        market.stationId &&
        new Date(market.targetDate) < new Date()
      ) {
        await this.backfillActualValue(market);
        await this.recomputeStationBias(market.stationId);
      }
    }
  }

  /**
   * Try to backfill the actual observed value for a resolved market.
   *
   * Priority (win-rate-80-addendum-2026-06-05.md N1 item 2 / Finding 11), via
   * `resolveActualValue`: the NWS CLI climate report (`actual_source = 'cli'`,
   * the exact settlement value) → the settled YES bracket center
   * (`'settlement'`, unbiased but interval-censored ±1°F) → the NWS-observation
   * fallback (`'obs_max'`, interval-biased; disagreed with settlement on ~70% of
   * days — see Finding 1).
   *
   * When cached forecast rows exist, their `actual_value`/`actual_source` are
   * filled. When no row exists (cache evicted, DB reset, retention gap), a
   * synthetic row is synthesized from the most recent signal's reasoning trace
   * for this market so the station-bias feedback loop survives any retention
   * issue.
   */
  private async backfillActualValue(market: {
    ticker?: string;
    stationId: string | null;
    targetDate: string | null;
    category: string;
  }): Promise<void> {
    if (!market.stationId || !market.targetDate) return;

    const db = getDb();

    const forecasts = await db
      .select()
      .from(weatherForecasts)
      .where(
        and(
          eq(weatherForecasts.stationId, market.stationId),
          eq(weatherForecasts.targetDate, market.targetDate)
        )
      );

    const hasAnyRow = forecasts.length > 0;
    const hasUnfilledRow = forecasts.some((f) => f.actualValue == null);
    if (hasAnyRow && !hasUnfilledRow) return;

    const resolved = await this.resolveActualValue(
      market.stationId,
      market.targetDate,
      market.category
    );
    if (resolved == null) return;
    const { value: actual, source } = resolved;

    if (hasUnfilledRow) {
      for (const f of forecasts) {
        if (f.actualValue == null) {
          await db
            .update(weatherForecasts)
            .set({ actualValue: actual, actualSource: source })
            .where(eq(weatherForecasts.id, f.id));
        }
      }
      log.debug(
        `Backfilled actual ${market.category} for ${market.stationId} on ${market.targetDate}: ${actual.toFixed(1)} (${source})`
      );
      return;
    }

    // No row exists — synthesize one from the signal's reasoning trace so the
    // (point_forecast, actual_value) pair needed by recomputeStationBias survives.
    if (!market.ticker) return;

    const synthesized = await this.synthesizeForecastFromSignal(
      market.ticker,
      market.stationId,
      market.targetDate,
      market.category,
      actual,
      source
    );
    if (synthesized) {
      log.debug(
        `Synthesized weather_forecast for ${market.stationId} ${market.targetDate} from signal trace: actual=${actual.toFixed(1)} (${source})`
      );
    }
  }

  /**
   * Resolve the authoritative actual value for a station/date/category.
   *
   * Priority (win-rate-80-addendum-2026-06-05.md N1 item 2 / Finding 11):
   *   1. NWS CLI report — the LITERAL settlement source; an EXACT value.
   *   2. Kalshi settlement interval — unbiased but interval-censored, so its
   *      midpoint carries ±1°F uniform noise (σ≈0.58°F) on the 2°F brackets.
   *   3. obs_max — max/min of NWS hourly obs (interval-biased; disagreed with
   *      settlement ~70% of days).
   * Returns `{ value, source }` or null if no path produces a number.
   * Centralizes the priority so every backfill caller behaves identically.
   */
  private async resolveActualValue(
    stationId: string,
    targetDate: string,
    category: string
  ): Promise<{ value: number; source: "cli" | "settlement" | "obs_max" } | null> {
    // 1. Primary: official NWS CLI climate report (exact settlement value).
    //    Only the temperature categories have a CLI max/min; accept only a
    //    non-null reading for the requested category.
    if (category === "high_temp" || category === "low_temp") {
      const cli = await this.nwsService.getCliReport(stationId, targetDate);
      const cliValue =
        category === "high_temp" ? cli?.maxTempF : cli?.minTempF;
      if (cliValue != null) return { value: cliValue, source: "cli" };
    }

    // 2. Kalshi settlement (interval-censored but unbiased).
    const settled = await this.deriveSettlementActual(
      stationId,
      targetDate,
      category
    );
    if (settled != null) return settled;

    // 3. Fallback: max/min of NWS hourly observations over the local day.
    const obs = await this.fetchNwsActualValue(stationId, targetDate, category);
    if (obs != null) return { value: obs, source: "obs_max" };

    return null;
  }

  /**
   * Derive the official actual value from the settled YES Kalshi market for a
   * station/date/category — the authoritative settlement truth (N1). Kalshi
   * settles on the official NWS climate report, so the YES bracket is guaranteed
   * to contain the true high; its center is an unbiased estimator (vs. the
   * obs-max path which lands inside the YES bracket only ~30% of the time).
   *
   * - bracket    YES → midpoint (bracketLow + bracketHigh) / 2
   * - upper_tail YES (actual > bracketLow) → bracketLow + 0.5
   * - lower_tail YES (actual < bracketLow) → bracketLow − 0.5
   * - no settled YES row → null (unsettled or data gap → caller falls back)
   */
  private async deriveSettlementActual(
    stationId: string,
    targetDate: string,
    category: string
  ): Promise<{ value: number; source: "settlement" } | null> {
    const db = getDb();

    const [yesMarket] = await db
      .select()
      .from(markets)
      .where(
        and(
          eq(markets.stationId, stationId),
          eq(markets.targetDate, targetDate),
          eq(markets.category, category),
          eq(markets.result, "yes")
        )
      )
      .limit(1);

    if (!yesMarket || yesMarket.bracketLow == null) return null;

    if (yesMarket.marketType === "upper_tail") {
      return { value: yesMarket.bracketLow + 0.5, source: "settlement" };
    }
    if (yesMarket.marketType === "lower_tail") {
      return { value: yesMarket.bracketLow - 0.5, source: "settlement" };
    }
    // bracket: need an upper bound for the midpoint.
    if (yesMarket.bracketHigh == null) return null;
    return {
      value: (yesMarket.bracketLow + yesMarket.bracketHigh) / 2,
      source: "settlement",
    };
  }

  /**
   * Fetch observed value from NWS for a given station/date/category (obs_max
   * fallback path, used only when settlement truth is unavailable — N1).
   *
   * Windows on the station's LOCAL calendar day (via its IANA timezone) rather
   * than the UTC day: the legacy `T00:00:00Z → T23:59:59Z` window pulled the
   * previous local evening into the max and clipped the afternoon peak, a
   * primary driver of the obs-vs-settlement disagreement (Finding 1). Also
   * refuses to run until the local day is COMPLETE (now past the local midnight
   * that ends targetDate) — backfilling mid-afternoon would record a partial-day
   * max as the daily high. Returns null in that case so a later pass retries.
   */
  private async fetchNwsActualValue(
    stationId: string,
    targetDate: string,
    category: string
  ): Promise<number | null> {
    try {
      const tz = stationTz(stationId);
      const { startUtc, endUtc } = localDayWindowUtc(targetDate, tz);

      // Local day not finished yet → defer (avoid recording a partial-day max).
      if (Date.now() < endUtc.getTime()) return null;

      const res = await fetch(
        `https://api.weather.gov/stations/${stationId}/observations?start=${startUtc.toISOString()}&end=${endUtc.toISOString()}`,
        { headers: { "User-Agent": "KalshiClimateBot/1.0" } }
      );
      if (!res.ok) return null;

      const data = (await res.json()) as {
        features: Array<{
          properties: {
            temperature?: { value: number | null };
            maxTemperatureLast24Hours?: { value: number | null };
            minTemperatureLast24Hours?: { value: number | null };
            precipitationLastHour?: { value: number | null };
          };
        }>;
      };

      if (!data.features?.length) return null;

      let maxTemp: number | null = null;
      let minTemp: number | null = null;
      let totalPrecip = 0;

      for (const f of data.features) {
        const p = f.properties;
        // The instantaneous `temperature` field is reliably populated on
        // every observation (~5–60 minute cadence). The precomputed
        // `maxTemperatureLast24Hours` / `minTemperatureLast24Hours` fields
        // exist on the schema but are null on the vast majority of stations
        // — relying on them silently leaves actual_value=null for every
        // resolved market and starves station_bias / empirical sigma. Take
        // the day-spanning max/min from per-observation readings, with the
        // precomputed fields kept as a tighter source if present.
        const observed = p.temperature?.value;
        if (observed != null) {
          const valF = observed * 9 / 5 + 32;
          if (maxTemp == null || valF > maxTemp) maxTemp = valF;
          if (minTemp == null || valF < minTemp) minTemp = valF;
        }
        if (p.maxTemperatureLast24Hours?.value != null) {
          const valF = p.maxTemperatureLast24Hours.value * 9 / 5 + 32;
          if (maxTemp == null || valF > maxTemp) maxTemp = valF;
        }
        if (p.minTemperatureLast24Hours?.value != null) {
          const valF = p.minTemperatureLast24Hours.value * 9 / 5 + 32;
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

      return actualMap[category] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Reconstruct a weather_forecasts row from the most recent signal's
   * reasoning trace for this market. Returns true if a row was inserted.
   */
  private async synthesizeForecastFromSignal(
    ticker: string,
    stationId: string,
    targetDate: string,
    category: string,
    actual: number,
    actualSource: "cli" | "settlement" | "obs_max" = "obs_max"
  ): Promise<boolean> {
    const db = getDb();

    const [signal] = await db
      .select()
      .from(signals)
      .where(eq(signals.ticker, ticker))
      .orderBy(sql`${signals.createdAt} DESC`)
      .limit(1);

    if (!signal?.reasoning) return false;

    let trace: {
      correctedEnsembleStats?: { mean?: number; std?: number };
      rawEnsembleStats?: { mean?: number; std?: number; count?: number };
      forecastHorizon?: number;
    };
    try {
      trace = JSON.parse(signal.reasoning);
    } catch {
      return false;
    }

    const pointForecast = trace.correctedEnsembleStats?.mean;
    if (pointForecast == null) return false;

    await db.insert(weatherForecasts).values({
      id: uuid(),
      stationId,
      targetDate,
      source: "backfilled",
      forecastType: category,
      forecastHorizon: Math.max(1, trace.forecastHorizon ?? 1),
      pointForecast,
      ensembleValues: null,
      ensembleSize: trace.rawEnsembleStats?.count ?? null,
      ensembleMean: trace.rawEnsembleStats?.mean ?? null,
      ensembleStd: trace.rawEnsembleStats?.std ?? null,
      actualValue: actual,
      actualSource,
      fetchedAt: now(),
    });

    return true;
  }

  /**
   * Warm the weather_forecasts cache for future horizons so multi-day
   * station_bias rows can populate over time. Without this, the cache only
   * stores horizon=1 rows (the bot trades same-day in sniper mode), so
   * recomputeStationBias only ever produces horizon=1 bias entries. Gated by
   * config.bot.multiHorizonBiasMaxDays (0 = disabled). Rate-limited to once
   * per hour to keep external API quota in check (~6 stations × N horizons
   * × Open-Meteo fetches).
   */
  async warmMultiHorizonForecasts(): Promise<number> {
    const config = getConfig();
    const maxDays = config.bot.multiHorizonBiasMaxDays ?? 0;
    if (maxDays < 2) return 0;

    const HOUR_MS = 60 * 60 * 1000;
    if (Date.now() - this.lastMultiHorizonWarmAt < HOUR_MS) return 0;
    this.lastMultiHorizonWarmAt = Date.now();

    const stations = config.bot.enabledStations ?? [];
    const todayMs = Date.now();
    let warmed = 0;

    for (const stationId of stations) {
      for (let h = 2; h <= maxDays; h++) {
        const target = new Date(todayMs + h * 86400_000)
          .toISOString()
          .slice(0, 10);
        try {
          await this.ensembleService.getEnsembleValues(
            stationId,
            target,
            "high_temp",
            h * 24
          );
          warmed++;
        } catch (err) {
          log.debug(
            `Multi-horizon warm failed for ${stationId} h=${h}: ${err instanceof Error ? err.message : err}`
          );
        }
      }
    }

    if (warmed > 0) {
      log.info(`Warmed ${warmed} multi-horizon forecast row(s)`);
    }
    return warmed;
  }

  /**
   * Backfill actual_value on weather_forecasts rows for past target dates that
   * weren't tied to a traded market (so the existing market-resolution
   * backfill never touched them). Needed so warmMultiHorizonForecasts'd rows
   * become usable training data for recomputeStationBias. Capped per cycle to
   * avoid hammering NWS, and rate-limited to once per hour.
   */
  async backfillHistoricalForecastActuals(limit = 50): Promise<number> {
    const config = getConfig();
    if ((config.bot.multiHorizonBiasMaxDays ?? 0) < 2) return 0;

    const HOUR_MS = 60 * 60 * 1000;
    if (Date.now() - this.lastActualsBackfillAt < HOUR_MS) return 0;
    this.lastActualsBackfillAt = Date.now();

    const db = getDb();
    const yesterday = new Date(Date.now() - 86400_000)
      .toISOString()
      .slice(0, 10);

    const stale = await db
      .select()
      .from(weatherForecasts)
      .where(
        and(
          sql`${weatherForecasts.targetDate} < ${yesterday}`,
          sql`${weatherForecasts.actualValue} IS NULL`
        )
      )
      .limit(limit);

    if (stale.length === 0) return 0;

    let filled = 0;
    const touchedStations = new Set<string>();
    for (const f of stale) {
      // Same settlement-first priority as the market-resolution backfill (N1):
      // a settled YES bracket wins over the obs-max fallback. Multi-horizon rows
      // for a station+date often coexist with that date's settled markets.
      const resolved = await this.resolveActualValue(
        f.stationId,
        f.targetDate,
        f.forecastType
      );
      if (resolved == null) continue;
      await db
        .update(weatherForecasts)
        .set({ actualValue: resolved.value, actualSource: resolved.source })
        .where(eq(weatherForecasts.id, f.id));
      filled++;
      touchedStations.add(f.stationId);
    }

    if (filled > 0) {
      log.info(
        `Backfilled actual_value on ${filled} historical forecast row(s)`
      );
      // Refresh station_bias for any station whose rows just gained an actual
      // — otherwise the multi-horizon bias entries wouldn't appear until the
      // next market resolution for that station.
      for (const stationId of touchedStations) {
        await this.recomputeStationBias(stationId);
      }
    }
    return filled;
  }

  /**
   * N11 ground-truth mismatch telemetry (win-rate-80-addendum-2026-06-05.md).
   *
   * Finding 1 — our recorded `actual_value` disagreed with the Kalshi YES
   * settlement on ~70% of days — went undetected for ~3 months. This is the
   * permanent regression alarm: over the trailing 14 days, for every settled
   * YES bracket market joined to a weather_forecasts row on (station, date),
   * compute the fraction whose `actual_value` lies inside [bracketLow,
   * bracketHigh). Logs a per-station summary at info and warns when the overall
   * rate < 90%. Deliberately NOT a `bot:error` bus event — that would spam the
   * TUI; we keep it queryable via the stable `ground-truth health:` log prefix.
   *
   * Rate-limited to once per hour (same pattern as warmMultiHorizonForecasts).
   */
  /**
   * Run the N9 auto station-health gate (addendum N9). Rolling settled win
   * rates per station disable losers below 45% and re-enable above 55%
   * (hysteresis), writing the `disabled_stations` runtime row that
   * `evaluateEntryGates` consumes. Confirmation trades are excluded from the
   * rates inside the gate itself. Rate-limited to once per hour.
   */
  async runStationHealthGate(): Promise<void> {
    const HOUR_MS = 60 * 60 * 1000;
    if (Date.now() - this.lastStationHealthAt < HOUR_MS) return;
    this.lastStationHealthAt = Date.now();

    try {
      const decisions = await updateStationHealthGate();
      const acted = decisions.filter((d) => d.action !== "hold");
      if (acted.length > 0) {
        log.info(
          `station health gate: ${acted
            .map((d) => `${d.stationId} ${d.action} (${d.reason})`)
            .join("; ")}`
        );
      }
    } catch (err) {
      log.warn(
        `station health gate failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  async checkGroundTruthHealth(): Promise<void> {
    const HOUR_MS = 60 * 60 * 1000;
    if (Date.now() - this.lastGroundTruthHealthAt < HOUR_MS) return;
    this.lastGroundTruthHealthAt = Date.now();

    const db = getDb();
    const cutoff = new Date(Date.now() - 14 * 86400_000)
      .toISOString()
      .slice(0, 10);

    // Settled YES bracket markets in the window, joined to their forecast rows.
    // Only `bracket` markets have a finite [low, high) to test containment on;
    // tails have no upper bound so they're excluded from the metric.
    const rows = await db
      .select({
        stationId: markets.stationId,
        bracketLow: markets.bracketLow,
        bracketHigh: markets.bracketHigh,
        actualValue: weatherForecasts.actualValue,
      })
      .from(markets)
      .innerJoin(
        weatherForecasts,
        and(
          eq(weatherForecasts.stationId, markets.stationId),
          eq(weatherForecasts.targetDate, markets.targetDate)
        )
      )
      .where(
        and(
          eq(markets.result, "yes"),
          eq(markets.marketType, "bracket"),
          sql`${markets.targetDate} >= ${cutoff}`,
          sql`${weatherForecasts.actualValue} IS NOT NULL`,
          sql`${markets.bracketLow} IS NOT NULL`,
          sql`${markets.bracketHigh} IS NOT NULL`
        )
      );

    if (rows.length === 0) return;

    const perStation = new Map<string, { inside: number; total: number }>();
    let insideAll = 0;
    for (const r of rows) {
      const station = r.stationId ?? "unknown";
      const inside =
        r.actualValue! >= r.bracketLow! && r.actualValue! < r.bracketHigh!;
      const s = perStation.get(station) ?? { inside: 0, total: 0 };
      s.total += 1;
      if (inside) {
        s.inside += 1;
        insideAll += 1;
      }
      perStation.set(station, s);
    }

    const overallPct = (insideAll / rows.length) * 100;
    const perStationStr = [...perStation.entries()]
      .map(
        ([st, s]) =>
          `${st} ${((s.inside / s.total) * 100).toFixed(0)}% (${s.inside}/${s.total})`
      )
      .join(", ");

    const summary = `ground-truth health: ${overallPct.toFixed(1)}% inside YES bracket over 14d (n=${rows.length}) — ${perStationStr}`;
    if (overallPct < 90) {
      log.warn(summary);
    } else {
      log.info(summary);
    }
  }

  /**
   * Recompute rolling station bias for all horizons of a station.
   * Public + DB-only (no network): the one-time ground-truth rebuild
   * (scripts/rebuild-ground-truth.ts, N1 step 5) calls this directly after
   * wiping station_bias and repairing actuals from settlement.
   */
  async recomputeStationBias(stationId: string): Promise<void> {
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

    // Group by category (forecastType) + horizon
    const byKey = new Map<string, { category: string; horizon: number; errors: number[] }>();

    for (const f of forecasts) {
      if (f.pointForecast == null || f.actualValue == null) continue;
      const horizon = Math.min(f.forecastHorizon, 7);
      const category = f.forecastType || "high_temp";
      const key = `${category}_${horizon}`;
      let group = byKey.get(key);
      if (!group) {
        group = { category, horizon, errors: [] };
        byKey.set(key, group);
      }
      group.errors.push(f.pointForecast - f.actualValue);
    }

    const timestamp = now();

    for (const [, group] of byKey) {
      const n = group.errors.length;
      if (n === 0) continue;

      const meanBias = group.errors.reduce((a, b) => a + b, 0) / n;
      const variance =
        group.errors.reduce((s, e) => s + (e - meanBias) ** 2, 0) / n;
      const stdBias = Math.sqrt(variance);

      const biasId = `${stationId}_${group.category}_${group.horizon}`;

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
          category: group.category,
          forecastHorizonDays: group.horizon,
          meanBias,
          stdBias,
          sampleSize: n,
          windowDays,
          updatedAt: timestamp,
        });
      }
    }

    log.debug(
      `Updated station bias for ${stationId}: ${byKey.size} horizon(s)`
    );
  }

  /**
   * D2. Repair calibration records:
   * - Fix traded=0 records that have trades in the trades table
   * - Recompute PnL for traded records with realizedPnl=0
   */
  private async repairCalibrationPnl(): Promise<void> {
    const db = getDb();

    // Find records that are either: traded=1 with pnl=0, or traded=0 but have trades
    // Only repair traded records with zero PnL — bot orders may have been
    // repaired (filledQuantity updated) after the calibration was created.
    // Do NOT use trades table as fallback — it includes manual trades.
    const stale = await db
      .select()
      .from(calibration)
      .where(
        sql`${calibration.traded} = 1 AND ${calibration.realizedPnl} = 0`
      );

    if (stale.length === 0) return;

    let repaired = 0;

    for (const cal of stale) {
      const botOrders = await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.ticker, cal.ticker),
            eq(orders.status, "filled"),
            sql`${orders.signalId} IS NOT NULL`
          )
        );

      const hasFilledQty = botOrders.some((o) => o.filledQuantity > 0);
      if (!hasFilledQty) continue;

      const pnl = computePerSidePnl(botOrders, cal.actualOutcome);
      if (pnl === 0) continue;

      await db
        .update(calibration)
        .set({ realizedPnl: pnl })
        .where(eq(calibration.id, cal.id));
      repaired++;
    }

    if (repaired > 0) {
      log.info(`Repaired PnL for ${repaired} calibration record(s)`);
    }
  }

  /**
   * E. Snapshot current balance and equity.
   */
  private async snapshotBalance(): Promise<void> {
    const config = getConfig();
    const db = getDb();

    let balance: number;
    let kalshiPortfolioValue: number | undefined;

    if (config.bot.dryRun) {
      // Compute paper balance dynamically from the seed + ledger of paper
      // activity. The previous behavior (read latest balance_history row and
      // copy it forward) never deducted buy costs or applied realized PnL,
      // so the paper "balance" stayed frozen at the seed value regardless
      // of fills or settlements.
      //
      // Formula: balance = seed − sum(open paper position cost basis)
      //                         + sum(realized PnL on resolved paper trades)
      //
      // Open paper positions tie up capital. Resolved paper trades have
      // their net PnL recorded in `calibration.realized_pnl`. Together with
      // the seed, this is the honest cash figure.
      const seedRows = await db
        .select({ balance: balanceHistory.balance })
        .from(balanceHistory)
        .where(eq(balanceHistory.dryRun, true))
        .orderBy(balanceHistory.recordedAt) // ASC — earliest is the seed
        .limit(1);
      const seedBalance = seedRows[0]?.balance ?? 10000;

      const openPaperCostRows = await db
        .select({ s: sql<number>`COALESCE(SUM(${positions.costBasis}), 0)` })
        .from(positions)
        .where(eq(positions.dryRun, true));
      const openPaperCost = Number(openPaperCostRows[0]?.s ?? 0);

      // Paper-attributable realized PnL: calibration rows whose ticker has a
      // dry_run=1 bot order. Mirrors the EXISTS-style filter used in
      // performance routes.
      const realizedRows = await db
        .select({
          s: sql<number>`COALESCE(SUM(${calibration.realizedPnl}), 0)`,
        })
        .from(calibration)
        .where(
          sql`${calibration.traded} = 1 AND EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.ticker} = ${calibration.ticker} AND ${orders.signalId} IS NOT NULL AND ${orders.dryRun} = 1)`
        );
      const realizedPaperPnl = Number(realizedRows[0]?.s ?? 0);

      balance = Math.round(seedBalance - openPaperCost + realizedPaperPnl);
    } else {
      const kalshiBalance = await this.kalshi.getBalance();
      balance = kalshiBalance.balance;
      kalshiPortfolioValue = kalshiBalance.portfolio_value;
    }

    // Sum position market values from local DB
    const openPositions = await db.select().from(positions);
    const localPositionValue = openPositions.reduce(
      (sum, p) => sum + (p.marketValue ?? 0),
      0
    );

    // Sum realized PnL from all calibration records
    const calRecords = await db.select().from(calibration);
    const realizedPnl = calRecords.reduce(
      (sum, c) => sum + (c.realizedPnl ?? 0),
      0
    );

    // Use Kalshi's portfolio_value as authoritative when available,
    // fall back to local position value calculation
    const positionValue = kalshiPortfolioValue ?? localPositionValue;
    const portfolio = balance + positionValue;

    await db.insert(balanceHistory).values({
      id: uuid(),
      balance,
      totalEquity: Math.round(portfolio),
      openPositions: openPositions.length,
      realizedPnl: Math.round(realizedPnl),
      recordedAt: now(),
      dryRun: config.bot.dryRun,
    });

    bus.emit("balance:update", {
      cash: balance,
      portfolio: Math.round(portfolio),
    });

    const profit = Math.max(0, balance - config.bot.seedCapital);
    const profitReserve = Math.round(profit * config.bot.profitReservePct);
    const reserveStr = profitReserve > 0 ? `, profit reserve $${(profitReserve / 100).toFixed(2)}` : "";

    log.info(
      `Snapshot: cash $${(balance / 100).toFixed(2)}, ${openPositions.length} positions, portfolio $${(portfolio / 100).toFixed(2)}${reserveStr}`
    );
  }
}

/**
 * Compute realized PnL for a settled market, handling cross-side orders correctly.
 *
 * Selling NO is NOT the same as closing a YES long — it opens a short NO position
 * with its own settlement obligation. This function computes PnL per side and sums.
 *
 * For each side:
 *   netQty = buyQty - sellQty  (positive = long, negative = short)
 *   settlement = netQty × 100  if that side won, else 0
 *   sidePnl = settlement + sellProceeds - buyCost - takerFees
 *
 * Every fill pays the Kalshi taker fee (the bot enters and exits at crossing
 * prices). Settlement itself is fee-free. This is what flows into
 * `calibration.realized_pnl` and therefore the paper balance — without it,
 * paper PnL overstates by ~0.8¢/contract at confirmation prices.
 */
export function computePerSidePnl(
  orderRows: Array<{ action: string; side: string; limitPrice: number; filledQuantity: number }>,
  actualOutcome: number, // 1 = YES won, 0 = NO won
): number {
  let yesBuyCost = 0, yesBuyQty = 0, yesSellProceeds = 0, yesSellQty = 0;
  let noBuyCost = 0, noBuyQty = 0, noSellProceeds = 0, noSellQty = 0;
  let fees = 0;

  for (const o of orderRows) {
    const cost = o.limitPrice * o.filledQuantity;
    fees += takerFeeCents(o.limitPrice, o.filledQuantity);
    if (o.side === "yes") {
      if (o.action === "buy") { yesBuyCost += cost; yesBuyQty += o.filledQuantity; }
      else { yesSellProceeds += cost; yesSellQty += o.filledQuantity; }
    } else {
      if (o.action === "buy") { noBuyCost += cost; noBuyQty += o.filledQuantity; }
      else { noSellProceeds += cost; noSellQty += o.filledQuantity; }
    }
  }

  const yesNetQty = yesBuyQty - yesSellQty;
  const noNetQty = noBuyQty - noSellQty;
  const yesWon = actualOutcome === 1;

  // Settlement: net position × $1 if that side won (negative for shorts)
  const yesSettlement = yesWon ? yesNetQty * 100 : 0;
  const noSettlement = !yesWon ? noNetQty * 100 : 0;

  return (yesSettlement + yesSellProceeds - yesBuyCost) +
         (noSettlement + noSellProceeds - noBuyCost) -
         fees;
}
