import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/**
 * Kalshi markets we're tracking or have traded.
 * Maps 1:1 with Kalshi's market concept.
 */
export const markets = sqliteTable("markets", {
  /** Kalshi market ticker, e.g. KXHIGHNY-25FEB19-B37 */
  ticker: text("ticker").primaryKey(),
  /** Kalshi event ticker / series, e.g. KXHIGHNY-25FEB19 */
  eventTicker: text("event_ticker").notNull(),
  /** Series ticker, e.g. KXHIGHNY */
  seriesTicker: text("series_ticker").notNull(),
  /** Human-readable title */
  title: text("title").notNull(),
  /** Market category: high_temp, low_temp, precip, snowfall, etc. */
  category: text("category").notNull(),
  /** NWS station ID, e.g. KNYC, KORD */
  stationId: text("station_id"),
  /** Target date the weather event applies to (YYYY-MM-DD) */
  targetDate: text("target_date"),
  /** Lower bound of the bracket (e.g., 36 for "36° to 37°") */
  bracketLow: real("bracket_low"),
  /** Upper bound of the bracket (e.g., 37 for "36° to 37°") */
  bracketHigh: real("bracket_high"),
  /** "open", "closed", "settled" */
  status: text("status").notNull().default("open"),
  /** Market close time (ISO 8601) */
  closeTime: text("close_time"),
  /** Settlement result: "yes", "no", null if unresolved */
  result: text("result"),
  /** Last known YES price in cents (0-100) */
  lastYesPrice: integer("last_yes_price"),
  /** Last known NO price in cents (0-100) */
  lastNoPrice: integer("last_no_price"),
  /** When we first saw this market */
  discoveredAt: text("discovered_at").notNull(),
  /** Last time we updated this record */
  updatedAt: text("updated_at").notNull(),
});

export type Market = typeof markets.$inferSelect;
export type NewMarket = typeof markets.$inferInsert;
