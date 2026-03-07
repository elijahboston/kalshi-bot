import type { ServerWebSocket } from "bun";
import { bus, type BotEvents } from "@kcb/engine";
import { getSnapshot } from "./api";

const clients = new Set<ServerWebSocket<unknown>>();
const unsubscribers: (() => void)[] = [];

/** Register a new WebSocket client */
export function addClient(ws: ServerWebSocket<unknown>): void {
  clients.add(ws);

  // Send initial snapshot
  const snapshot = getSnapshot();
  ws.send(JSON.stringify({ type: "snapshot", data: snapshot }));
}

/** Remove a disconnected client */
export function removeClient(ws: ServerWebSocket<unknown>): void {
  clients.delete(ws);
}

/** Broadcast a message to all connected clients */
function broadcast(type: string, data: unknown): void {
  if (clients.size === 0) return;
  const msg = JSON.stringify({ type, data });
  for (const ws of clients) {
    try {
      ws.send(msg);
    } catch {
      clients.delete(ws);
    }
  }
}

/** Start subscribing to bus events and forwarding to WS clients */
export function startBridge(): () => void {
  const events: (keyof BotEvents)[] = [
    "bot:status",
    "bot:error",
    "signal:new",
    "order:placed",
    "order:update",
    "position:update",
    "balance:update",
    "market:discovered",
    "market:resolved",
    "log",
  ];

  for (const event of events) {
    const unsub = bus.on(event, (data) => {
      broadcast(event, data);
    });
    unsubscribers.push(unsub);
  }

  return () => {
    for (const unsub of unsubscribers) unsub();
    unsubscribers.length = 0;
  };
}
