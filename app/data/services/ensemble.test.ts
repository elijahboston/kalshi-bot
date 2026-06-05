import { test, expect, describe, mock, beforeEach } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────
// DO NOT mock @kcb/db or @kcb/engine — they leak globally via mock.module
// and break other test files' drizzle-orm and event bus imports.
// Use real in-memory DB and real logger instead.

import { runMigrations, getDb, weatherForecasts } from "@kcb/db";
import { eq, and } from "drizzle-orm";

// Initialize in-memory DB
runMigrations();

// Intercept fetch calls
const originalFetch = globalThis.fetch;

import { EnsembleService, resetSniperRefreshTracking } from "./ensemble";
import { bus } from "@kcb/engine";

/** Today's date in UTC (YYYY-MM-DD) — matches EnsembleService's isToday compare. */
const TODAY_UTC = new Date().toISOString().slice(0, 10);

/** Build an ISO timestamp `hoursAgo` hours before now (for fetchedAt staleness). */
function hoursAgoIso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  // Clear weather_forecasts table between tests
  const db = getDb();
  db.delete(weatherForecasts).run();
  // N6: module-level sniper-refresh tracking persists across calls — reset it
  // so each test starts with a clean "never refreshed" state.
  resetSniperRefreshTracking();
});

// ── Tests ──────────────────────────────────────────────────

