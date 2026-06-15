import { test, expect, beforeAll } from "bun:test";
import { bus } from "@kcb/engine";
import { runMigrations } from "@kcb/db";
import { initCache, getCachedSnapshot, getCachedPerformance } from "./viz-cache";

beforeAll(() => {
  runMigrations();
});

test("getCachedSnapshot returns snapshot without throwing", () => {
  const snap = getCachedSnapshot();
  expect(snap).toBeDefined();
  expect(Array.isArray(snap.positions)).toBe(true);
  expect(Array.isArray(snap.stations)).toBe(true);
  expect(Array.isArray(snap.recentOrders)).toBe(true);
});

test("getCachedPerformance returns perf data without throwing", () => {
  const perf = getCachedPerformance();
  expect(perf).toBeDefined();
  expect(typeof perf.winRate).toBe("number");
  expect(Array.isArray(perf.windowedWinRates)).toBe(true);
  expect(Array.isArray(perf.equityHistory)).toBe(true);
});

test("initCache does not throw and bus events do not throw", () => {
  expect(() => initCache()).not.toThrow();
  expect(() => {
    bus.emit("balance:update", { cash: 1000, portfolio: 2000 });
    bus.emit("order:placed", {
      orderId: "ord1",
      ticker: "KXHIGHNY-26JAN01-B50",
      action: "buy",
      side: "yes",
      price: 55,
      quantity: 3,
      dryRun: false,
    });
    bus.emit("market:resolved", {
      ticker: "KXHIGHNY-26JAN01-B50",
      result: "yes",
      realizedPnl: 150,
    });
  }).not.toThrow();
});

test("getCachedSnapshot returns same reference between calls (cache hit)", () => {
  const a = getCachedSnapshot();
  const b = getCachedSnapshot();
  expect(a).toBe(b);
});
