import { getDb, positions, trades, orders, desc, eq } from "@kcb/db";
import type { CommandDef } from "./index";

export const positionsCommands: CommandDef[] = [
  {
    name: "positions",
    aliases: ["pos"],
    description: "Show open positions",
    handler: async () => {
      const db = getDb();
      const rows = await db.select().from(positions).orderBy(desc(positions.updatedAt));

      if (rows.length === 0) {
        return "No open positions.";
      }

      const header = "TICKER".padEnd(30) + "SIDE".padEnd(6) + "QTY".padStart(5) + "  AVG".padStart(6) + "  P&L".padStart(8);
      const lines = rows.map((p) => {
        const pnl = p.unrealizedPnl ?? 0;
        const pnlStr = (pnl >= 0 ? "+" : "") + (pnl / 100).toFixed(2);
        return (
          p.ticker.padEnd(30) +
          p.side.toUpperCase().padEnd(6) +
          String(p.quantity).padStart(5) +
          `  ${p.avgEntryPrice.toFixed(0)}¢`.padStart(6) +
          `  ${pnlStr}`.padStart(8)
        );
      });

      return [header, "─".repeat(55), ...lines].join("\n");
    },
  },
  {
    name: "pnl",
    description: "Show realized PnL summary",
    handler: async () => {
      const db = getDb();
      const allTrades = await db.select().from(trades).orderBy(desc(trades.filledAt));

      if (allTrades.length === 0) {
        return "No trades yet.";
      }

      // Simple PnL calculation — buys are cost, market resolution is revenue
      const totalCost = allTrades
        .filter((t) => t.action === "buy")
        .reduce((sum, t) => sum + t.price * t.quantity, 0);

      return [
        `Total trades: ${allTrades.length}`,
        `Total cost: ${(totalCost / 100).toFixed(2)}`,
        `(Full PnL requires resolution data — see calibration summary)`,
      ].join("\n");
    },
  },
  {
    name: "orders",
    description: "Show recent orders",
    handler: async (args) => {
      const db = getDb();
      const status = args[0] || undefined;

      let query = db
        .select()
        .from(orders)
        .orderBy(desc(orders.createdAt))
        .limit(15);

      if (status) {
        query = query.where(eq(orders.status, status)) as typeof query;
      }

      const rows = await query;

      if (rows.length === 0) {
        return "No orders found.";
      }

      const header = "ORDER".padEnd(12) + "TICKER".padEnd(25) + "SIDE".padEnd(5) + "QTY".padStart(4) + " PRICE".padStart(6) + " STATUS".padEnd(10);
      const lines = rows.map((o) =>
        o.orderId.slice(0, 10).padEnd(12) +
        o.ticker.padEnd(25) +
        `${o.action[0]!.toUpperCase()}${o.side[0]!.toUpperCase()}`.padEnd(5) +
        String(o.quantity).padStart(4) +
        `  ${o.limitPrice}¢`.padStart(6) +
        ` ${o.status}`.padEnd(10) +
        (o.dryRun ? " [DRY]" : "")
      );

      return [header, "─".repeat(65), ...lines].join("\n");
    },
  },
];
