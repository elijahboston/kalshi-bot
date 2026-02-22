import { test, expect, describe, mock, beforeEach } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────

let dbRows: any[] = [];
let insertedRows: any[] = [];
let deletedCalls: any[] = [];

mock.module("@kcb/db", () => {
  const actual = require("@kcb/db");
  return {
    ...actual,
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(dbRows),
          }),
        }),
      }),
      delete: () => ({
        where: (...args: any[]) => {
          deletedCalls.push(args);
          return Promise.resolve();
        },
      }),
      insert: () => ({
        values: (row: any) => {
          insertedRows.push(row);
          return Promise.resolve();
        },
      }),
    }),
  };
});

mock.module("@kcb/engine", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Intercept fetch calls
let fetchMock: ReturnType<typeof mock>;
const originalFetch = globalThis.fetch;

import { EnsembleService } from "./ensemble";

beforeEach(() => {
  dbRows = [];
  insertedRows = [];
  deletedCalls = [];
});

// ── Helper: build a multi-model API response ───────────────

function buildMultiModelResponse(
  targetDate: string,
  variable: string,
  values: Record<string, number>
) {
  const daily: Record<string, any> = {
    time: [targetDate],
  };
  for (const [key, val] of Object.entries(values)) {
    daily[key] = [val];
  }
  return { daily };
}

// ── Tests ──────────────────────────────────────────────────

describe("EnsembleService", () => {
  describe("fetchOpenMeteo response parsing", () => {
    test("parses multi-model suffixed member keys", async () => {
      const targetDate = "2026-02-23";
      const service = new EnsembleService();

      // Build response with multi-model suffixed keys
      const daily: Record<string, any> = {
        time: [targetDate],
        // GFS members
        temperature_2m_max_member01_ncep_gefs_seamless: [20],
        temperature_2m_max_member02_ncep_gefs_seamless: [21],
        // ICON members
        temperature_2m_max_member01_icon_seamless_eps: [22],
        temperature_2m_max_member02_icon_seamless_eps: [23],
        // ECMWF members
        temperature_2m_max_member01_ecmwf_ifs025: [24],
        temperature_2m_max_member02_ecmwf_ifs025: [25],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }))
      ) as any;

      const values = await (service as any).fetchOpenMeteo(
        "KNYC",
        targetDate,
        "high_temp"
      );

      expect(values).toHaveLength(6);
      // Values should be converted C→F: 20C = 68F, 21C = 69.8F, etc.
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

      const values = await (service as any).fetchOpenMeteo(
        "KNYC",
        targetDate,
        "high_temp"
      );

      expect(values).toHaveLength(3);

      globalThis.fetch = originalFetch;
    });

    test("ignores non-member keys like time and main variable", async () => {
      const targetDate = "2026-02-23";
      const service = new EnsembleService();

      const daily: Record<string, any> = {
        time: [targetDate],
        temperature_2m_max: [20], // aggregate — not a member
        temperature_2m_max_member01_ncep_gefs_seamless: [20],
        temperature_2m_max_member02_ncep_gefs_seamless: [21],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }))
      ) as any;

      const values = await (service as any).fetchOpenMeteo(
        "KNYC",
        targetDate,
        "high_temp"
      );

      // Should only get the 2 member keys, not the aggregate
      expect(values).toHaveLength(2);

      globalThis.fetch = originalFetch;
    });

    test("throws when no ensemble members found", async () => {
      const targetDate = "2026-02-23";
      const service = new EnsembleService();

      const daily: Record<string, any> = {
        time: [targetDate],
        // No member keys at all
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
        time: ["2026-02-24"], // different date
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
        temperature_2m_max_member01: [0],  // 0C = 32F
        temperature_2m_max_member02: [100], // 100C = 212F
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }))
      ) as any;

      const values = await (service as any).fetchOpenMeteo(
        "KNYC",
        targetDate,
        "high_temp"
      );

      expect(values).toContain(32);
      expect(values).toContain(212);

      globalThis.fetch = originalFetch;
    });

    test("converts mm to inches for precip", async () => {
      const targetDate = "2026-02-23";
      const service = new EnsembleService();

      const daily: Record<string, any> = {
        time: [targetDate],
        precipitation_sum_member01: [25.4], // 25.4mm = 1 inch
        precipitation_sum_member02: [0],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }))
      ) as any;

      const values = await (service as any).fetchOpenMeteo(
        "KNYC",
        targetDate,
        "precip"
      );

      expect(values[0]).toBeCloseTo(1.0, 5);
      expect(values[1]).toBe(0);

      globalThis.fetch = originalFetch;
    });

    test("converts cm to inches for snowfall", async () => {
      const targetDate = "2026-02-23";
      const service = new EnsembleService();

      const daily: Record<string, any> = {
        time: [targetDate],
        snowfall_sum_member01: [2.54], // 2.54cm = 1 inch
        snowfall_sum_member02: [0],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ daily }), { status: 200 }))
      ) as any;

      const values = await (service as any).fetchOpenMeteo(
        "KNYC",
        targetDate,
        "snowfall"
      );

      expect(values[0]).toBeCloseTo(1.0, 5);
      expect(values[1]).toBe(0);

      globalThis.fetch = originalFetch;
    });
  });

  describe("cache", () => {
    test("returns cached values when fresh", async () => {
      const service = new EnsembleService();
      const cachedValues = [68, 69, 70, 71, 72];

      dbRows = [
        {
          ensembleValues: JSON.stringify(cachedValues),
          fetchedAt: new Date().toISOString(), // fresh
        },
      ];

      const result = await service.getEnsembleValues(
        "KNYC",
        "2026-02-23",
        "high_temp"
      );

      expect(result).toEqual(cachedValues);
    });

    test("cacheValues inserts with source multi_ensemble", async () => {
      const service = new EnsembleService();
      const values = [68, 69, 70];

      await (service as any).cacheValues("KNYC", "2026-02-25", "high_temp", values);

      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0].source).toBe("multi_ensemble");
      expect(insertedRows[0].ensembleSize).toBe(3);
      expect(JSON.parse(insertedRows[0].ensembleValues)).toEqual(values);
    });
  });

  describe("syntheticFallback", () => {
    test("returns 31 synthetic values", async () => {
      const service = new EnsembleService();

      // Mock fetch to fail (NWS calls)
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("", { status: 500 }))
      ) as any;

      const values = await (service as any).syntheticFallback(
        "KNYC",
        "2026-02-23",
        "high_temp"
      );

      expect(values).toHaveLength(31);
      // Should be centered around 50F (generic high temp fallback)
      const mean = values.reduce((a: number, b: number) => a + b, 0) / values.length;
      expect(mean).toBeGreaterThan(40);
      expect(mean).toBeLessThan(60);

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
});
