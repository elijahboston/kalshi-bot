/**
 * Kalshi API schema validation tests.
 *
 * These hit the REAL Kalshi API to detect field name changes, missing fields,
 * or response format changes before they silently break the bot.
 *
 * Run manually: bun test packages/kalshi-client/src/api-schema.test.ts
 * These are skipped in the regular test suite (require API credentials + network).
 */
import { test, expect, describe } from "bun:test";
import { KalshiClient } from "./client";
import { parseMarketPrices } from "./types";

const hasCredentials = !!(process.env.KALSHI_API_KEY);

describe.skipIf(!hasCredentials)("Kalshi API schema validation", () => {
  const client = new KalshiClient();

  describe("GET /markets (market listing)", () => {
    test("returns markets with expected fields", async () => {
      const res = await client.getMarkets({ limit: 5 });

      expect(res.markets).toBeDefined();
      expect(res.markets!.length).toBeGreaterThan(0);

      const market = res.markets![0]!;

      // Core identity fields — these should never change
      expect(typeof market.ticker).toBe("string");
      expect(market.ticker.length).toBeGreaterThan(0);
      expect(typeof market.event_ticker).toBe("string");
      expect(typeof market.title).toBe("string");
      expect(typeof market.status).toBe("string");
      expect(["open", "active", "closed", "settled"]).toContain(market.status);
    });

    test("returns v3 dollar-string price fields", async () => {
      const res = await client.getMarkets({
        series_ticker: "KXHIGHNY",
        limit: 5,
      });

      expect(res.markets).toBeDefined();
      expect(res.markets!.length).toBeGreaterThan(0);

      const market = res.markets![0]!;

      // v3 dollar-string fields must exist
      expect(market).toHaveProperty("last_price_dollars");
      expect(market).toHaveProperty("yes_bid_dollars");
      expect(market).toHaveProperty("yes_ask_dollars");
      expect(market).toHaveProperty("no_bid_dollars");
      expect(market).toHaveProperty("no_ask_dollars");

      // They should be strings (even if "0.0000")
      expect(typeof market.last_price_dollars).toBe("string");
      expect(typeof market.yes_bid_dollars).toBe("string");
      expect(typeof market.yes_ask_dollars).toBe("string");
    });

    test("parseMarketPrices extracts valid cents from live data", async () => {
      const res = await client.getMarkets({
        series_ticker: "KXHIGHNY",
        limit: 10,
      });

      // Find a market with non-zero prices
      const withPrice = res.markets!.find(
        (m) => m.last_price_dollars && parseFloat(m.last_price_dollars) > 0
      );

      if (!withPrice) {
        console.warn("No markets with non-zero last_price found — skipping price parse check");
        return;
      }

      const prices = parseMarketPrices(withPrice);

      expect(prices.lastPrice).not.toBeNull();
      expect(prices.lastPrice).toBeGreaterThan(0);
      expect(prices.lastPrice).toBeLessThanOrEqual(100);
      expect(Number.isInteger(prices.lastPrice)).toBe(true);

      // Bid should be <= ask
      if (prices.yesBid != null && prices.yesAsk != null) {
        expect(prices.yesBid).toBeLessThanOrEqual(prices.yesAsk);
      }
    });

    test("pagination cursor field exists", async () => {
      const res = await client.getMarkets({ limit: 1 });
      expect(res).toHaveProperty("cursor");
    });
  });

  describe("GET /markets/:ticker (single market)", () => {
    let sampleTicker: string;

    test("returns market with full detail fields", async () => {
      // First grab a ticker from the listing
      const listing = await client.getMarkets({
        series_ticker: "KXHIGHNY",
        limit: 1,
      });
      sampleTicker = listing.markets![0]!.ticker;

      const data = await client.getMarket(sampleTicker);

      expect(data).toHaveProperty("market");
      const m = data.market;

      expect(m.ticker).toBe(sampleTicker);

      // Price fields
      expect(m).toHaveProperty("last_price_dollars");
      expect(m).toHaveProperty("yes_bid_dollars");
      expect(m).toHaveProperty("yes_ask_dollars");
      expect(m).toHaveProperty("no_bid_dollars");
      expect(m).toHaveProperty("no_ask_dollars");

      // Volume/OI fields (v3 uses _fp suffix)
      const hasVolume = "volume_fp" in m || "volume" in m;
      const hasOI = "open_interest_fp" in m || "open_interest" in m;
      expect(hasVolume).toBe(true);
      expect(hasOI).toBe(true);

      // Strike fields — floor_strike always present, cap_strike only for bracket markets
      expect(m).toHaveProperty("floor_strike");
      expect(typeof m.floor_strike).toBe("number");

      // Timing
      expect(m).toHaveProperty("close_time");
      expect(typeof m.close_time).toBe("string");
    });
  });

  describe("GET /portfolio/positions", () => {
    test("returns positions array", async () => {
      const res = await client.getPositions();

      expect(res).toHaveProperty("market_positions");
      expect(Array.isArray(res.market_positions)).toBe(true);

      // If there are positions, validate shape
      if (res.market_positions.length > 0) {
        const pos = res.market_positions[0]!;
        expect(pos).toHaveProperty("ticker");
        expect(typeof pos.ticker).toBe("string");
      }
    });
  });

  describe("GET /portfolio/balance", () => {
    test("returns balance as a number", async () => {
      const bal = await client.getBalance();

      expect(bal).toHaveProperty("balance");
      expect(typeof bal.balance).toBe("number");
      expect(bal.balance).toBeGreaterThanOrEqual(0);
    });
  });

  describe("GET /portfolio/orders (order listing)", () => {
    test("returns orders with expected fields", async () => {
      const res = await client.getOrders({});

      expect(res).toHaveProperty("orders");
      expect(Array.isArray(res.orders)).toBe(true);

      if (res.orders!.length > 0) {
        const order = res.orders![0]!;
        expect(order).toHaveProperty("order_id");
        expect(order).toHaveProperty("ticker");
        expect(order).toHaveProperty("action");
        expect(order).toHaveProperty("side");
        expect(order).toHaveProperty("status");

        // Quantity fields — validate whichever naming convention is current
        const hasV3QtyFields = "initial_count_fp" in order || "fill_count_fp" in order;
        const hasV2QtyFields = "initial_count" in order || "fill_count" in order;
        const hasV1QtyFields = "count" in order;
        expect(hasV3QtyFields || hasV2QtyFields || hasV1QtyFields).toBe(true);

        // Price fields on orders
        const hasV3Prices = "yes_price_dollars" in order || "no_price_dollars" in order;
        const hasV2Prices = "yes_price" in order || "no_price" in order;
        expect(hasV3Prices || hasV2Prices).toBe(true);
      }
    });
  });

  describe("field deprecation detection", () => {
    test("warns if legacy numeric price fields return non-null (API reverted)", async () => {
      const res = await client.getMarkets({
        series_ticker: "KXHIGHNY",
        limit: 1,
      });
      const m = res.markets![0]!;

      // If the old numeric fields come back with real values, our parsing
      // logic still handles them, but we should know about it
      if (typeof m.last_price === "number" && m.last_price > 0) {
        console.warn(
          "NOTICE: Legacy numeric last_price field is populated again. " +
          "Kalshi may have reverted the API change."
        );
      }

      // The test itself just validates that at least one format is present
      const hasDollarFields = typeof m.last_price_dollars === "string";
      const hasNumericFields = typeof m.last_price === "number" && m.last_price > 0;
      expect(hasDollarFields || hasNumericFields).toBe(true);
    });
  });
});
