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

import { EnsembleService } from "./ensemble";

beforeEach(() => {
  // Clear weather_forecasts table between tests
  const db = getDb();
  db.delete(weatherForecasts).run();
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
});
