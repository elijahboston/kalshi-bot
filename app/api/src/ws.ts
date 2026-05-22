import Elysia from "elysia";
import { bus, type BotEvents } from "@kcb/engine";
import { getDb, positions, balanceHistory, desc } from "@kcb/db";
import { loop } from "@kcb/engine";
import { getConfig } from "@kcb/config";

/** Build a snapshot of current state for new WebSocket clients */
function getSnapshot() {
  const db = getDb();
  const config = getConfig();

  const openPositions = db.select().from(positions).all();

  const [latestBal] = db
    .select()
    .from(balanceHistory)
    .orderBy(desc(balanceHistory.recordedAt))
    .limit(1)
    .all();

  const state = loop.getLoopState();

  return {
    status: {
      running: state.running,
      dryRun: config.bot.dryRun,
      tickCount: state.tickCount,
      lastTickAt: state.lastTickAt,
      uptime: state.startedAt ? Date.now() - state.startedAt : 0,
    },
    positions: openPositions,
    balance: latestBal
      ? { cash: latestBal.balance, portfolio: latestBal.totalEquity }
      : { cash: 0, portfolio: 0 },
  };
}

/** All bus events to forward over WebSocket */
const FORWARDED_EVENTS: (keyof BotEvents)[] = [
  "bot:status",
  "bot:error",
  "signal:new",
  "signal:scout",
  "forecast:fetched",
  "order:placed",
  "order:update",
  "position:update",
  "balance:update",
  "market:discovered",
  "market:priceUpdate",
  "market:resolved",
  "calibration:updated",
  "log",
];

/** Active WebSocket clients. Exported for testing. */
export const wsClients = new Set<{ send: (msg: string) => void }>();

const unsubscribers: (() => void)[] = [];
let bridgeStarted = false;

export const wsRoute = new Elysia().ws("/ws", {
  open(ws) {
    wsClients.add(ws);
    ws.send(JSON.stringify({ type: "snapshot", data: getSnapshot() }));
  },
  message(_ws, _message) {
    // Client messages not needed yet — future: topic subscription
  },
  close(ws) {
    wsClients.delete(ws);
  },
});

/** Broadcast a message to all connected clients */
function broadcast(msg: string): void {
  for (const ws of wsClients) {
    try {
      ws.send(msg);
    } catch {
      wsClients.delete(ws);
    }
  }
}

/**
 * Start forwarding bus events to all WebSocket clients.
 * Returns a stop function.
 */
export function startWsBridge(): () => void {
  if (bridgeStarted) return () => {};
  bridgeStarted = true;

  for (const event of FORWARDED_EVENTS) {
    const unsub = bus.on(event, (data) => {
      broadcast(JSON.stringify({ type: event, data }));
    });
    unsubscribers.push(unsub);
  }

  return () => {
    for (const unsub of unsubscribers) unsub();
    unsubscribers.length = 0;
    bridgeStarted = false;
  };
}
