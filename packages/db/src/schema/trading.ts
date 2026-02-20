import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/**
 * Orders placed on Kalshi — both pending and filled.
 */
export const orders = sqliteTable("orders", {
  /** Kalshi order ID */
  orderId: text("order_id").primaryKey(),
  /** Market ticker */
  ticker: text("ticker").notNull(),
  /** "buy" or "sell" */
  action: text("action").notNull(),
  /** "yes" or "no" */
  side: text("side").notNull(),
  /** Limit price in cents */
  limitPrice: integer("limit_price").notNull(),
  /** Number of contracts requested */
  quantity: integer("quantity").notNull(),
  /** Number filled so far */
  filledQuantity: integer("filled_quantity").notNull().default(0),
  /** "open", "filled", "partial", "canceled", "expired" */
  status: text("status").notNull().default("open"),
  /** Signal ID that triggered this order */
  signalId: text("signal_id"),
  /** Dry run order? Not actually placed on Kalshi */
  dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(false),
  /** Kelly fraction used */
  kellyFraction: real("kelly_fraction"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Filled trades — individual fills from orders.
 */
export const trades = sqliteTable("trades", {
  /** Internal trade ID */
  id: text("id").primaryKey(),
  /** Parent order ID */
  orderId: text("order_id").notNull(),
  /** Market ticker */
  ticker: text("ticker").notNull(),
  /** "yes" or "no" */
  side: text("side").notNull(),
  /** Fill price in cents */
  price: integer("price").notNull(),
  /** Number of contracts */
  quantity: integer("quantity").notNull(),
  /** "buy" or "sell" */
  action: text("action").notNull(),
  filledAt: text("filled_at").notNull(),
});

/**
 * Current open positions — computed from trades but cached for fast reads.
 */
export const positions = sqliteTable("positions", {
  /** Market ticker */
  ticker: text("ticker").primaryKey(),
  /** "yes" or "no" */
  side: text("side").notNull(),
  /** Total contracts held */
  quantity: integer("quantity").notNull(),
  /** Average entry price in cents */
  avgEntryPrice: real("avg_entry_price").notNull(),
  /** Total cost basis in cents */
  costBasis: real("cost_basis").notNull(),
  /** Current market value in cents (quantity * lastPrice) */
  marketValue: real("market_value"),
  /** Unrealized PnL in cents */
  unrealizedPnl: real("unrealized_pnl"),
  /** When this position was opened */
  openedAt: text("opened_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
