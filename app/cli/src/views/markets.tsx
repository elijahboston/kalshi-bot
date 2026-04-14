import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Table from "../components/table";
import { bus, type BotEvents } from "@kcb/engine";
import { getDb, markets, desc, sql } from "@kcb/db";

interface MarketRow {
  ticker: string;
  title: string;
  category: string;
  yesPrice?: number | null;
  targetDate?: string | null;
  closeTime?: string | null;
  status: string;
  estimate?: number;
  edge?: number;
  confidence?: number;
  forecastHorizonHours?: number;
  sigmaSource?: "empirical" | "ensemble";
}

/** Format hours-to-close with color-appropriate label */
function formatHoursToClose(closeTime?: string | null, targetDate?: string | null): string {
  let closeMs: number;
  if (closeTime) {
    closeMs = new Date(closeTime).getTime();
  } else if (targetDate) {
    closeMs = new Date(targetDate + "T23:59:00Z").getTime();
  } else {
    return "—";
  }
  const hoursLeft = (closeMs - Date.now()) / 3_600_000;
  if (hoursLeft <= 0) return "closed";
  if (hoursLeft < 1) return `${(hoursLeft * 60).toFixed(0)}m`;
  if (hoursLeft < 24) return `${hoursLeft.toFixed(1)}h`;
  return `${(hoursLeft / 24).toFixed(1)}d`;
}

/** Get color for hours-to-close */
function hoursColor(closeTime?: string | null, targetDate?: string | null): string {
  let closeMs: number;
  if (closeTime) {
    closeMs = new Date(closeTime).getTime();
  } else if (targetDate) {
    closeMs = new Date(targetDate + "T23:59:00Z").getTime();
  } else {
    return "gray";
  }
  const hoursLeft = (closeMs - Date.now()) / 3_600_000;
  if (hoursLeft < 6) return "red";
  if (hoursLeft < 12) return "yellow";
  return "gray";
}

export function MarketsView() {
  const [rows, setRows] = useState<MarketRow[]>([]);

  const loadMarkets = async () => {
    const db = getDb();
    const dbRows = await db
      .select()
      .from(markets)
      .where(sql`${markets.status} != 'settled'`)
      .orderBy(desc(markets.updatedAt))
      .limit(30);

    setRows((prev) => {
      const signalMap = new Map(prev.filter((r) => r.estimate != null).map((r) => [r.ticker, r]));
      return dbRows.map((m) => {
        const existing = signalMap.get(m.ticker);
        return {
          ticker: m.ticker,
          title: m.title,
          category: m.category,
          yesPrice: m.lastYesPrice,
          targetDate: m.targetDate,
          closeTime: m.closeTime,
          status: m.status,
          estimate: existing?.estimate,
          edge: existing?.edge,
          confidence: existing?.confidence,
          forecastHorizonHours: existing?.forecastHorizonHours,
          sigmaSource: existing?.sigmaSource,
        };
      });
    });
  };

  useEffect(() => {
    loadMarkets();

    const unsubs = [
      bus.on("market:discovered", () => { loadMarkets(); }),
      bus.on("market:priceUpdate", () => { loadMarkets(); }),
      bus.on("signal:new", (s) => {
        setRows((prev) => {
          const idx = prev.findIndex((m) => m.ticker === s.ticker);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = {
              ...next[idx]!,
              estimate: s.estimatedProb,
              edge: s.edge,
              confidence: s.confidence,
              forecastHorizonHours: s.forecastHorizonHours,
              sigmaSource: s.sigmaSource,
            };
            return next;
          }
          return prev;
        });
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const tableData = rows.map((m) => ({
    ticker: m.ticker,
    closeIn: formatHoursToClose(m.closeTime, m.targetDate),
    status: m.status,
    price: m.yesPrice != null ? `${m.yesPrice}¢` : "—",
    "our P": m.estimate != null ? `${(m.estimate * 100).toFixed(0)}%` : "—",
    "mkt P": m.yesPrice != null ? `${m.yesPrice}%` : "—",
    edge: m.edge != null ? `${m.edge > 0 ? "+" : ""}${(m.edge * 100).toFixed(1)}` : "—",
    conf: m.confidence != null ? `${(m.confidence * 100).toFixed(0)}%` : "—",
    σ: m.sigmaSource === "empirical" ? "E" : m.sigmaSource === "ensemble" ? "S" : "",
  }));

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Active Markets ({rows.length})
      </Text>

      {rows.length === 0 ? (
        <Text color="gray">No markets discovered yet. The bot will discover markets on each tick.</Text>
      ) : (
        <Table
          data={tableData}
          columns={["ticker", "closeIn", "status", "price", "our P", "mkt P", "edge", "conf", "σ"]}
          cell={({ children, column }) => {
            const val = String(children);
            // Status colors
            if (column === "status") {
              const color = val === "open" ? "green" : val === "closed" ? "yellow" : "gray";
              return <Text color={color}>{children}</Text>;
            }
            // Edge colors
            if (column === "edge" && val !== "—") {
              const num = parseFloat(val);
              const color = num > 8 ? "green" : num > 0 ? "yellow" : "red";
              return <Text color={color}>{children}</Text>;
            }
            // CloseIn colors
            if (column === "closeIn") {
              const row = tableData.find((r) => r.closeIn === val);
              if (row) {
                const mkt = rows.find((r) => formatHoursToClose(r.closeTime, r.targetDate) === val);
                if (mkt) {
                  const color = hoursColor(mkt.closeTime, mkt.targetDate);
                  return <Text color={color}>{children}</Text>;
                }
              }
            }
            // Our P - highlight strong conviction
            if (column === "our P" && val !== "—") {
              const pct = parseFloat(val);
              if (pct > 50) return <Text bold color="green">{children}</Text>;
            }
            return <Text>{children}</Text>;
          }}
        />
      )}
    </Box>
  );
}
