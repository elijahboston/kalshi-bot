import { test, expect, beforeAll, describe } from "bun:test";
import Elysia from "elysia";
import { runMigrations } from "@kcb/db";
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
