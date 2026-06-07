import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────
// DO NOT mock @kcb/db or @kcb/engine — they leak globally via mock.module and
// break other test files' drizzle-orm / event-bus imports. nws.ts only needs
// the real logger from @kcb/engine; we intercept global fetch instead.

import {
  NwsService,
  localDayStartUtc,
  parseCliProduct,
  type TodayObservations,
  type CliReport,
} from "./nws";

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

// ── CLI climate-product parser + fetch (N1 item 2) ─────────
// win-rate-80-addendum-2026-06-05.md N1 item 2 / Finding 11: the NWS CLI
// product is the LITERAL source Kalshi settles on — exact max/min, no ±1°F
// interval-midpoint noise. Fixtures below mirror the real fixed-width format.

/** A normal KNYC CLI for 2026-06-15: MAXIMUM 87 @ 3:24 PM, MINIMUM 66 @ 5:51 AM. */
const CLI_NYC_NORMAL = `
000
CDUS41 KOKX 152130
CLINYC

CLIMATE REPORT
NATIONAL WEATHER SERVICE NEW YORK, NY
524 PM EDT MON JUN 15 2026

...................................

...THE CENTRAL PARK NY CLIMATE SUMMARY FOR JUNE 15 2026...

WEATHER ITEM   OBSERVED TIME   RECORD YEAR NORMAL DEPARTURE LAST
                VALUE   (LST)  VALUE       VALUE  FROM      YEAR
                                                  NORMAL
...................................................................
TEMPERATURE (F)
 TODAY
  MAXIMUM         87    324 PM  99    1973  80      7       85
  MINIMUM         66    551 AM  50    1933  64      2       63
  AVERAGE         77                        72      5       74
`;

/** A KMIA CLI for 2026-06-15 with MM (missing) max temperature. */
const CLI_MIA_MISSING = `
000
CDUS42 KMFL 152200
CLIMIA

CLIMATE REPORT
NATIONAL WEATHER SERVICE MIAMI FL
600 PM EDT MON JUN 15 2026

...THE MIAMI FL CLIMATE SUMMARY FOR JUNE 15 2026...

TEMPERATURE (F)
 TODAY
  MAXIMUM         MM    MM      96    2020  90      M       89
  MINIMUM         78    430 AM  64    1945  77      1       79
`;

/** A KNYC CLI for the PREVIOUS day (2026-06-14) — same site, different date. */
const CLI_NYC_PRIORDAY = `
000
CDUS41 KOKX 142130
CLINYC

CLIMATE REPORT
NATIONAL WEATHER SERVICE NEW YORK, NY

...THE CENTRAL PARK NY CLIMATE SUMMARY FOR JUNE 14 2026...

TEMPERATURE (F)
 TODAY
  MAXIMUM         82    301 PM  99    1973  80      2       79
  MINIMUM         61    509 AM  50    1933  63     -2       60
`;

describe("parseCliProduct", () => {
  test("normal product → exact max 87 / min 66 + reportDate", () => {
    const r = parseCliProduct(CLI_NYC_NORMAL);
    expect(r.maxTempF).toBe(87);
    expect(r.minTempF).toBe(66);
    expect(r.reportDate).toBe("2026-06-15");
  });

  test("MM missing max → null max, real min; reportDate still parsed", () => {
    const r = parseCliProduct(CLI_MIA_MISSING);
    expect(r.maxTempF).toBeNull();
    expect(r.minTempF).toBe(78);
    expect(r.reportDate).toBe("2026-06-15");
  });

  test("reports the product's own date (caller decides if it matches target)", () => {
    const r = parseCliProduct(CLI_NYC_PRIORDAY);
    expect(r.reportDate).toBe("2026-06-14");
    expect(r.maxTempF).toBe(82);
    expect(r.minTempF).toBe(61);
  });

  test("no summary line → reportDate null (still tries temps)", () => {
    const r = parseCliProduct("TEMPERATURE (F)\n  MAXIMUM   77   2:00 PM\n  MINIMUM   55   6:00 AM\n");
    expect(r.reportDate).toBeNull();
    expect(r.maxTempF).toBe(77);
    expect(r.minTempF).toBe(55);
  });

  test("negative temperature is parsed (cold climate day)", () => {
    const txt = "...CLIMATE SUMMARY FOR JANUARY 5 2026...\nTEMPERATURE (F)\n  MAXIMUM   12   1:00 PM\n  MINIMUM   -4   6:00 AM\n";
    const r = parseCliProduct(txt);
    expect(r.maxTempF).toBe(12);
    expect(r.minTempF).toBe(-4);
  });
});

