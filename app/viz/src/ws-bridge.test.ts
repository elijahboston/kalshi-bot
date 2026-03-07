import { test, expect, beforeAll } from "bun:test";
import { bus } from "@kcb/engine";
import { runMigrations } from "@kcb/db";
import { getConfig } from "@kcb/config";
import { startBridge } from "./ws-bridge";

beforeAll(() => {
  const config = getConfig();
  runMigrations(config.db.path);
});

test("startBridge returns cleanup function", () => {
  const stop = startBridge();
  expect(typeof stop).toBe("function");
  stop();
});

test("bridge does not throw with no clients connected", () => {
  const stop = startBridge();
  expect(() => {
    bus.emit("balance:update", { cash: 1000, portfolio: 2000 });
  }).not.toThrow();
  stop();
});

test("bridge subscribes to key events", () => {
  const stop = startBridge();
  // Emit various events — should not throw even with no clients
  expect(() => {
    bus.emit("signal:new", {
      id: "test",
      ticker: "KNYC-HIGH-25",
      side: "yes",
      edge: 0.05,
      confidence: 0.8,
      recommendation: "buy_yes",
      estimatedProb: 0.65,
      marketPrice: 60,
    });
    bus.emit("order:placed", {
      orderId: "ord1",
      ticker: "KNYC-HIGH-25",
      action: "buy",
      side: "yes",
      price: 60,
      quantity: 5,
      dryRun: false,
    });
    bus.emit("market:resolved", {
      ticker: "KNYC-HIGH-25",
      result: "yes",
      realizedPnl: 200,
    });
  }).not.toThrow();
  stop();
});
