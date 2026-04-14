import React from "react";
import { Text } from "ink";
import Table from "../components/table";
import { getDb, markets, eq, desc } from "@kcb/db";
import { getConfig } from "@kcb/config";
import type { CommandDef, CommandResult } from "./index";

const CAT: Record<string, string> = { high_temp: "HIGH", low_temp: "LOW", precip: "RAIN", snowfall: "SNOW" };

export const marketsCommands: CommandDef[] = [
  {
    name: "markets",
    aliases: ["ls", "list"],
    description: "List tracked markets",
    usage: "markets [--status open|closed|settled]",
    handler: async (args): Promise<CommandResult> => {
      const db = getDb();
      const statusFilter = args.find((a) => !a.startsWith("-"));

      let query = db
        .select({
          ticker: markets.ticker,
          title: markets.title,
          category: markets.category,
          status: markets.status,
          lastYesPrice: markets.lastYesPrice,
          closeTime: markets.closeTime,
        })
        .from(markets)
        .orderBy(desc(markets.updatedAt))
        .limit(20);

      if (statusFilter) {
        query = query.where(eq(markets.status, statusFilter)) as typeof query;
      }

      const rows = await query;

      if (rows.length === 0) {
        return "No markets found. Start the bot to begin discovery.";
      }

      const data = rows.map((r) => ({
        type: CAT[r.category] ?? r.category,
        ticker: r.ticker,
        price: r.lastYesPrice != null ? `${r.lastYesPrice}¢` : "—",
        status: r.status,
        closes: r.closeTime
          ? new Date(r.closeTime).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "—",
      }));

      return React.createElement(Table, {
        data,
        columns: ["type", "ticker", "price", "status", "closes"],
        cell: ({ children, column }: { children: React.ReactNode; column: string }) => {
          const val = String(children);
          if (column === "status") {
            const color = val === "open" ? "green" : val === "closed" ? "yellow" : "gray";
            return React.createElement(Text, { color }, children);
          }
          return React.createElement(Text, null, children);
        },
      });
    },
  },
  {
    name: "inspect",
    description: "Show details for a market ticker",
    usage: "inspect <ticker>",
    handler: async (args) => {
      if (!args[0]) return "Usage: inspect <ticker>";

      const db = getDb();
      const [market] = await db
        .select()
        .from(markets)
        .where(eq(markets.ticker, args[0]!))
        .limit(1);

      if (!market) {
        return `Market ${args[0]} not found in database.`;
      }

      return [
        `Ticker:    ${market.ticker}`,
        `Event:     ${market.eventTicker}`,
        `Series:    ${market.seriesTicker}`,
        `Title:     ${market.title}`,
        `Category:  ${market.category}`,
        `Station:   ${market.stationId || "—"}`,
        `Target:    ${market.targetDate || "—"}`,
        `Bracket:   ${market.bracketLow ?? "—"} to ${market.bracketHigh ?? "—"}`,
        `Status:    ${market.status}`,
        `Result:    ${market.result || "pending"}`,
        `YES price: ${market.lastYesPrice ?? "—"}¢`,
        `NO price:  ${market.lastNoPrice ?? "—"}¢`,
        `Closes:    ${market.closeTime || "—"}`,
        `Discovered: ${market.discoveredAt}`,
      ].join("\n");
    },
  },
];
