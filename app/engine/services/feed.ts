import { KalshiFeed, type WsTickerMsg, type WsLifecycleMsg } from "@kcb/kalshi-client";
import { getDb, markets, eq } from "@kcb/db";
import { bus, createLogger } from "../events";
import { now } from "@kcb/shared";

const log = createLogger("feed");

let feed: KalshiFeed | null = null;

/**
 * Start the WebSocket feed and wire events into the bus + DB.
 */
export function startFeed(feedInstance: KalshiFeed): void {
  feed = feedInstance;

  feed.on({
    onConnected() {
      log.info("WebSocket connected");
      feed!.subscribe(["market_lifecycle_v2"]);
    },

    onDisconnected() {
      log.warn("WebSocket disconnected");
    },

    onError(err) {
      log.error("WebSocket error", err.message);
      bus.emit("bot:error", {
        module: "feed",
        message: err.message,
        error: err,
      });
    },

    onSequenceGap(gap) {
      // Sequence gaps are routine packet loss — the feed keeps flowing and
      // the next REST tick refreshes any state we might have missed. Logged
      // at warn (not error) and not raised as a bot:error to avoid drowning
      // real failures in noise.
      log.warn(
        `Sequence gap on sid ${gap.sid}: expected ${gap.expected}, got ${gap.got} (missed ${gap.missed})`
      );
    },

    onTicker(msg: WsTickerMsg) {
      const { market_ticker, price, yes_bid, yes_ask, volume, open_interest, ts } = msg.msg;

      log.debug(`Price update: ${market_ticker} yes=${price}`);

      // Update DB
      const db = getDb();
      db.update(markets)
        .set({
          lastYesPrice: price,
          lastNoPrice: price != null ? 100 - price : null,
          updatedAt: now(),
        })
        .where(eq(markets.ticker, market_ticker))
        .run();

      // Emit to bus
      bus.emit("market:priceUpdate", {
        ticker: market_ticker,
        yesPrice: price,
        noPrice: price != null ? 100 - price : price,
        volume,
        openInterest: open_interest,
        ts,
      });
    },

    onLifecycle(msg: WsLifecycleMsg) {
      const { market_ticker, event_type, status, result, title } = msg.msg;

      log.info(`Lifecycle: ${market_ticker} ${event_type}`);

      const db = getDb();
      const timestamp = now();

      if (event_type === "settled" && result) {
        // Market resolved
        db.update(markets)
          .set({
            status: "settled",
            result,
            updatedAt: timestamp,
          })
          .where(eq(markets.ticker, market_ticker))
          .run();

        // Only emit if result is "yes" or "no" (not "all_yes"/"all_no")
        if (result === "yes" || result === "no") {
          bus.emit("market:resolved", {
            ticker: market_ticker,
            result,
          });
        }
      } else if (event_type === "closed") {
        db.update(markets)
          .set({ status: "closed", updatedAt: timestamp })
          .where(eq(markets.ticker, market_ticker))
          .run();
      } else if (event_type === "new_market") {
        log.info(`New market via WebSocket: ${market_ticker}`);
        // New markets from lifecycle don't have full data — discovery will
        // pick them up on the next REST tick. We just emit for awareness.
        bus.emit("market:discovered", {
          ticker: market_ticker,
          eventTicker: msg.msg.event_ticker || "",
          title: title || market_ticker,
          category: "",
        });
      } else if (event_type === "close_time_update") {
        if (msg.msg.close_time) {
          db.update(markets)
            .set({ closeTime: msg.msg.close_time, updatedAt: timestamp })
            .where(eq(markets.ticker, market_ticker))
            .run();
        }
      }
    },
  });

  // Connect (lifecycle subscription sent in onConnected above)
  feed.connect();

  log.info("Feed service started");
}

/**
 * Subscribe the ticker channel to a set of market tickers.
 * Called after REST discovery finds markets to track.
 */
export function subscribeToTickers(tickers: string[]): void {
  if (!feed || !feed.isConnected || tickers.length === 0) return;

  const existingSid = feed.getSubscriptionId("ticker");
  if (existingSid !== undefined) {
    // Add to existing subscription
    feed.updateSubscription([existingSid], tickers, "add_markets");
    log.info(`Added ${tickers.length} ticker(s) to existing subscription`);
  } else {
    // Create new ticker subscription
    feed.subscribe(["ticker"], tickers);
    log.info(`Subscribed to ticker for ${tickers.length} market(s)`);
  }
}

/**
 * Stop the feed and disconnect.
 */
export function stopFeed(): void {
  if (feed) {
    feed.disconnect();
    feed = null;
    log.info("Feed service stopped");
  }
}