// ── getCliReport (fetch mocked) ────────────────────────────
// Mocks the two-stage fetch: the office product list, then per-id product
// texts. Each call inspects the requested URL to decide what to return.

/** A CLI list response (NWS `@graph` array, newest first). */
function cliListResponse(
  entries: Array<{ id: string; issuanceTime: string }>,
): Response {
  return new Response(JSON.stringify({ "@graph": entries }), { status: 200 });
}

/** A single CLI product response (`productText` field). */
function cliProductResponse(id: string, productText: string, issuanceTime: string): Response {
  return new Response(
    JSON.stringify({ "@id": id, productText, issuanceTime }),
    { status: 200 },
  );
}

/**
 * Install a fetch mock routing CLI list + product-text URLs. `texts` maps a
 * product id → its raw text. Records how many fetches happened.
 */
function mockCliFetch(
  entries: Array<{ id: string; issuanceTime: string }>,
  texts: Record<string, string>,
): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = mock((url: string) => {
    calls++;
    if (url.includes("/products/types/CLI/locations/")) {
      return Promise.resolve(cliListResponse(entries));
    }
    // /products/{id}
    const id = url.split("/products/").pop()!;
    const text = texts[id];
    if (text == null) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    const issuance = entries.find((e) => e.id === id)?.issuanceTime ?? "";
    return Promise.resolve(cliProductResponse(id, text, issuance));
  }) as any;
  return { calls: () => calls };
}

