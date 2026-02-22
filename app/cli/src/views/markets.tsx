import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { bus, type BotEvents } from "@kcb/engine";
import { getDb, markets, desc, sql } from "@kcb/db";

interface MarketRow {
  ticker: string;
  title: string;
  category: string;
  yesPrice?: number | null;
  targetDate?: string | null;
  status: string;
  estimate?: number;
  edge?: number;
  confidence?: number;
}

export function MarketsView() {
  const [rows, setRows] = useState<MarketRow[]>([]);

  // Load markets from DB on mount and refresh on discovery/signal events
  const loadMarkets = async () => {
    const db = getDb();
    const dbRows = await db
      .select()
      .from(markets)
      .where(sql`${markets.status} != 'settled'`)
      .orderBy(desc(markets.updatedAt))
      .limit(30);

    setRows((prev) => {
      // Merge DB data with any signal data we already have
      const signalMap = new Map(prev.filter((r) => r.estimate != null).map((r) => [r.ticker, r]));
      return dbRows.map((m) => {
        const existing = signalMap.get(m.ticker);
        return {
          ticker: m.ticker,
          title: m.title,
          category: m.category,
          yesPrice: m.lastYesPrice,
          targetDate: m.targetDate,
          status: m.status,
          estimate: existing?.estimate,
          edge: existing?.edge,
          confidence: existing?.confidence,
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
            };
            return next;
          }
          return prev;
        });
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Active Markets ({rows.length})
      </Text>

      {/* Header */}
      <Box gap={1}>
        <Box width={28}>
          <Text bold color="gray">TICKER</Text>
        </Box>
        <Box width={10}>
          <Text bold color="gray">DATE</Text>
        </Box>
        <Box width={8}>
          <Text bold color="gray">STATUS</Text>
        </Box>
        <Box width={8}>
          <Text bold color="gray">PRICE</Text>
        </Box>
        <Box width={8}>
          <Text bold color="gray">EST</Text>
        </Box>
        <Box width={8}>
          <Text bold color="gray">EDGE</Text>
        </Box>
        <Box width={8}>
          <Text bold color="gray">CONF</Text>
        </Box>
      </Box>

      <Text color="gray">{"─".repeat(80)}</Text>

      {rows.length === 0 ? (
        <Text color="gray">No markets discovered yet. The bot will discover markets on each tick.</Text>
      ) : (
        rows.map((m) => (
          <Box key={m.ticker} gap={1}>
            <Box width={28}>
              <Text>{m.ticker}</Text>
            </Box>
            <Box width={10}>
              <Text color="gray">{m.targetDate ?? "—"}</Text>
            </Box>
            <Box width={8}>
              <Text color={m.status === "open" ? "green" : m.status === "closed" ? "yellow" : "gray"}>
                {m.status}
              </Text>
            </Box>
            <Box width={8}>
              <Text>{m.yesPrice != null ? `${m.yesPrice}¢` : "—"}</Text>
            </Box>
            <Box width={8}>
              <Text>
                {m.estimate != null
                  ? (m.estimate * 100).toFixed(0) + "¢"
                  : "—"}
              </Text>
            </Box>
            <Box width={8}>
              <Text
                color={
                  m.edge == null
                    ? "gray"
                    : m.edge > 0.08
                      ? "green"
                      : m.edge > 0
                        ? "yellow"
                        : "red"
                }
              >
                {m.edge != null ? (m.edge > 0 ? "+" : "") + (m.edge * 100).toFixed(1) : "—"}
              </Text>
            </Box>
            <Box width={8}>
              <Text>
                {m.confidence != null
                  ? (m.confidence * 100).toFixed(0) + "%"
                  : "—"}
              </Text>
            </Box>
          </Box>
        ))
      )}
    </Box>
  );
}
