import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { bus, type BotEvents } from "@kcb/engine";
import { getDb, positions as positionsTable, markets, sql } from "@kcb/db";
import { getConfig } from "@kcb/config";

type SignalEntry = BotEvents["signal:new"] & { isScout?: boolean; forecastHorizonHours?: number };

/** Compute hours until a market enters the sniper window */
function hoursToSniperEntry(closeTime: string | null, targetDate: string | null, sniperHorizon: number): number | null {
  let closeMs: number;
  if (closeTime) {
    closeMs = new Date(closeTime).getTime();
  } else if (targetDate) {
    closeMs = new Date(targetDate + "T23:59:00Z").getTime();
  } else {
    return null;
  }
  const hoursToClose = (closeMs - Date.now()) / 3_600_000;
  if (hoursToClose <= 0) return null;
  const hoursToSniper = hoursToClose - sniperHorizon;
  return hoursToSniper;
}

export function Dashboard() {
  const config = getConfig();
  const [signals, setSignals] = useState<SignalEntry[]>([]);
  const [positions, setPositions] = useState<BotEvents["position:update"][]>([]);
  const [recentOrders, setRecentOrders] = useState<BotEvents["order:placed"][]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [sniperCountdown, setSniperCountdown] = useState<{ ticker: string; hoursToSniper: number; hoursToClose: number }[]>([]);

  useEffect(() => {
    // Seed positions from DB so we show existing contracts on launch
    const loadPositions = async () => {
      const db = getDb();
      const dbPositions = await db.select().from(positionsTable);
      setPositions(
        dbPositions.map((p) => ({
          ticker: p.ticker,
          side: p.side,
          quantity: p.quantity,
          unrealizedPnl: p.unrealizedPnl ?? 0,
          avgEntryPrice: p.avgEntryPrice,
        })),
      );
    };
    loadPositions();

    // Load sniper countdown data
    const loadSniperCountdown = async () => {
      const sniperHorizon = config.bot.sniperHorizonHours;
      if (sniperHorizon <= 0) return;

      const db = getDb();
      const openMarkets = await db
        .select({ ticker: markets.ticker, closeTime: markets.closeTime, targetDate: markets.targetDate })
        .from(markets)
        .where(sql`${markets.status} = 'open'`);

      const entries = openMarkets
        .map((m) => {
          const hoursToSniper = hoursToSniperEntry(m.closeTime, m.targetDate, sniperHorizon);
          if (hoursToSniper == null) return null;
          let closeMs: number;
          if (m.closeTime) closeMs = new Date(m.closeTime).getTime();
          else if (m.targetDate) closeMs = new Date(m.targetDate + "T23:59:00Z").getTime();
          else return null;
          const hoursToClose = (closeMs - Date.now()) / 3_600_000;
          return { ticker: m.ticker, hoursToSniper, hoursToClose };
        })
        .filter((e): e is NonNullable<typeof e> => e != null && e.hoursToClose > 0)
        .sort((a, b) => a.hoursToSniper - b.hoursToSniper)
        .slice(0, 5);

      setSniperCountdown(entries);
    };
    loadSniperCountdown();

    const unsubs = [
      bus.on("signal:new", (s) =>
        setSignals((prev) => [{ ...s, isScout: false }, ...prev].slice(0, 10))
      ),
      bus.on("signal:scout", (s) =>
        setSignals((prev) => [{
          ...s,
          recommendation: "skip" as const,
          isScout: true,
          forecastHorizonHours: s.forecastHorizonHours,
        }, ...prev].slice(0, 10))
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
      bus.on("bot:status", () => { loadSniperCountdown(); }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const sniperHorizon = config.bot.sniperHorizonHours;

  return (
    <Box flexDirection="column" gap={1}>
      {/* Sniper Countdown */}
      {sniperHorizon > 0 && sniperCountdown.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="cyan">Next Sniper Window</Text>
          {sniperCountdown.map((e) => {
            const isNow = e.hoursToSniper <= 0;
            const sniperLabel = isNow
              ? "NOW"
              : e.hoursToSniper < 1
                ? `in ${(e.hoursToSniper * 60).toFixed(0)}m`
                : `in ${e.hoursToSniper.toFixed(1)}h`;
            const closeLabel = e.hoursToClose < 1
              ? `${(e.hoursToClose * 60).toFixed(0)}m`
              : `${e.hoursToClose.toFixed(1)}h`;

            return (
              <Box key={e.ticker} gap={2}>
                <Text>{e.ticker}</Text>
                <Text color={isNow ? "green" : "yellow"} bold>
                  {sniperLabel}
                </Text>
                <Text color="gray">
                  (close in {closeLabel}, sniper at {sniperHorizon}h)
                </Text>
                {isNow && <Text color="green">← actively trading</Text>}
              </Box>
            );
          })}
        </Box>
      )}

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
              {s.isScout ? (
                <Text color="yellow">
                  SCOUT ({s.forecastHorizonHours?.toFixed(1) ?? "?"}h)
                </Text>
              ) : (
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
              )}
              <Text>
                edge: {(s.edge * 100).toFixed(1)}¢ conf:{" "}
                {(s.confidence * 100).toFixed(0)}%
              </Text>
              {/* Sigma indicator */}
              {s.sigmaSource && (
                <Text color={s.sigmaSource === "empirical" ? "cyan" : "gray"}>
                  {s.sigmaSource === "empirical" ? "E" : "S"}
                </Text>
              )}
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