describe("NwsService.getCliReport", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns the matching site + date report (exact max/min)", async () => {
    const svc = new NwsService();
    mockCliFetch(
      [
        { id: "nyc-15", issuanceTime: "2026-06-15T21:30:00Z" },
        { id: "nyc-14", issuanceTime: "2026-06-14T21:30:00Z" },
      ],
      { "nyc-15": CLI_NYC_NORMAL, "nyc-14": CLI_NYC_PRIORDAY },
    );

    const r = (await svc.getCliReport("KNYC", "2026-06-15")) as CliReport;
    expect(r).not.toBeNull();
    expect(r.maxTempF).toBe(87);
    expect(r.minTempF).toBe(66);
    expect(r.reportDate).toBe("2026-06-15");
    expect(r.issuedAt).toBe("2026-06-15T21:30:00Z");
  });

  test("picks the right date when an earlier-day product is newest in the list", async () => {
    const svc = new NwsService();
    // List ordered newest-first contains both days; ask for the older day.
    mockCliFetch(
      [
        { id: "nyc-15", issuanceTime: "2026-06-15T21:30:00Z" },
        { id: "nyc-14", issuanceTime: "2026-06-14T21:30:00Z" },
      ],
      { "nyc-15": CLI_NYC_NORMAL, "nyc-14": CLI_NYC_PRIORDAY },
    );

    const r = (await svc.getCliReport("KNYC", "2026-06-14")) as CliReport;
    expect(r.reportDate).toBe("2026-06-14");
    expect(r.maxTempF).toBe(82);
  });

  test("REGRESSION: fetches the product list by CLI SITE code, not WFO office (follow-up #1)", async () => {
    // The products API indexes CLI by site code; /locations/OKX (the WFO)
    // returns an empty @graph with no error, so the original office-keyed
    // fetch silently produced zero `cli` actuals for every station. The mock
    // here matched any /locations/ URL, which is why tests never caught it —
    // assert the exact path.
    const svc = new NwsService();
    const urls: string[] = [];
    globalThis.fetch = mock((url: string) => {
      urls.push(url);
      if (url.includes("/products/types/CLI/locations/")) {
        return Promise.resolve(
          cliListResponse([{ id: "nyc-15", issuanceTime: "2026-06-15T21:30:00Z" }]),
        );
      }
      return Promise.resolve(
        cliProductResponse("nyc-15", CLI_NYC_NORMAL, "2026-06-15T21:30:00Z"),
      );
    }) as any;

    await svc.getCliReport("KNYC", "2026-06-15");
    const listUrl = urls.find((u) => u.includes("/products/types/CLI/locations/"));
    expect(listUrl).toEndWith("/products/types/CLI/locations/NYC");
  });

  test("filters by CLI site code — ignores another site's product for the same office", async () => {
    const svc = new NwsService();
    // OKX office list also contains a non-NYC site; only CLINYC should match.
    const cliBdrOtherSite = CLI_NYC_NORMAL.replace("CLINYC", "CLIBDR").replace(
      "87",
      "99",
    );
    mockCliFetch(
      [
        { id: "bdr-15", issuanceTime: "2026-06-15T21:35:00Z" }, // newer, wrong site
        { id: "nyc-15", issuanceTime: "2026-06-15T21:30:00Z" },
      ],
      { "bdr-15": cliBdrOtherSite, "nyc-15": CLI_NYC_NORMAL },
    );

    const r = (await svc.getCliReport("KNYC", "2026-06-15")) as CliReport;
    expect(r.maxTempF).toBe(87); // KNYC's value, not the 99 from CLIBDR
  });

  test("MM missing max surfaces as maxTempF null", async () => {
    const svc = new NwsService();
    mockCliFetch(
      [{ id: "mia-15", issuanceTime: "2026-06-15T22:00:00Z" }],
      { "mia-15": CLI_MIA_MISSING },
    );

    const r = (await svc.getCliReport("KMIA", "2026-06-15")) as CliReport;
    expect(r.maxTempF).toBeNull();
    expect(r.minTempF).toBe(78);
  });

  test("returns null when no product covers the target date", async () => {
    const svc = new NwsService();
    mockCliFetch(
      [{ id: "nyc-14", issuanceTime: "2026-06-14T21:30:00Z" }],
      { "nyc-14": CLI_NYC_PRIORDAY },
    );

    const r = await svc.getCliReport("KNYC", "2026-06-15");
    expect(r).toBeNull();
  });

  test("returns null (not throw) when the product-list API fails", async () => {
    const svc = new NwsService();
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("rate limited", { status: 429 })),
    ) as any;

    const r = await svc.getCliReport("KNYC", "2026-06-15");
    expect(r).toBeNull();
  });

  test("returns null (not throw) when fetch rejects", async () => {
    const svc = new NwsService();
    globalThis.fetch = mock(() => Promise.reject(new Error("network down"))) as any;
    const r = await svc.getCliReport("KNYC", "2026-06-15");
    expect(r).toBeNull();
  });

  test("unknown station → null without any fetch", async () => {
    const svc = new NwsService();
    globalThis.fetch = mock(() => Promise.reject(new Error("should not fetch"))) as any;
    const r = await svc.getCliReport("KZZZ", "2026-06-15");
    expect(r).toBeNull();
  });

  test("memoizes by (station, date) — second call does not refetch", async () => {
    const svc = new NwsService();
    const fx = mockCliFetch(
      [{ id: "nyc-15", issuanceTime: "2026-06-15T21:30:00Z" }],
      { "nyc-15": CLI_NYC_NORMAL },
    );

    const a = (await svc.getCliReport("KNYC", "2026-06-15")) as CliReport;
    const callsAfterFirst = fx.calls();
    const b = (await svc.getCliReport("KNYC", "2026-06-15")) as CliReport;
    expect(b.maxTempF).toBe(a.maxTempF);
    // No additional fetches on the cached second call.
    expect(fx.calls()).toBe(callsAfterFirst);
  });
});
