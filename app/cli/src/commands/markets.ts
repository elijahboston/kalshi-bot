import { getDb, markets, eq, desc } from "@kcb/db";
import { getConfig } from "@kcb/config";
import type { CommandDef } from "./index";

export const marketsCommands: CommandDef[] = [
  {
    name: "markets",
    aliases: ["ls", "list"],
    description: "List tracked markets",
    usage: "markets [--status open|closed|settled]",
    handler: async (args) => {
      const db = getDb();
      const statusFilter = args.find((a) => !a.startsWith("-"));

      let query = db
        .select({
          ticker: markets.ticker,
          title: markets.title,
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

      const header = "TICKER".padEnd(30) + "PRICE".padStart(6) + "  STATUS".padEnd(10) + "  CLOSES";
      const lines = rows.map((r) => {
        const price = r.lastYesPrice != null ? `${r.lastYesPrice}¢` : "—";
        const closes = r.closeTime
          ? new Date(r.closeTime).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "—";
        return (
          r.ticker.padEnd(30) +
          price.padStart(6) +
          `  ${r.status}`.padEnd(10) +
          `  ${closes}`
        );
      });

      return [header, "─".repeat(60), ...lines].join("\n");
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
