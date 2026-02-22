import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { bus, type BotEvents } from "@kcb/engine";

const PHASES = ["Discovery", "Estimation", "Evaluation", "Execution", "Reconciliation"] as const;

/** Map log module names to pipeline phases */
const MODULE_TO_PHASE: Record<string, string> = {
  discovery: "Discovery",
  estimation: "Estimation",
  evaluation: "Evaluation",
  execution: "Execution",
  reconciliation: "Reconciliation",
  orchestrator: "Discovery", // orchestrator kicks off with discovery
};

interface EventEntry {
  time: string;
  text: string;
  color: string;
}

interface TickSummary {
  tickCount: number;
  marketsDiscovered: number;
  signalsGenerated: number;
  actionableSignals: number;
  ordersPlaced: number;
  lastDuration: string;
}

export function ActivityView() {
  const [activePhase, setActivePhase] = useState<string | null>(null);
  const [tickCount, setTickCount] = useState(0);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [summary, setSummary] = useState<TickSummary>({
    tickCount: 0,
    marketsDiscovered: 0,
    signalsGenerated: 0,
    actionableSignals: 0,
    ordersPlaced: 0,
    lastDuration: "—",
  });

  // Accumulate per-tick counters
  const counters = React.useRef({
    markets: 0,
    signals: 0,
    actionable: 0,
    orders: 0,
  });

  const pushEvent = (text: string, color: string) => {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    setEvents((prev) => [{ time, text, color }, ...prev].slice(0, 20));
  };

  useEffect(() => {
    const unsubs = [
      bus.on("bot:status", (s) => {
        setTickCount(s.tickCount);
        // Finalize summary for this tick
        setSummary({
          tickCount: s.tickCount,
          marketsDiscovered: counters.current.markets,
          signalsGenerated: counters.current.signals,
          actionableSignals: counters.current.actionable,
          ordersPlaced: counters.current.orders,
          lastDuration: `${(s.uptime % 60).toFixed(1)}s`,
        });
        // Reset counters for next tick
        counters.current = { markets: 0, signals: 0, actionable: 0, orders: 0 };
      }),

      bus.on("log", (l) => {
        const phase = MODULE_TO_PHASE[l.module.toLowerCase()];
        if (phase) setActivePhase(phase);
      }),

      bus.on("market:discovered", (m) => {
        counters.current.markets++;
        pushEvent(`Discovered ${m.ticker} — ${m.title}`, "cyan");
      }),

      bus.on("signal:new", (s) => {
        counters.current.signals++;
        if (s.recommendation !== "skip") counters.current.actionable++;
        const color = s.recommendation === "skip" ? "gray" : "green";
        pushEvent(
          `Signal ${s.ticker} ${s.recommendation.toUpperCase()} edge=${(s.edge * 100).toFixed(1)}¢`,
          color,
        );
      }),

      bus.on("order:placed", (o) => {
        counters.current.orders++;
        const color = o.dryRun ? "yellow" : "green";
        const tag = o.dryRun ? " [DRY]" : "";
        pushEvent(
          `Order ${o.action.toUpperCase()} ${o.side.toUpperCase()} ${o.ticker} ×${o.quantity} @${o.price}¢${tag}`,
          color,
        );
      }),

      bus.on("order:update", (o) => {
        pushEvent(`Order ${o.orderId.slice(0, 8)}… ${o.status} (filled ${o.filledQuantity})`, "green");
      }),

      bus.on("market:resolved", (m) => {
        const color = m.realizedPnl != null && m.realizedPnl > 0 ? "green" : m.realizedPnl != null && m.realizedPnl < 0 ? "red" : "white";
        const pnl = m.realizedPnl != null ? ` PnL ${m.realizedPnl > 0 ? "+" : ""}${(m.realizedPnl / 100).toFixed(2)}` : "";
        pushEvent(`Resolved ${m.ticker} → ${m.result.toUpperCase()}${pnl}`, color);
      }),

      bus.on("balance:update", (b) => {
        pushEvent(`Balance $${(b.balance / 100).toFixed(2)} | Equity $${(b.totalEquity / 100).toFixed(2)}`, "white");
      }),

      bus.on("bot:error", (e) => {
        pushEvent(`ERROR [${e.module}] ${e.message}`, "red");
      }),
    ];

    return () => unsubs.forEach((u) => u());
  }, []);

  return (
    <Box flexDirection="column">
      {/* Pipeline Status */}
      <Text bold color="cyan">Pipeline Status</Text>
      <Box gap={0} marginBottom={1}>
        {PHASES.map((phase, i) => (
          <React.Fragment key={phase}>
            <Text
              bold={activePhase === phase}
              color={activePhase === phase ? "green" : "gray"}
            >
              {activePhase === phase ? `[${phase}]` : ` ${phase} `}
            </Text>
            {i < PHASES.length - 1 && <Text color="gray"> → </Text>}
          </React.Fragment>
        ))}
        <Text color="gray">  │ Tick #{tickCount}</Text>
      </Box>

      {/* Tick Summary */}
      <Box>
        <Text color="white">
          Tick #{summary.tickCount} | {summary.marketsDiscovered} markets | {summary.signalsGenerated} signals ({summary.actionableSignals} actionable) | {summary.ordersPlaced} orders | {summary.lastDuration}
        </Text>
      </Box>

      <Text color="gray">{"─".repeat(80)}</Text>

      {/* Live Event Feed */}
      <Text bold color="cyan">Live Events</Text>
      {events.length === 0 ? (
        <Text color="gray">Waiting for events…</Text>
      ) : (
        events.map((e, i) => (
          <Box key={`${e.time}-${i}`} gap={1}>
            <Text color="gray">{e.time}</Text>
            <Text color={e.color}>{e.text}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}