describe("EnsembleService", () => {
  describe("fetchOpenMeteo response parsing", () => {
    test("parses multi-model suffixed member keys", async () => {
      const targetDate = "2026-02-23";
      const service = new EnsembleService();

      const daily: Record<string, any> = {
        time: [targetDate],
        temperature_2m_max_member01_ncep_gefs_seamless: [20],
        temperature_2m_max_member02_ncep_gefs_seamless: [21],
        temperature_2m_max_member01_icon_seamless_eps: [22],
        temperature_2m_max_member02_icon_seamless_eps: [23],
        temperature_2m_max_member01_ecmwf_ifs025: [24],
        temperature_2m_max_member02_ecmwf_ifs025: [25],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }))
      ) as any;

      const values = await (service as any).fetchOpenMeteo("KNYC", targetDate, "high_temp");

      expect(values).toHaveLength(6);
      for (const v of values) {
        expect(v).toBeGreaterThan(60);
        expect(v).toBeLessThan(85);
      }

      globalThis.fetch = originalFetch;
    });

    test("parses single-model plain member keys (backwards compat)", async () => {
      const targetDate = "2026-02-23";
      const service = new EnsembleService();

      const daily: Record<string, any> = {
        time: [targetDate],
        temperature_2m_max_member01: [20],
        temperature_2m_max_member02: [21],
        temperature_2m_max_member03: [22],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }))
      ) as any;

      const values = await (service as any).fetchOpenMeteo("KNYC", targetDate, "high_temp");
      expect(values).toHaveLength(3);

      globalThis.fetch = originalFetch;
    });

    test("ignores non-member keys like time and main variable", async () => {
      const targetDate = "2026-02-23";
      const service = new EnsembleService();

      const daily: Record<string, any> = {
        time: [targetDate],
        temperature_2m_max: [20],
        temperature_2m_max_member01_ncep_gefs_seamless: [20],
        temperature_2m_max_member02_ncep_gefs_seamless: [21],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }))
      ) as any;

      const values = await (service as any).fetchOpenMeteo("KNYC", targetDate, "high_temp");
      expect(values).toHaveLength(2);

      globalThis.fetch = originalFetch;
    });

    test("throws when no ensemble members found", async () => {
      const targetDate = "2026-02-23";
      const service = new EnsembleService();

      const daily: Record<string, any> = {
        time: [targetDate],
        temperature_2m_max: [20],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }))
      ) as any;

      await expect(
        (service as any).fetchOpenMeteo("KNYC", targetDate, "high_temp")
      ).rejects.toThrow("No ensemble members found");

      globalThis.fetch = originalFetch;
    });

    test("throws when target date not in response", async () => {
      const service = new EnsembleService();

      const daily: Record<string, any> = {
        time: ["2026-02-24"],
        temperature_2m_max_member01: [20],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }))
      ) as any;

      await expect(
        (service as any).fetchOpenMeteo("KNYC", "2026-02-23", "high_temp")
      ).rejects.toThrow("not in forecast range");

      globalThis.fetch = originalFetch;
    });
  });

  describe("unit conversion", () => {
    test("converts Celsius to Fahrenheit for high_temp", async () => {
      const targetDate = "2026-02-23";
      const service = new EnsembleService();

      const daily: Record<string, any> = {
        time: [targetDate],
        temperature_2m_max_member01: [0],
        temperature_2m_max_member02: [100],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }))
      ) as any;

      const values = await (service as any).fetchOpenMeteo("KNYC", targetDate, "high_temp");

      expect(values).toContain(32);
      expect(values).toContain(212);

      globalThis.fetch = originalFetch;
    });

    test("converts mm to inches for precip", async () => {
      const targetDate = "2026-02-23";
      const service = new EnsembleService();

      const daily: Record<string, any> = {
        time: [targetDate],
        precipitation_sum_member01: [25.4],
        precipitation_sum_member02: [0],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }))
      ) as any;

      const values = await (service as any).fetchOpenMeteo("KNYC", targetDate, "precip");

      expect(values[0]).toBeCloseTo(1.0, 5);
      expect(values[1]).toBe(0);

      globalThis.fetch = originalFetch;
    });

    test("converts cm to inches for snowfall", async () => {
      const targetDate = "2026-02-23";
      const service = new EnsembleService();

      const daily: Record<string, any> = {
        time: [targetDate],
        snowfall_sum_member01: [2.54],
        snowfall_sum_member02: [0],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }))
      ) as any;

      const values = await (service as any).fetchOpenMeteo("KNYC", targetDate, "snowfall");

      expect(values[0]).toBeCloseTo(1.0, 5);
      expect(values[1]).toBe(0);

      globalThis.fetch = originalFetch;
    });
  });

  describe("cache", () => {
    test("returns cached values when fresh", async () => {
      const service = new EnsembleService();
      const cachedValues = [68, 69, 70, 71, 72];

      // Insert a cached forecast row
      const db = getDb();
      db.insert(weatherForecasts).values({
        id: crypto.randomUUID(),
        stationId: "KNYC",
        targetDate: "2026-02-23",
        source: "multi_ensemble",
        forecastType: "high_temp",
        forecastHorizon: 1,
        ensembleValues: JSON.stringify(cachedValues),
        ensembleSize: cachedValues.length,
        ensembleMean: 70,
        ensembleStd: 1.5,
        fetchedAt: new Date().toISOString(),
      }).run();

      const result = await service.getEnsembleValues("KNYC", "2026-02-23", "high_temp");
      expect(result).toEqual(cachedValues);
    });

    test("cacheValues inserts with source multi_ensemble", async () => {
      const service = new EnsembleService();
      const values = [68, 69, 70];

      await (service as any).cacheValues("KNYC", "2026-02-25", "high_temp", values);

      const db = getDb();
      const rows = db.select().from(weatherForecasts)
        .where(and(
          eq(weatherForecasts.stationId, "KNYC"),
          eq(weatherForecasts.targetDate, "2026-02-25"),
        )).all();

      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe("multi_ensemble");
      expect(rows[0].ensembleSize).toBe(3);
      expect(JSON.parse(rows[0].ensembleValues!)).toEqual(values);
    });
  });

  describe("syntheticFallback", () => {
    test("returns 31 synthetic values", async () => {
      const service = new EnsembleService();

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("", { status: 500 }))
      ) as any;

      const values = await (service as any).syntheticFallback("KNYC", "2026-02-23", "high_temp");

      expect(values).toHaveLength(31);
      const mean = values.reduce((a: number, b: number) => a + b, 0) / values.length;
      expect(mean).toBeGreaterThan(40);
      expect(mean).toBeLessThan(60);

      globalThis.fetch = originalFetch;
    });
  });

  describe("fetchTomorrowIo", () => {
    test("fetches point forecast and returns value in imperial", async () => {
      const service = new EnsembleService();

      // Set API key via env
      process.env.TOMORROW_IO_API_KEY = "test-key";

      globalThis.fetch = mock((url: string) => {
        if (url.includes("tomorrow.io")) {
          return Promise.resolve(new Response(JSON.stringify({
            timelines: {
              daily: [
                {
                  time: "2026-02-23T00:00:00Z",
                  values: { temperatureMax: 72.5 },
                },
              ],
            },
          }), { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 500 }));
      }) as any;

      const values = await service.fetchTomorrowIo("KNYC", "2026-02-23", "high_temp");

      expect(values).toHaveLength(1);
      expect(values[0]).toBe(72.5); // Already imperial from Tomorrow.io

      // Verify it was cached separately
      const db = getDb();
      const rows = db.select().from(weatherForecasts)
        .where(and(
          eq(weatherForecasts.stationId, "KNYC"),
          eq(weatherForecasts.source, "tomorrow_io"),
        )).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].pointForecast).toBe(72.5);

      globalThis.fetch = originalFetch;
      delete process.env.TOMORROW_IO_API_KEY;
    });

    test("returns empty array for unknown station", async () => {
      const service = new EnsembleService();
      process.env.TOMORROW_IO_API_KEY = "test-key";

      // Unknown station — should return empty without making API call
      const values = await service.fetchTomorrowIo("KXYZ", "2026-02-23", "high_temp");
      expect(values).toHaveLength(0);

      delete process.env.TOMORROW_IO_API_KEY;
    });

    test("returns empty array when target date not in response", async () => {
      const service = new EnsembleService();
      process.env.TOMORROW_IO_API_KEY = "test-key";

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({
          timelines: {
            daily: [
              {
                time: "2026-02-24T00:00:00Z",
                values: { temperatureMax: 72 },
              },
            ],
          },
        }), { status: 200 }))
      ) as any;

      const values = await service.fetchTomorrowIo("KNYC", "2026-02-23", "high_temp");
      expect(values).toHaveLength(0);

      globalThis.fetch = originalFetch;
      delete process.env.TOMORROW_IO_API_KEY;
    });

    test("fetches precip in imperial (inches)", async () => {
      const service = new EnsembleService();
      process.env.TOMORROW_IO_API_KEY = "test-key";

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({
          timelines: {
            daily: [
              {
                time: "2026-02-23T00:00:00Z",
                values: { rainAccumulation: 0.35 },
              },
            ],
          },
        }), { status: 200 }))
      ) as any;

      const values = await service.fetchTomorrowIo("KNYC", "2026-02-23", "precip");
      expect(values).toHaveLength(1);
      expect(values[0]).toBe(0.35);

      globalThis.fetch = originalFetch;
      delete process.env.TOMORROW_IO_API_KEY;
    });
  });

  describe("getEnsembleValues with Tomorrow.io augmentation", () => {
    test("merges Open-Meteo and Tomorrow.io values", async () => {
      const service = new EnsembleService();
      process.env.TOMORROW_IO_API_KEY = "test-key";

      let callCount = 0;
      globalThis.fetch = mock((url: string) => {
        callCount++;
        if (url.includes("open-meteo.com")) {
          const daily: Record<string, any> = {
            time: ["2026-02-23"],
            temperature_2m_max_member01: [20],
            temperature_2m_max_member02: [21],
          };
          return Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }));
        }
        if (url.includes("tomorrow.io")) {
          return Promise.resolve(new Response(JSON.stringify({
            timelines: {
              daily: [{ time: "2026-02-23T00:00:00Z", values: { temperatureMax: 70 } }],
            },
          }), { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 500 }));
      }) as any;

      const values = await service.getEnsembleValues("KNYC", "2026-02-23", "high_temp");

      // 2 from Open-Meteo (converted C→F) + 1 from Tomorrow.io (already F)
      expect(values).toHaveLength(3);
      // Last value should be the Tomorrow.io point (70°F)
      expect(values[2]).toBe(70);

      globalThis.fetch = originalFetch;
      delete process.env.TOMORROW_IO_API_KEY;
    });

    test("uses Tomorrow.io alone when Open-Meteo fails", async () => {
      const service = new EnsembleService();
      process.env.TOMORROW_IO_API_KEY = "test-key";

      globalThis.fetch = mock((url: string) => {
        if (url.includes("open-meteo.com")) {
          return Promise.resolve(new Response("error", { status: 500 }));
        }
        if (url.includes("tomorrow.io")) {
          return Promise.resolve(new Response(JSON.stringify({
            timelines: {
              daily: [{ time: "2026-02-23T00:00:00Z", values: { temperatureMax: 65 } }],
            },
          }), { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 500 }));
      }) as any;

      const values = await service.getEnsembleValues("KNYC", "2026-02-23", "high_temp");

      // Only Tomorrow.io value (no synthetic fallback needed)
      expect(values).toHaveLength(1);
      expect(values[0]).toBe(65);

      globalThis.fetch = originalFetch;
      delete process.env.TOMORROW_IO_API_KEY;
    });
  });

  describe("fetchHrrr", () => {
    test("fetches HRRR hourly data and extracts daily max for high_temp", async () => {
      const service = new EnsembleService();

      globalThis.fetch = mock((url: string) => {
        if (url.includes("gfs_hrrr")) {
          return Promise.resolve(new Response(JSON.stringify({
            hourly: {
              time: [
                "2026-02-23T06:00", "2026-02-23T12:00", "2026-02-23T18:00",
                "2026-02-24T06:00",
              ],
              temperature_2m: [10, 20, 25, 15], // Celsius
            },
          }), { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 500 }));
      }) as any;

      const values = await service.fetchHrrr("KNYC", "2026-02-23", "high_temp");

      expect(values).toHaveLength(1);
      // Max of [10, 20, 25] (Feb 23 only) = 25°C = 77°F
      expect(values[0]).toBe(77);

      globalThis.fetch = originalFetch;
    });

    test("fetches HRRR min for low_temp", async () => {
      const service = new EnsembleService();

      globalThis.fetch = mock((url: string) => {
        if (url.includes("gfs_hrrr")) {
          return Promise.resolve(new Response(JSON.stringify({
            hourly: {
              time: [
                "2026-02-23T06:00", "2026-02-23T12:00", "2026-02-23T18:00",
              ],
              temperature_2m: [5, 10, 15],
            },
          }), { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 500 }));
      }) as any;

      const values = await service.fetchHrrr("KNYC", "2026-02-23", "low_temp");

      expect(values).toHaveLength(1);
      // Min of [5, 10, 15] = 5°C = 41°F
      expect(values[0]).toBe(41);

      globalThis.fetch = originalFetch;
    });

    test("sums hourly precip for daily total", async () => {
      const service = new EnsembleService();

      globalThis.fetch = mock((url: string) => {
        if (url.includes("gfs_hrrr")) {
          return Promise.resolve(new Response(JSON.stringify({
            hourly: {
              time: ["2026-02-23T06:00", "2026-02-23T12:00", "2026-02-23T18:00"],
              precipitation: [5.08, 7.62, 12.7], // mm
            },
          }), { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 500 }));
      }) as any;

      const values = await service.fetchHrrr("KNYC", "2026-02-23", "precip");

      expect(values).toHaveLength(1);
      // Sum = 25.4mm = 1.0 inch
      expect(values[0]).toBeCloseTo(1.0, 5);

      globalThis.fetch = originalFetch;
    });

    test("returns empty for unknown station", async () => {
      const service = new EnsembleService();
      const values = await service.fetchHrrr("KXYZ", "2026-02-23", "high_temp");
      expect(values).toHaveLength(0);
    });

    test("returns empty when target date not in hourly data", async () => {
      const service = new EnsembleService();

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({
          hourly: {
            time: ["2026-02-24T06:00"],
            temperature_2m: [20],
          },
        }), { status: 200 }))
      ) as any;

      const values = await service.fetchHrrr("KNYC", "2026-02-23", "high_temp");
      expect(values).toHaveLength(0);

      globalThis.fetch = originalFetch;
    });
  });

  describe("blendMembers", () => {
    test("heavily weights HRRR at short horizons", () => {
      const service = new EnsembleService();
      const tagged = [
        { value: 70, model: "gfs" },
        { value: 71, model: "gfs" },
        { value: 72, model: "ecmwf" },
        { value: 73, model: "ecmwf" },
      ];
      const hrrr = [75];

      const blended = service.blendMembers(tagged, hrrr, 3); // 3h horizon → "0-6" bucket

      // HRRR should dominate: 70% weight vs 30% for others
      const hrrrCount = blended.filter(v => v === 75).length;
      const totalCount = blended.length;
      expect(hrrrCount / totalCount).toBeGreaterThan(0.4); // HRRR is majority
    });

    test("zero HRRR weight at long horizons", () => {
      const service = new EnsembleService();
      const tagged = [
        { value: 70, model: "gfs" },
        { value: 72, model: "ecmwf" },
      ];
      const hrrr = [75];

      const blended = service.blendMembers(tagged, hrrr, 100); // 100h → "72+" bucket

      // HRRR weight is 0 at long horizons
      const hrrrCount = blended.filter(v => v === 75).length;
      expect(hrrrCount).toBe(0);
    });

    test("returns raw values when no weight info", () => {
      const service = new EnsembleService();
      const tagged = [{ value: 70, model: "gfs" }];
      const hrrr = [75];

      const blended = service.blendMembers(tagged, hrrr, 10); // 10h → "6-18"
      expect(blended.length).toBeGreaterThan(1);
      expect(blended).toContain(70);
      expect(blended).toContain(75);
    });
  });

  describe("applyBlending", () => {
    test("adds HRRR duplicates to ensemble based on horizon", () => {
      const service = new EnsembleService();
      const ensemble = Array.from({ length: 30 }, () => 70);
      const hrrr = [75];

      const blended = service.applyBlending(ensemble, "ensemble", hrrr, 3); // 0-6h: 70% HRRR

      // Should have more members than original
      expect(blended.length).toBeGreaterThan(30);
      // HRRR values should be present
      expect(blended.filter(v => v === 75).length).toBeGreaterThan(0);
    });

    test("does not add HRRR at long horizons", () => {
      const service = new EnsembleService();
      const ensemble = [70, 71, 72];
      const hrrr = [75];

      const blended = service.applyBlending(ensemble, "ensemble", hrrr, 100); // 72+: 0% HRRR

      expect(blended).toEqual([70, 71, 72]);
    });

    test("returns ensemble unchanged when no HRRR values", () => {
      const service = new EnsembleService();
      const ensemble = [70, 71, 72];

      const blended = service.applyBlending(ensemble, "ensemble", [], 3);

      expect(blended).toEqual(ensemble);
    });
  });

  describe("getEnsembleValues with HRRR integration", () => {
    test("fetches HRRR when horizon < 48h", async () => {
      const service = new EnsembleService();
      let hrrrCalled = false;

      globalThis.fetch = mock((url: string) => {
        if (url.includes("ensemble-api")) {
          const daily: Record<string, any> = {
            time: ["2026-02-23"],
            temperature_2m_max_member01_ncep_gefs_seamless: [20],
            temperature_2m_max_member02_ecmwf_ifs025: [21],
          };
          return Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }));
        }
        if (url.includes("gfs_hrrr")) {
          hrrrCalled = true;
          return Promise.resolve(new Response(JSON.stringify({
            hourly: {
              time: ["2026-02-23T12:00"],
              temperature_2m: [22],
            },
          }), { status: 200 }));
        }
        if (url.includes("tomorrow.io")) {
          return Promise.resolve(new Response("", { status: 404 }));
        }
        return Promise.resolve(new Response("", { status: 500 }));
      }) as any;

      const values = await service.getEnsembleValues("KNYC", "2026-02-23", "high_temp", 10);

      expect(hrrrCalled).toBe(true);
      // Should have both ensemble and HRRR values (blended)
      expect(values.length).toBeGreaterThan(2);

      globalThis.fetch = originalFetch;
    });
  });

  describe("URL construction", () => {
    test("requests all three models in URL", async () => {
      const service = new EnsembleService();
      let capturedUrl = "";

      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        const daily: Record<string, any> = {
          time: ["2026-02-23"],
          temperature_2m_max_member01: [20],
        };
        return Promise.resolve(
          new Response(JSON.stringify({ daily }), { status: 200 })
        );
      }) as any;

      await (service as any).fetchOpenMeteo("KNYC", "2026-02-23", "high_temp");
      expect(capturedUrl).toContain("models=gfs_seamless,icon_seamless,ecmwf_ifs025");

      globalThis.fetch = originalFetch;
    });
  });

  // ── N5: source attribution ───────────────────────────────
  describe("sourceMix attribution (N5)", () => {
    test("blendMembersWithSources counts per source after duplication; counts sum to values.length", () => {
      const service = new EnsembleService();
      const tagged = [
        { value: 70, model: "gfs" },
        { value: 71, model: "gfs" },
        { value: 72, model: "ecmwf" },
        { value: 73, model: "ecmwf" },
        { value: 74, model: "tomorrow_io" },
      ];
      const hrrr = [75];

      const { values, sourceMix } = service.blendMembersWithSources(tagged, hrrr, 3); // 0-6 bucket

      // Every label's count must be a real post-duplication tally summing to the pool size.
      const sum = Object.values(sourceMix).reduce((a, b) => a + b, 0);
      expect(sum).toBe(values.length);
      // HRRR dominates the 0-6 bucket → present and the largest single source.
      expect(sourceMix.hrrr).toBeGreaterThan(0);
      expect(sourceMix.gfs).toBeGreaterThan(0);
      expect(sourceMix.ecmwf).toBeGreaterThan(0);
      expect(sourceMix.tomorrow_io).toBeGreaterThan(0);
      // tomorrow_io drew the "other" weight (0 in 0-6 bucket) → 1 member, no duplication.
      expect(sourceMix.tomorrow_io).toBe(1);
    });

    test("getEnsembleWithSources fresh path reports per-model mix summing to values.length", async () => {
      const service = new EnsembleService();
      process.env.TOMORROW_IO_API_KEY = "test-key";

      globalThis.fetch = mock((url: string) => {
        if (url.includes("ensemble-api")) {
          const daily: Record<string, any> = {
            time: ["2026-02-23"],
            temperature_2m_max_member01_ncep_gefs_seamless: [20],
            temperature_2m_max_member02_ncep_gefs_seamless: [21],
            temperature_2m_max_member01_ecmwf_ifs025: [22],
          };
          return Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }));
        }
        if (url.includes("gfs_hrrr")) {
          return Promise.resolve(new Response(JSON.stringify({
            hourly: { time: ["2026-02-23T18:00"], temperature_2m: [24] },
          }), { status: 200 }));
        }
        if (url.includes("tomorrow.io")) {
          return Promise.resolve(new Response(JSON.stringify({
            timelines: { daily: [{ time: "2026-02-23T00:00:00Z", values: { temperatureMax: 73 } }] },
          }), { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 500 }));
      }) as any;

      // 2026-02-23 is not today → no sniper bypass / same-day TTL interference;
      // horizon 10h → 6-18 bucket (HRRR + gfs + ecmwf all weighted).
      const { values, sourceMix } = await service.getEnsembleWithSources("KNYC", "2026-02-23", "high_temp", 10);

      const sum = Object.values(sourceMix).reduce((a, b) => a + b, 0);
      expect(sum).toBe(values.length);
      expect(sourceMix.hrrr).toBeGreaterThan(0);
      expect(sourceMix.gfs).toBeGreaterThan(0);
      expect(sourceMix.ecmwf).toBeGreaterThan(0);
      expect(sourceMix.tomorrow_io).toBe(1);
      // No untagged-cache label on the fresh path.
      expect(sourceMix.cached).toBeUndefined();

      globalThis.fetch = originalFetch;
      delete process.env.TOMORROW_IO_API_KEY;
    });

    test("cached path reports {cached: n} (+ fresh hrrr blend count)", async () => {
      const service = new EnsembleService();
      const cachedValues = Array.from({ length: 30 }, () => 70);

      // Seed a fresh multi_ensemble cache row for a future (non-today) date.
      const db = getDb();
      db.insert(weatherForecasts).values({
        id: crypto.randomUUID(),
        stationId: "KNYC",
        targetDate: "2026-02-23",
        source: "multi_ensemble",
        forecastType: "high_temp",
        forecastHorizon: 1,
        ensembleValues: JSON.stringify(cachedValues),
        ensembleSize: cachedValues.length,
        ensembleMean: 70,
        ensembleStd: 1,
        fetchedAt: new Date().toISOString(),
      }).run();

      // Fresh HRRR available → blended onto the untagged cache.
      globalThis.fetch = mock((url: string) => {
        if (url.includes("gfs_hrrr")) {
          return Promise.resolve(new Response(JSON.stringify({
            hourly: { time: ["2026-02-23T18:00"], temperature_2m: [25] },
          }), { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 500 }));
      }) as any;

      // horizon 15h → "6-18" bucket (HRRR weight 40, so HRRR blends onto the
      // cache) AND > sniperHorizon(12) so no forced-refresh bypass → stays on the
      // cache path. Exercises the cached + fresh-HRRR attribution branch.
      const { values, sourceMix } = await service.getEnsembleWithSources("KNYC", "2026-02-23", "high_temp", 15);

      // 30 untagged cached members reported honestly; HRRR duplicates counted accurately.
      expect(sourceMix.cached).toBe(30);
      expect(sourceMix.hrrr).toBeGreaterThan(0);
      expect(sourceMix.cached! + sourceMix.hrrr!).toBe(values.length);
      // No invented per-model attribution on the cached portion.
      expect(sourceMix.gfs).toBeUndefined();
      expect(sourceMix.ecmwf).toBeUndefined();

      globalThis.fetch = originalFetch;
    });

    test("cached path with HRRR cached too reports {cached, hrrr}", async () => {
      const service = new EnsembleService();
      const cachedValues = Array.from({ length: 30 }, () => 70);
      const db = getDb();
      // Both the ensemble and its HRRR sidecar are cached & fresh → no fetch at all.
      for (const ft of ["high_temp", "high_temp_hrrr"]) {
        db.insert(weatherForecasts).values({
          id: crypto.randomUUID(),
          stationId: "KNYC",
          targetDate: "2026-02-23",
          source: "multi_ensemble",
          forecastType: ft,
          forecastHorizon: 1,
          ensembleValues: JSON.stringify(ft.endsWith("_hrrr") ? [75] : cachedValues),
          ensembleSize: ft.endsWith("_hrrr") ? 1 : cachedValues.length,
          ensembleMean: 70,
          ensembleStd: 1,
          fetchedAt: new Date().toISOString(),
        }).run();
      }

      let fetchCalled = false;
      globalThis.fetch = mock(() => {
        fetchCalled = true;
        return Promise.resolve(new Response("", { status: 500 }));
      }) as any;

      // horizon 15h → "6-18" bucket (HRRR weight > 0) and > sniperHorizon(12) →
      // cache path, no bypass; both cache rows fresh → zero network.
      const { values, sourceMix } = await service.getEnsembleWithSources("KNYC", "2026-02-23", "high_temp", 15);

      expect(fetchCalled).toBe(false); // fully served from cache
      expect(sourceMix.cached).toBe(30);
      expect(sourceMix.hrrr).toBeGreaterThan(0);
      expect(sourceMix.cached! + sourceMix.hrrr!).toBe(values.length);

      globalThis.fetch = originalFetch;
    });

    test("getEnsembleValues wrapper still returns a plain number[] (back-compat)", async () => {
      const service = new EnsembleService();
      const cachedValues = [68, 69, 70, 71, 72];
      const db = getDb();
      db.insert(weatherForecasts).values({
        id: crypto.randomUUID(),
        stationId: "KNYC",
        targetDate: "2026-02-23",
        source: "multi_ensemble",
        forecastType: "high_temp",
        forecastHorizon: 1,
        ensembleValues: JSON.stringify(cachedValues),
        ensembleSize: cachedValues.length,
        ensembleMean: 70,
        ensembleStd: 1.5,
        fetchedAt: new Date().toISOString(),
      }).run();

      // No horizon → no HRRR blend, no sniper bypass → returns the cached array verbatim.
      const result = await service.getEnsembleValues("KNYC", "2026-02-23", "high_temp");
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual(cachedValues);
      // Critically: it is a bare number[], not the {values, sourceMix} object.
      expect((result as any).sourceMix).toBeUndefined();
      expect(result.length).toBe(cachedValues.length);
    });
  });

  // ── N6: same-day TTL + sniper-entry invalidation ─────────
  describe("same-day TTL + sniper invalidation (N6)", () => {
    test("same-day row cached >2h ago is stale → re-fetches", async () => {
      const service = new EnsembleService();
      const db = getDb();
      // Today's date, fetched 3h ago: fresh under the old 6h TTL, stale under 2h.
      db.insert(weatherForecasts).values({
        id: crypto.randomUUID(),
        stationId: "KNYC",
        targetDate: TODAY_UTC,
        source: "multi_ensemble",
        forecastType: "high_temp",
        forecastHorizon: 1,
        ensembleValues: JSON.stringify([60, 60, 60]),
        ensembleSize: 3,
        ensembleMean: 60,
        ensembleStd: 0,
        fetchedAt: hoursAgoIso(3),
      }).run();

      let openMeteoCalled = false;
      globalThis.fetch = mock((url: string) => {
        if (url.includes("ensemble-api")) {
          openMeteoCalled = true;
          const daily: Record<string, any> = {
            time: [TODAY_UTC],
            temperature_2m_max_member01: [25], // 77°F — clearly different from cached 60
          };
          return Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 500 }));
      }) as any;

      // horizon 72h (> 48) avoids the HRRR branch; > sniperHorizon avoids the
      // sniper bypass — isolating the same-day TTL behavior. targetDate==today
      // is what triggers the 2h TTL (string compare, independent of horizon).
      const { values } = await service.getEnsembleWithSources("KNYC", TODAY_UTC, "high_temp", 72);

      expect(openMeteoCalled).toBe(true); // stale → re-fetched
      expect(values).not.toContain(60); // not the stale cache
      expect(values).toContain(77);

      globalThis.fetch = originalFetch;
    });

    test("same-day row cached 1h ago is fresh → served without re-fetch", async () => {
      const service = new EnsembleService();
      const db = getDb();
      db.insert(weatherForecasts).values({
        id: crypto.randomUUID(),
        stationId: "KNYC",
        targetDate: TODAY_UTC,
        source: "multi_ensemble",
        forecastType: "high_temp",
        forecastHorizon: 1,
        ensembleValues: JSON.stringify([60, 61, 62]),
        ensembleSize: 3,
        ensembleMean: 61,
        ensembleStd: 1,
        fetchedAt: hoursAgoIso(1),
      }).run();

      let fetchCalled = false;
      globalThis.fetch = mock(() => {
        fetchCalled = true;
        return Promise.resolve(new Response("", { status: 500 }));
      }) as any;

      // horizon 72h → no HRRR, no sniper bypass → pure cache serve.
      const { values, sourceMix } = await service.getEnsembleWithSources("KNYC", TODAY_UTC, "high_temp", 72);

      expect(fetchCalled).toBe(false); // 1h < 2h TTL → served from cache
      expect(values).toEqual([60, 61, 62]);
      expect(sourceMix).toEqual({ cached: 3 });

      globalThis.fetch = originalFetch;
    });

    test("first sniper call bypasses fresh cache once; second serves it; reset re-arms", async () => {
      const service = new EnsembleService();
      const db = getDb();
      // A *fresh* (just-written) same-day cache row that would normally be served.
      db.insert(weatherForecasts).values({
        id: crypto.randomUUID(),
        stationId: "KNYC",
        targetDate: TODAY_UTC,
        source: "multi_ensemble",
        forecastType: "high_temp",
        forecastHorizon: 1,
        ensembleValues: JSON.stringify([50, 50, 50]),
        ensembleSize: 3,
        ensembleMean: 50,
        ensembleStd: 0,
        fetchedAt: new Date().toISOString(),
      }).run();

      let openMeteoCalls = 0;
      globalThis.fetch = mock((url: string) => {
        if (url.includes("ensemble-api")) {
          openMeteoCalls++;
          const daily: Record<string, any> = {
            time: [TODAY_UTC],
            temperature_2m_max_member01: [25],
          };
          return Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }));
        }
        if (url.includes("gfs_hrrr")) {
          return Promise.resolve(new Response(JSON.stringify({
            hourly: { time: [`${TODAY_UTC}T18:00`], temperature_2m: [24] },
          }), { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }) as any;

      resetSniperRefreshTracking();

      // First call inside the sniper horizon (10h <= 12h) → forced full re-fetch
      // even though the cache is fresh. open-meteo is only hit on the full path.
      await service.getEnsembleWithSources("KNYC", TODAY_UTC, "high_temp", 10);
      expect(openMeteoCalls).toBe(1);

      // Second call → key already refreshed → serves the (now-fresh) cache; the
      // full open-meteo fetch is NOT repeated.
      await service.getEnsembleWithSources("KNYC", TODAY_UTC, "high_temp", 10);
      expect(openMeteoCalls).toBe(1);

      // Reset re-arms the one-shot bypass → next sniper call re-fetches.
      resetSniperRefreshTracking();
      await service.getEnsembleWithSources("KNYC", TODAY_UTC, "high_temp", 10);
      expect(openMeteoCalls).toBe(2);

      globalThis.fetch = originalFetch;
    });
  });

  // ── N5: HRRR-failure warn path inside the sniper window ──
  describe("HRRR failure logging (N5)", () => {
    test("HRRR failure inside sniper horizon logs warn with the greppable gate string; does not throw", async () => {
      const service = new EnsembleService();

      const warnings: string[] = [];
      const unsub = bus.on("log", (e) => {
        if (e.level === "warn") warnings.push(e.message);
      });

      // open-meteo succeeds (so we don't fall to synthetic), HRRR 500s.
      globalThis.fetch = mock((url: string) => {
        if (url.includes("ensemble-api")) {
          const daily: Record<string, any> = {
            time: ["2026-02-23"],
            temperature_2m_max_member01_ncep_gefs_seamless: [20],
          };
          return Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }));
        }
        if (url.includes("gfs_hrrr")) {
          return Promise.resolve(new Response("boom", { status: 500 }));
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }) as any;

      let threw = false;
      try {
        // horizon 6h ≤ sniperHorizon(12) → warn branch.
        await service.getEnsembleWithSources("KNYC", "2026-02-23", "high_temp", 6);
      } catch {
        threw = true;
      }

      unsub();
      globalThis.fetch = originalFetch;

      expect(threw).toBe(false);
      expect(warnings.some((m) => m.includes("hrrr unavailable in sniper window"))).toBe(true);
    });

    test("HRRR failure outside the sniper horizon does NOT emit the sniper warn", async () => {
      const service = new EnsembleService();

      const warnings: string[] = [];
      const unsub = bus.on("log", (e) => {
        if (e.level === "warn") warnings.push(e.message);
      });

      globalThis.fetch = mock((url: string) => {
        if (url.includes("ensemble-api")) {
          const daily: Record<string, any> = {
            time: ["2026-02-23"],
            temperature_2m_max_member01_ncep_gefs_seamless: [20],
          };
          return Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }));
        }
        if (url.includes("gfs_hrrr")) {
          return Promise.resolve(new Response("boom", { status: 500 }));
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }) as any;

      // horizon 40h: within HRRR range (<48) so HRRR is attempted & fails, but
      // OUTSIDE the sniper horizon → debug, not the greppable warn.
      await service.getEnsembleWithSources("KNYC", "2026-02-23", "high_temp", 40);

      unsub();
      globalThis.fetch = originalFetch;

      expect(warnings.some((m) => m.includes("hrrr unavailable in sniper window"))).toBe(false);
    });
  });
});
