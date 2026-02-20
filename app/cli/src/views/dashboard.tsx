import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { bus, type BotEvents } from "@kcb/engine";

export function Dashboard() {
  const [signals, setSignals] = useState<BotEvents["signal:new"][]>([]);
  const [positions, setPositions] = useState<BotEvents["position:update"][]>([]);
  const [recentOrders, setRecentOrders] = useState<BotEvents["order:placed"][]>([]);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    const unsubs = [
      bus.on("signal:new", (s) =>
        setSignals((prev) => [s, ...prev].slice(0, 10))
      ),
      bus.on("position:update", (p) =>
        setPositions((prev) => {
          const idx = prev.findIndex((x) => x.ticker === p.ticker);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = p;
            return next;
          }
          return [p, ...prev];
        })
      ),
      bus.on("order:placed", (o) =>
        setRecentOrders((prev) => [o, ...prev].slice(0, 5))
      ),
      bus.on("bot:error", (e) => setLastError(e.message)),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  return (
    <Box flexDirection="column" gap={1}>
      {/* Open Positions */}
      <Box flexDirection="column">
        <Text bold color="cyan">
          Open Positions ({positions.length})
        </Text>
        {positions.length === 0 ? (
          <Text color="gray"> No open positions</Text>
        ) : (
          positions.map((p) => (
            <Box key={p.ticker} gap={2}>
              <Text>{p.ticker}</Text>
              <Text color="gray">
                {p.side.toUpperCase()} × {p.quantity}
              </Text>
              <Text color={p.unrealizedPnl >= 0 ? "green" : "red"}>
                {p.unrealizedPnl >= 0 ? "+" : ""}
                {(p.unrealizedPnl / 100).toFixed(2)}
              </Text>
            </Box>
          ))
        )}
      </Box>

      {/* Recent Signals */}
      <Box flexDirection="column">
        <Text bold color="cyan">
          Recent Signals
        </Text>
        {signals.length === 0 ? (
          <Text color="gray"> Waiting for signals...</Text>
        ) : (
          signals.slice(0, 5).map((s) => (
            <Box key={s.id} gap={2}>
              <Text>{s.ticker}</Text>
              <Text
                color={
                  s.recommendation === "skip"
                    ? "gray"
                    : s.edge > 0.1
                      ? "green"
                      : "yellow"
                }
              >
                {s.recommendation.toUpperCase()}
              </Text>
              <Text>
                edge: {(s.edge * 100).toFixed(1)}¢ conf:{" "}
                {(s.confidence * 100).toFixed(0)}%
              </Text>
            </Box>
          ))
        )}
      </Box>

      {/* Recent Orders */}
      <Box flexDirection="column">
        <Text bold color="cyan">
          Recent Orders
        </Text>
        {recentOrders.length === 0 ? (
          <Text color="gray"> No recent orders</Text>
        ) : (
          recentOrders.map((o) => (
            <Box key={o.orderId} gap={2}>
              <Text>{o.ticker}</Text>
              <Text>
                {o.action.toUpperCase()} {o.side.toUpperCase()} × {o.quantity} @{" "}
                {o.price}¢
              </Text>
              {o.dryRun && <Text color="yellow">[DRY]</Text>}
            </Box>
          ))
        )}
      </Box>

      {/* Error */}
      {lastError && (
        <Box>
          <Text color="red">⚠ {lastError}</Text>
        </Box>
      )}

      <Text color="gray">Press [2] to enter REPL mode</Text>
    </Box>
  );
}
