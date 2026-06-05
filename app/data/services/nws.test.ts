import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────
// DO NOT mock @kcb/db or @kcb/engine — they leak globally via mock.module and
// break other test files' drizzle-orm / event-bus imports. nws.ts only needs
// the real logger from @kcb/engine; we intercept global fetch instead.

import { NwsService, localDayStartUtc, type TodayObservations } from "./nws";

const originalFetch = globalThis.fetch;

/** Fahrenheit → Celsius (NWS observations report Celsius; we feed C, expect F back). */
function fToC(f: number): number {
  return (f - 32) * 5 / 9;
}

/**
 * Build a fake `/observations` GeoJSON response from a list of (tempF, isoTs)
 * observations. `tempF` of null produces a null-temperature feature.
 */
function obsResponse(
  obs: Array<{ tempF: number | null; ts: string }>,
): Response {
  const features = obs.map(({ tempF, ts }) => ({
    properties: {
      timestamp: ts,
      temperature: {
        value: tempF == null ? null : fToC(tempF),
        unitCode: "wmoUnit:degC",
      },
    },
  }));
  return new Response(JSON.stringify({ features }), { status: 200 });
}

/** Install a fetch mock that records the requested URL and returns `resp`. */
function mockFetch(resp: Response): { getUrl: () => string } {
  let captured = "";
  globalThis.fetch = mock((url: string) => {
    captured = url;
    return Promise.resolve(resp.clone());
  }) as any;
  return { getUrl: () => captured };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── localDayStartUtc (pure helper) ─────────────────────────
describe("localDayStartUtc", () => {
  test("EDT: New York summer local midnight = 04:00Z", () => {
    // 2026-06-15 14:00Z → local day is 2026-06-15 in EDT (UTC-4).
    const now = new Date("2026-06-15T14:00:00Z");
    const start = localDayStartUtc(now, "America/New_York");
    expect(start.toISOString()).toBe("2026-06-15T04:00:00.000Z");
  });

  test("EST: New York winter local midnight = 05:00Z", () => {
    // 2026-01-15 14:00Z → local day is 2026-01-15 in EST (UTC-5).
    const now = new Date("2026-01-15T14:00:00Z");
    const start = localDayStartUtc(now, "America/New_York");
    expect(start.toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  test("PDT: Los Angeles summer local midnight = 07:00Z", () => {
    const now = new Date("2026-06-15T18:00:00Z");
    const start = localDayStartUtc(now, "America/Los_Angeles");
    expect(start.toISOString()).toBe("2026-06-15T07:00:00.000Z");
  });

  test("MDT: Denver summer local midnight = 06:00Z", () => {
    const now = new Date("2026-06-15T18:00:00Z");
    const start = localDayStartUtc(now, "America/Denver");
    expect(start.toISOString()).toBe("2026-06-15T06:00:00.000Z");
  });

  test("rolls the local day back when `now` is in the prior UTC day's local evening", () => {
    // 02:00Z on 2026-06-16 is still 2026-06-15 22:00 in EDT → start should be
    // the 2026-06-15 local midnight (04:00Z), NOT the 2026-06-16 one.
    const now = new Date("2026-06-16T02:00:00Z");
    const start = localDayStartUtc(now, "America/New_York");
    expect(start.toISOString()).toBe("2026-06-15T04:00:00.000Z");
  });
});

// ── getTodayObservations ───────────────────────────────────
describe("NwsService.getTodayObservations", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("runningMax over multiple obs; latest = newest; count correct (C→F conversion)", async () => {
    const svc = new NwsService();
    const now = new Date("2026-06-15T18:00:00Z");
    mockFetch(
      obsResponse([
        { tempF: 71, ts: "2026-06-15T13:00:00Z" },
        { tempF: 74, ts: "2026-06-15T17:00:00Z" }, // peak
        { tempF: 73, ts: "2026-06-15T17:51:00Z" }, // newest
      ]),
    );

    const res = (await svc.getTodayObservations("KNYC", now)) as TodayObservations;
    expect(res).not.toBeNull();
    expect(res.runningMax).toBeCloseTo(74, 6);
    expect(res.count).toBe(3);
    // Latest = newest timestamp, NOT the max temp.
    expect(res.latest.timestamp).toBe("2026-06-15T17:51:00Z");
    expect(res.latest.tempF).toBeCloseTo(73, 6);
  });

  test("picks newest by timestamp even when the feed is oldest-first", async () => {
    const svc = new NwsService();
    const now = new Date("2026-06-15T18:00:00Z");
    mockFetch(
      obsResponse([
        { tempF: 60, ts: "2026-06-15T08:00:00Z" },
        { tempF: 80, ts: "2026-06-15T16:00:00Z" },
        { tempF: 70, ts: "2026-06-15T17:30:00Z" }, // newest, not max
      ]),
    );

    const res = (await svc.getTodayObservations("KNYC", now)) as TodayObservations;
    expect(res.runningMax).toBeCloseTo(80, 6);
    expect(res.latest.timestamp).toBe("2026-06-15T17:30:00Z");
    expect(res.latest.tempF).toBeCloseTo(70, 6);
  });

  test("windowing — EDT: `start` query param = local midnight 04:00Z; `end` = now", async () => {
    const svc = new NwsService();
    const now = new Date("2026-06-15T18:00:00Z");
    const fx = mockFetch(obsResponse([{ tempF: 70, ts: "2026-06-15T17:00:00Z" }]));

    await svc.getTodayObservations("KNYC", now);

    const url = new URL(fx.getUrl());
    expect(url.pathname).toBe("/stations/KNYC/observations");
    expect(url.searchParams.get("start")).toBe("2026-06-15T04:00:00.000Z");
    expect(url.searchParams.get("end")).toBe("2026-06-15T18:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  test("windowing — PDT: `start` query param = local midnight 07:00Z", async () => {
    const svc = new NwsService();
    const now = new Date("2026-06-15T18:00:00Z");
    const fx = mockFetch(obsResponse([{ tempF: 70, ts: "2026-06-15T17:00:00Z" }]));

    await svc.getTodayObservations("KLAX", now);

    const url = new URL(fx.getUrl());
    expect(url.searchParams.get("start")).toBe("2026-06-15T07:00:00.000Z");
  });

  test("staleness — latestAgeMinutes computed vs injected `now`", async () => {
    const svc = new NwsService();
    const now = new Date("2026-06-15T18:00:00Z");
    mockFetch(
      obsResponse([
        { tempF: 72, ts: "2026-06-15T16:45:00Z" }, // 75 min before now
        { tempF: 74, ts: "2026-06-15T17:15:00Z" }, // 45 min before now (newest)
      ]),
    );

    const res = (await svc.getTodayObservations("KNYC", now)) as TodayObservations;
    // 18:00 − 17:15 = 45 minutes.
    expect(res.latestAgeMinutes).toBeCloseTo(45, 6);
  });

  test("staleness — large age for an old single observation", async () => {
    const svc = new NwsService();
    const now = new Date("2026-06-15T18:00:00Z");
    mockFetch(obsResponse([{ tempF: 68, ts: "2026-06-15T14:00:00Z" }]));

    const res = (await svc.getTodayObservations("KNYC", now)) as TodayObservations;
    expect(res.latestAgeMinutes).toBeCloseTo(240, 6); // 4 hours
  });

  test("null — empty features list", async () => {
    const svc = new NwsService();
    mockFetch(new Response(JSON.stringify({ features: [] }), { status: 200 }));
    const res = await svc.getTodayObservations("KNYC", new Date("2026-06-15T18:00:00Z"));
    expect(res).toBeNull();
  });

  test("null — all temperatures null", async () => {
    const svc = new NwsService();
    mockFetch(
      obsResponse([
        { tempF: null, ts: "2026-06-15T16:00:00Z" },
        { tempF: null, ts: "2026-06-15T17:00:00Z" },
      ]),
    );
    const res = await svc.getTodayObservations("KNYC", new Date("2026-06-15T18:00:00Z"));
    expect(res).toBeNull();
  });

  test("skips null-temp obs but aggregates the usable ones", async () => {
    const svc = new NwsService();
    const now = new Date("2026-06-15T18:00:00Z");
    mockFetch(
      obsResponse([
        { tempF: 70, ts: "2026-06-15T15:00:00Z" },
        { tempF: null, ts: "2026-06-15T16:00:00Z" }, // dropped
        { tempF: 76, ts: "2026-06-15T17:00:00Z" },
      ]),
    );

    const res = (await svc.getTodayObservations("KNYC", now)) as TodayObservations;
    expect(res.count).toBe(2);
    expect(res.runningMax).toBeCloseTo(76, 6);
    expect(res.latest.timestamp).toBe("2026-06-15T17:00:00Z");
  });

  test("returns null (not throw) on non-OK HTTP response", async () => {
    const svc = new NwsService();
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("rate limited", { status: 429 })),
    ) as any;
    const res = await svc.getTodayObservations("KNYC", new Date("2026-06-15T18:00:00Z"));
    expect(res).toBeNull();
  });

  test("returns null (not throw) when fetch rejects", async () => {
    const svc = new NwsService();
    globalThis.fetch = mock(() => Promise.reject(new Error("network down"))) as any;
    const res = await svc.getTodayObservations("KNYC", new Date("2026-06-15T18:00:00Z"));
    expect(res).toBeNull();
  });

  test("unknown station falls back to default (Eastern) tz windowing", async () => {
    const svc = new NwsService();
    const now = new Date("2026-06-15T18:00:00Z");
    const fx = mockFetch(obsResponse([{ tempF: 70, ts: "2026-06-15T17:00:00Z" }]));

    await svc.getTodayObservations("KZZZ", now);

    const url = new URL(fx.getUrl());
    // Default America/New_York → EDT 04:00Z.
    expect(url.searchParams.get("start")).toBe("2026-06-15T04:00:00.000Z");
  });
});
