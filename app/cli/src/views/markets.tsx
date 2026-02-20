import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { bus, type BotEvents } from "@kcb/engine";

interface MarketRow {
  ticker: string;
  title: string;
  yesPrice?: number;
  estimate?: number;
  edge?: number;
  confidence?: number;
}

export function MarketsView() {
  const [markets, setMarkets] = useState<MarketRow[]>([]);

  useEffect(() => {
    const unsub = bus.on("signal:new", (s) => {
      setMarkets((prev) => {
        const idx = prev.findIndex((m) => m.ticker === s.ticker);
        const row: MarketRow = {
          ticker: s.ticker,
          title: s.ticker, // TODO: resolve from DB
          yesPrice: Math.round(s.marketPrice * 100),
          estimate: s.estimatedProb,
          edge: s.edge,
          confidence: s.confidence,
        };
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = row;
          return next;
        }
        return [...prev, row];
      });
    });
    return unsub;
  }, []);

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Active Markets ({markets.length})
      </Text>

      {/* Header */}
      <Box gap={1}>
        <Box width={30}>
          <Text bold color="gray">TICKER</Text>
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

      <Text color="gray">{"─".repeat(65)}</Text>

      {markets.length === 0 ? (
        <Text color="gray">No markets discovered yet. Start the bot with `start` in REPL.</Text>
      ) : (
        markets.map((m) => (
          <Box key={m.ticker} gap={1}>
            <Box width={30}>
              <Text>{m.ticker}</Text>
            </Box>
            <Box width={8}>
              <Text>{m.yesPrice ?? "—"}¢</Text>
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
