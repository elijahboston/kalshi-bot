import { test, expect, beforeAll } from "bun:test";
import { handleApiRequest } from "./api";
import { runMigrations } from "@kcb/db";

beforeAll(() => {
  runMigrations();
});

test("GET /api/stations returns station list", () => {
  const req = new Request("http://localhost/api/stations");
  const res = handleApiRequest(req);
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
});

test("GET /api/stations includes all 11 stations with coords", async () => {
  const req = new Request("http://localhost/api/stations");
  const res = handleApiRequest(req);
  const data = await res!.json();
  expect(data).toHaveLength(11);
  expect(data[0]).toHaveProperty("id");
  expect(data[0]).toHaveProperty("lat");
  expect(data[0]).toHaveProperty("lon");
  expect(data[0]).toHaveProperty("activeMarkets");
});

test("GET /api/positions returns array", async () => {
  const req = new Request("http://localhost/api/positions");
  const res = handleApiRequest(req);
  expect(res).not.toBeNull();
  const data = await res!.json();
  expect(Array.isArray(data)).toBe(true);
});

test("GET /api/balance returns null or balance object", async () => {
  const req = new Request("http://localhost/api/balance");
  const res = handleApiRequest(req);
  expect(res).not.toBeNull();
  const data = await res!.json();
  if (data !== null) {
    expect(data).toHaveProperty("cash");
    expect(data).toHaveProperty("portfolio");
  }
});

test("GET /api/orders/recent returns array", async () => {
  const req = new Request("http://localhost/api/orders/recent");
  const res = handleApiRequest(req);
  expect(res).not.toBeNull();
  const data = await res!.json();
  expect(Array.isArray(data)).toBe(true);
});

test("GET /api/performance returns performance data", async () => {
  const req = new Request("http://localhost/api/performance");
  const res = handleApiRequest(req);
  expect(res).not.toBeNull();
  const data = await res!.json();
  expect(data).toHaveProperty("cash");
  expect(data).toHaveProperty("portfolio");
  expect(data).toHaveProperty("winRate");
  expect(data).toHaveProperty("equityHistory");
  expect(data).toHaveProperty("dailyPnl");
  expect(data).toHaveProperty("resolutions");
});

test("unknown API path returns null", () => {
  const req = new Request("http://localhost/api/unknown");
  const res = handleApiRequest(req);
  expect(res).toBeNull();
});
