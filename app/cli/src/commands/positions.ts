import React from "react";
import { Text } from "ink";
import Table from "../components/table";
import { getDb, positions, trades, orders, markets, desc, eq } from "@kcb/db";
import type { CommandDef, CommandResult } from "./index";

const CAT_LABELS: Record<string, string> = {
  high_temp: "HIGH", low_temp: "LOW", precip: "RAIN", snowfall: "SNOW",
};

export const positionsCommands: CommandDef[] = [
  {
    name: "positions",
    aliases: ["pos"],
    description: "Show open positions",
    handler: async (): Promise<CommandResult> => {
      const db = getDb();
      const rows = await db.select().from(positions).orderBy(desc(positions.updatedAt));

      if (rows.length === 0) {
        return "No open positions.";
      }

      const allMarkets = await db.select({ ticker: markets.ticker, category: markets.category }).from(markets);
      const catMap = new Map(allMarkets.map((m) => [m.ticker, m.category]));

      const data = rows.map((p) => {
        const pnl = p.unrealizedPnl ?? 0;
        const cat = catMap.get(p.ticker) ?? "?";
        return {
          type: CAT_LABELS[cat] ?? cat,
          ticker: p.ticker,
          side: p.side.toUpperCase(),
          qty: String(p.quantity),
          avg: `${p.avgEntryPrice.toFixed(0)}¢`,
          "p&l": `${pnl >= 0 ? "+" : ""}${(pnl / 100).toFixed(2)}`,
        };
      });

      return React.createElement(Table, {
        data,
        columns: ["type", "ticker", "side", "qty", "avg", "p&l"],
        cell: ({ children, column }: { children: React.ReactNode; column: string }) => {
          const val = String(children);
          if (column === "p&l") {
            const color = val.startsWith("+") ? "green" : val.startsWith("-") ? "red" : "gray";
            return React.createElement(Text, { color }, children);
          }
          return React.createElement(Text, null, children);
        },
      });
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
    handler: async (args): Promise<CommandResult> => {
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

      const data = rows.map((o) => ({
        order: o.orderId.slice(0, 10),
        ticker: o.ticker,
        side: `${o.action[0]!.toUpperCase()}${o.side[0]!.toUpperCase()}`,
        qty: String(o.quantity),
        price: `${o.limitPrice}¢`,
        status: o.status + (o.dryRun ? " [DRY]" : ""),
      }));

      return React.createElement(Table, {
        data,
        columns: ["order", "ticker", "side", "qty", "price", "status"],
        cell: ({ children, column }: { children: React.ReactNode; column: string }) => {
          const val = String(children);
          if (column === "status") {
            if (val.includes("filled")) return React.createElement(Text, { color: "green" }, children);
            if (val.includes("open")) return React.createElement(Text, { color: "yellow" }, children);
            if (val.includes("[DRY]")) return React.createElement(Text, { color: "yellow" }, children);
            return React.createElement(Text, { color: "gray" }, children);
          }
          return React.createElement(Text, null, children);
        },
      });
    },
  },
];
