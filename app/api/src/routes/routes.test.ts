import { test, expect, beforeAll, beforeEach, describe } from "bun:test";
import Elysia from "elysia";
import { runMigrations, getDb, calibration, signals, orders, balanceHistory, runtimeConfig, eq } from "@kcb/db";
import { statusRoutes } from "./status";
import { marketRoutes } from "./markets";
import { positionRoutes } from "./positions";
import { orderRoutes } from "./orders";
import { signalRoutes } from "./signals";
import { performanceRoutes } from "./performance";
import { logRoutes, startLogCapture } from "./logs";
import { bus } from "@kcb/engine";

beforeAll(() => {
  runMigrations();
});

// Build a single app with all routes for testing
const app = new Elysia()
  .use(statusRoutes)
  .use(marketRoutes)
  .use(positionRoutes)
  .use(orderRoutes)
  .use(signalRoutes)
  .use(performanceRoutes)
  .use(logRoutes);

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await app.handle(new Request(`http://localhost${path}`));
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function patch(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

describe("status routes", () => {
  test("GET /api/status returns bot state", async () => {
    const { status, body } = await get("/api/status");
    expect(status).toBe(200);
    expect(body).toHaveProperty("running");
    expect(body).toHaveProperty("dryRun");
    expect(body).toHaveProperty("tickCount");
    expect(body).toHaveProperty("uptime");
  });

  test("GET /api/config returns non-sensitive config", async () => {
    const { status, body } = await get("/api/config");
    expect(status).toBe(200);
    expect(body).toHaveProperty("bot");
    expect(body.bot).toHaveProperty("tickIntervalSec");
    expect(body).not.toHaveProperty("kalshi"); // credentials excluded
  });

  test("PATCH /api/config/dry-run persists the flag to runtime_config", async () => {
    // NOTE: Can't reliably assert GET /api/config after PATCH because other
    // test files (loop.test.ts, execution.test.ts) use mock.module("@kcb/config")
    // which leaks globally per project memory — some mocks return a fresh
    // {bot:{dryRun:true}} object on every getConfig() call, so the in-memory
    // mutation path is non-deterministic when running the full suite. The
    // DB-persistence path IS deterministic and is what matters for restarts.
    const db = getDb();

    // Set to false, verify DB row.
    let res = await patch("/api/config/dry-run", { dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body.current).toBe(false);
    let [row] = db
      .select()
      .from(runtimeConfig)
      .where(eq(runtimeConfig.key, "dry_run"))
      .all();
    expect(row?.value).toBe("false");

    // Flip to true, verify DB row updated.
    res = await patch("/api/config/dry-run", { dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.current).toBe(true);
    [row] = db
      .select()
      .from(runtimeConfig)
      .where(eq(runtimeConfig.key, "dry_run"))
      .all();
    expect(row?.value).toBe("true");

    // Clean up for downstream tests.
    await patch("/api/config/dry-run", { dryRun: false });
  });

  test("PATCH /api/config/dry-run rejects non-boolean body", async () => {
    const res = await patch("/api/config/dry-run", { dryRun: "maybe" });
    // Elysia schema validation rejects non-boolean with 4xx
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("market routes", () => {
  test("GET /api/markets returns an array", async () => {
    const { status, body } = await get("/api/markets?limit=5");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/markets respects limit param", async () => {
    const { body } = await get("/api/markets?limit=1");
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(1);
  });

  test("GET /api/markets/:ticker returns 404 for unknown ticker", async () => {
    const { status } = await get("/api/markets/NONEXISTENT-TICKER");
    expect(status).toBe(404);
  });
});

describe("position routes", () => {
  test("GET /api/positions returns array", async () => {
    const { status, body } = await get("/api/positions");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/balance returns cash and portfolio", async () => {
    const { status, body } = await get("/api/balance");
    expect(status).toBe(200);
    expect(body).toHaveProperty("cash");
    expect(body).toHaveProperty("portfolio");
  });

  test("GET /api/balance/history returns array", async () => {
    const { status, body } = await get("/api/balance/history?limit=10");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("order routes", () => {
  test("GET /api/orders returns array", async () => {
    const { status, body } = await get("/api/orders?limit=5");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/trades returns array", async () => {
    const { status, body } = await get("/api/trades?limit=5");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("signal routes", () => {
  test("GET /api/signals returns array", async () => {
    const { status, body } = await get("/api/signals?limit=5");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/signals/:id returns 404 for unknown id", async () => {
    const { status } = await get("/api/signals/nonexistent-id");
    expect(status).toBe(404);
  });
});

describe("performance routes", () => {
  test("GET /api/performance returns stats", async () => {
    const { status, body } = await get("/api/performance");
    expect(status).toBe(200);
    expect(body).toHaveProperty("cash");
    expect(body).toHaveProperty("portfolio");
    expect(body).toHaveProperty("unrealizedPnl");
    expect(body).toHaveProperty("realizedPnl");
    expect(body).toHaveProperty("winRate");
    expect(body).toHaveProperty("brierScore");
    expect(body).toHaveProperty("orderCount");
    expect(body).toHaveProperty("positionCount");
  });

  test("GET /api/performance/daily-pnl returns array", async () => {
    const { status, body } = await get("/api/performance/daily-pnl?days=7");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/performance/win-rates returns 3 windows", async () => {
    const { status, body } = await get("/api/performance/win-rates");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(3);
    expect(body[0]).toHaveProperty("label");
    expect(body[0]).toHaveProperty("rate");
  });

  test("GET /api/performance/daily-win-rates returns array", async () => {
    const { status, body } = await get("/api/performance/daily-win-rates?days=7");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/performance/daily-win-rates groups by day and excludes untraded rows", async () => {
    const db = getDb();
    db.delete(calibration).run();

    const mk = (id: string, resolvedAt: string, realizedPnl: number | null, traded: boolean) => ({
      id,
      ticker: `T-${id}`,
      seriesTicker: "KXHIGH",
      category: "high_temp",
      stationId: "KNYC",
      predictedProb: 0.5,
      actualOutcome: 0,
      marketPrice: 50,
      edge: 0,
      realizedPnl,
      traded,
      forecastHorizon: 1,
      resolvedAt,
    });

    db.insert(calibration)
      .values([
        mk("a1", "2026-04-20T12:00:00Z", 100, true),
        mk("a2", "2026-04-20T18:00:00Z", -50, true),
        mk("b1", "2026-04-21T10:00:00Z", 200, true),
        mk("b2", "2026-04-21T15:00:00Z", 150, true),
        mk("c1", "2026-04-22T08:00:00Z", -80, true),
        mk("d1", "2026-04-19T08:00:00Z", 99, false),
      ])
      .run();

    const { status, body } = await get("/api/performance/daily-win-rates?days=30");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);

    const byDate = new Map<string, any>(body.map((r: any) => [r.date, r]));
    expect(byDate.get("2026-04-20")).toEqual({ date: "2026-04-20", total: 2, wins: 1, winRate: 0.5 });
    expect(byDate.get("2026-04-21")).toEqual({ date: "2026-04-21", total: 2, wins: 2, winRate: 1 });
    expect(byDate.get("2026-04-22")).toEqual({ date: "2026-04-22", total: 1, wins: 0, winRate: 0 });
    expect(byDate.has("2026-04-19")).toBe(false); // untraded excluded

    const dates = body.map((r: any) => r.date);
    expect([...dates].sort()).toEqual(dates); // chronological ascending

    db.delete(calibration).run();
  });

  test("GET /api/performance/calibration returns 6 buckets", async () => {
    const { status, body } = await get("/api/performance/calibration");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(6);
    expect(body[0]).toHaveProperty("bucket");
    expect(body[0]).toHaveProperty("actualRate");
  });

  test("GET /api/performance/resolutions returns array", async () => {
    const { status, body } = await get("/api/performance/resolutions?limit=5");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("log routes", () => {
  test("GET /api/logs captures bus log events", async () => {
    const stopCapture = startLogCapture();

    bus.emit("log", {
      level: "info",
      module: "test-routes",
      message: "hello from test",
      timestamp: new Date().toISOString(),
    });

    const { status, body } = await get("/api/logs?module=test-routes&limit=10");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    const ours = body.find((l: any) => l.message === "hello from test");
    expect(ours).toBeDefined();
    expect(ours.module).toBe("test-routes");

    stopCapture();
  });

  test("GET /api/logs filters by level", async () => {
    const stopCapture = startLogCapture();

    bus.emit("log", {
      level: "error",
      module: "test-level",
      message: "error msg",
      timestamp: new Date().toISOString(),
    });
    bus.emit("log", {
      level: "info",
      module: "test-level",
      message: "info msg",
      timestamp: new Date().toISOString(),
    });

    const { body } = await get("/api/logs?module=test-level&level=error");
    expect(body.every((l: any) => l.level === "error")).toBe(true);

    stopCapture();
  });
});

describe("dryRun query filter", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(signals).run();
    db.delete(orders).run();
    db.delete(balanceHistory).run();
    db.delete(calibration).run();
  });

  function seedSignal(id: string, dryRun: boolean) {
    const db = getDb();
    db.insert(signals).values({
      id,
      ticker: `T-${id}`,
      seriesTicker: "KXHIGH",
      estimatedProb: 0.5,
      confidence: 0.9,
      marketPrice: 0.4,
      edge: 0.1,
      edgeThreshold: 0.05,
      recommendation: "buy_yes",
      createdAt: new Date().toISOString(),
      dryRun,
    }).run();
  }

  function seedOrder(id: string, ticker: string, dryRun: boolean) {
    const db = getDb();
    db.insert(orders).values({
      orderId: id,
      ticker,
      action: "buy",
      side: "yes",
      limitPrice: 40,
      quantity: 1,
      filledQuantity: 1,
      status: "filled",
      signalId: `sig-${id}`,
      dryRun,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
  }

  function seedBalance(id: string, balance: number, dryRun: boolean) {
    const db = getDb();
    db.insert(balanceHistory).values({
      id,
      balance,
      totalEquity: balance,
      openPositions: 0,
      realizedPnl: 0,
      recordedAt: new Date().toISOString(),
      dryRun,
    }).run();
  }

  function seedCalibration(
    id: string,
    ticker: string,
    realizedPnl: number,
    resolvedAt: string,
  ) {
    const db = getDb();
    db.insert(calibration).values({
      id,
      ticker,
      seriesTicker: "KXHIGH",
      category: "high_temp",
      stationId: "KNYC",
      predictedProb: 0.05,
      actualOutcome: 0,
      marketPrice: 30,
      edge: -0.25,
      realizedPnl,
      traded: true,
      forecastHorizon: 1,
      resolvedAt,
    }).run();
  }

  test("GET /api/signals?dryRun=true returns only paper signals", async () => {
    seedSignal("live-1", false);
    seedSignal("paper-1", true);
    seedSignal("paper-2", true);

    const { body } = await get("/api/signals?dryRun=true&limit=50");
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((s: any) => s.id).sort()).toEqual(["paper-1", "paper-2"]);
  });

  test("GET /api/signals?dryRun=false returns only live signals", async () => {
    seedSignal("live-1", false);
    seedSignal("paper-1", true);

    const { body } = await get("/api/signals?dryRun=false&limit=50");
    expect(body.map((s: any) => s.id)).toEqual(["live-1"]);
  });

  test("GET /api/signals (no filter) returns all", async () => {
    seedSignal("live-1", false);
    seedSignal("paper-1", true);

    const { body } = await get("/api/signals?limit=50");
    expect(body.length).toBe(2);
  });

  test("GET /api/orders?dryRun=true/false filters by mode", async () => {
    seedOrder("live-1", "T-live", false);
    seedOrder("paper-1", "T-paper", true);

    const paper = await get("/api/orders?dryRun=true&limit=50");
    expect(paper.body.map((o: any) => o.orderId)).toEqual(["paper-1"]);

    const live = await get("/api/orders?dryRun=false&limit=50");
    expect(live.body.map((o: any) => o.orderId)).toEqual(["live-1"]);
  });

  test("GET /api/balance/history?dryRun=true filters by mode", async () => {
    seedBalance("b-live", 5000, false);
    seedBalance("b-paper", 50000, true);

    const paper = await get("/api/balance/history?dryRun=true&limit=10");
    expect(paper.body).toHaveLength(1);
    expect(paper.body[0].balance).toBe(50000);

    const live = await get("/api/balance/history?dryRun=false&limit=10");
    expect(live.body).toHaveLength(1);
    expect(live.body[0].balance).toBe(5000);
  });

  test("GET /api/balance?dryRun=true returns paper latest", async () => {
    seedBalance("b-live", 5000, false);
    seedBalance("b-paper", 50000, true);

    const { body } = await get("/api/balance?dryRun=true");
    expect(body.cash).toBe(50000);
  });

  test("GET /api/performance/resolutions?dryRun filters via orders join", async () => {
    const now = new Date().toISOString();
    seedCalibration("cal-live", "T-live", 100, now);
    seedCalibration("cal-paper", "T-paper", -50, now);
    seedOrder("ord-live", "T-live", false);
    seedOrder("ord-paper", "T-paper", true);

    const paper = await get("/api/performance/resolutions?dryRun=true&limit=50");
    expect(paper.body.map((r: any) => r.ticker)).toEqual(["T-paper"]);

    const live = await get("/api/performance/resolutions?dryRun=false&limit=50");
    expect(live.body.map((r: any) => r.ticker)).toEqual(["T-live"]);
  });

  test("GET /api/performance/daily-pnl?dryRun filters via orders join", async () => {
    seedCalibration("cal-live", "T-live", 200, "2026-04-20T10:00:00Z");
    seedCalibration("cal-paper", "T-paper", -100, "2026-04-20T14:00:00Z");
    seedOrder("ord-live", "T-live", false);
    seedOrder("ord-paper", "T-paper", true);

    const paper = await get("/api/performance/daily-pnl?dryRun=true&days=30");
    expect(paper.body).toHaveLength(1);
    expect(paper.body[0].pnl).toBe(-100);

    const live = await get("/api/performance/daily-pnl?dryRun=false&days=30");
    expect(live.body).toHaveLength(1);
    expect(live.body[0].pnl).toBe(200);
  });
});
