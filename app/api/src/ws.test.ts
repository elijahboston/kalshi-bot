import { test, expect, beforeAll, describe } from "bun:test";
import { runMigrations } from "@kcb/db";
import { bus } from "@kcb/engine";
import { startApiServer } from "../index";

beforeAll(() => {
  runMigrations();
});

/**
 * Open a WebSocket and collect all messages received.
 * Returns the ws client and a messages array that mutates as messages arrive.
 */
async function connectWs(url: string): Promise<{
  ws: WebSocket;
  messages: any[];
}> {
  const ws = new WebSocket(url);
  const messages: any[] = [];
  ws.addEventListener("message", (e) => {
    messages.push(JSON.parse((e as MessageEvent).data));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) => reject(e));
  });
  return { ws, messages };
}

describe("WebSocket bridge", () => {
  test("sends snapshot on connect", async () => {
    const port = 3181;
    const server = startApiServer(port);

    try {
      const { ws, messages } = await connectWs(`ws://localhost:${port}/ws`);

      // Give snapshot a moment to arrive
      await new Promise((r) => setTimeout(r, 100));

      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(messages[0].type).toBe("snapshot");
      expect(messages[0].data).toHaveProperty("status");
      expect(messages[0].data).toHaveProperty("positions");
      expect(messages[0].data).toHaveProperty("balance");

      ws.close();
    } finally {
      server.stop();
    }
  });

  test("forwards bus events to connected clients", async () => {
    const port = 3182;
    const server = startApiServer(port);

    try {
      const { ws, messages } = await connectWs(`ws://localhost:${port}/ws`);
      await new Promise((r) => setTimeout(r, 50));

      // Emit a signal — bridge should forward it
      bus.emit("signal:new", {
        id: "ws-test-sig",
        ticker: "KXTEST-WS",
        side: "yes",
        edge: 0.1,
        confidence: 0.7,
        recommendation: "buy_yes",
        estimatedProb: 0.6,
        marketPrice: 0.5,
      });

      await new Promise((r) => setTimeout(r, 100));

      const signalMsg = messages.find((m) => m.type === "signal:new");
      expect(signalMsg).toBeDefined();
      expect(signalMsg.data.id).toBe("ws-test-sig");
      expect(signalMsg.data.ticker).toBe("KXTEST-WS");

      ws.close();
    } finally {
      server.stop();
    }
  });

  test("forwards multiple event types", async () => {
    const port = 3183;
    const server = startApiServer(port);

    try {
      const { ws, messages } = await connectWs(`ws://localhost:${port}/ws`);
      await new Promise((r) => setTimeout(r, 50));

      bus.emit("balance:update", { cash: 5000, portfolio: 8000 });
      bus.emit("order:placed", {
        orderId: "ord-1",
        ticker: "KXTEST-WS2",
        action: "buy",
        side: "yes",
        price: 50,
        quantity: 5,
        dryRun: true,
      });

      await new Promise((r) => setTimeout(r, 100));

      const types = messages.map((m) => m.type);
      expect(types).toContain("balance:update");
      expect(types).toContain("order:placed");

      ws.close();
    } finally {
      server.stop();
    }
  });

  test("broadcasts to multiple clients", async () => {
    const port = 3184;
    const server = startApiServer(port);

    try {
      const [a, b] = await Promise.all([
        connectWs(`ws://localhost:${port}/ws`),
        connectWs(`ws://localhost:${port}/ws`),
      ]);
      await new Promise((r) => setTimeout(r, 50));

      bus.emit("bot:status", {
        running: true,
        dryRun: true,
        lastTick: new Date().toISOString(),
        tickCount: 42,
        uptime: 1000,
      });

      await new Promise((r) => setTimeout(r, 100));

      const aStatus = a.messages.find((m) => m.type === "bot:status");
      const bStatus = b.messages.find((m) => m.type === "bot:status");
      expect(aStatus?.data.tickCount).toBe(42);
      expect(bStatus?.data.tickCount).toBe(42);

      a.ws.close();
      b.ws.close();
    } finally {
      server.stop();
    }
  });
});
