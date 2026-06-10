import { test, expect, beforeEach, describe } from "bun:test";
import { loadConfig, parseStationSurcharge, applyRuntimeOverrides } from "./index";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Clear any env overrides so we test pure defaults
beforeEach(() => {
  delete process.env.EDGE_THRESHOLD;
  delete process.env.MIN_CONFIDENCE;
  delete process.env.MAX_KELLY_FRACTION;
  delete process.env.MAX_OPEN_POSITIONS;
  delete process.env.MAX_CONTRACTS_PER_ORDER;
  delete process.env.EXIT_EDGE_THRESHOLD;
  delete process.env.STOP_LOSS_PCT;
  delete process.env.EXIT_TIME_DAYS_BEFORE_CLOSE;
  delete process.env.EXIT_TIME_MIN_EDGE;
  delete process.env.MIN_CONTRACT_PRICE;
  delete process.env.EXIT_COOLDOWN_TICKS;
  delete process.env.MAX_EXPOSURE_PER_TICKER;
  delete process.env.SEED_CAPITAL;
  delete process.env.PROFIT_RESERVE_PCT;
  // Point DB to a non-existent path so runtime overrides are skipped
  process.env.DB_PATH = "/tmp/nonexistent-test.db";
});

test("loadConfig returns correct trading defaults", () => {
  const config = loadConfig();
  expect(config.bot.edgeThreshold).toBe(0.20);
  expect(config.bot.minConfidence).toBe(0.80);
  expect(config.bot.maxKellyFraction).toBe(0.05);
  expect(config.bot.maxOpenPositions).toBe(6);
  expect(config.bot.maxContractsPerOrder).toBe(15);
  expect(config.bot.flatBetSizeCents).toBe(500);
  expect(config.bot.minBetSizeCents).toBe(500);
  expect(config.bot.historicalPriorWeight).toBe(0.3);
});

test("loadConfig returns correct anti-churn defaults", () => {
  const config = loadConfig();
  expect(config.bot.minContractPrice).toBe(15);
  expect(config.bot.exitCooldownTicks).toBe(15);
  expect(config.bot.maxExposurePerTicker).toBe(1000);
  expect(config.bot.minBalanceFloor).toBe(5000);
});

test("loadConfig returns correct profit reserve defaults", () => {
  const config = loadConfig();
  expect(config.bot.seedCapital).toBe(17556);
  expect(config.bot.profitReservePct).toBe(0.5);
});

test("loadConfig returns correct exit strategy defaults", () => {
  const config = loadConfig();
  expect(config.bot.exitEdgeThreshold).toBe(0.03);
  expect(config.bot.stopLossPct).toBe(0.25);
  expect(config.bot.exitTimeDaysBeforeClose).toBe(0.25);
  expect(config.bot.exitTimeMinEdge).toBe(0.08);
});

test("exit strategy env vars override defaults", () => {
  process.env.EXIT_EDGE_THRESHOLD = "0.05";
  process.env.STOP_LOSS_PCT = "0.15";
  process.env.EXIT_TIME_DAYS_BEFORE_CLOSE = "0.5";
  process.env.EXIT_TIME_MIN_EDGE = "0.10";

  const config = loadConfig();
  expect(config.bot.exitEdgeThreshold).toBe(0.05);
  expect(config.bot.stopLossPct).toBe(0.15);
  expect(config.bot.exitTimeDaysBeforeClose).toBe(0.5);
  expect(config.bot.exitTimeMinEdge).toBe(0.10);
});

test("env vars override defaults", () => {
  process.env.EDGE_THRESHOLD = "0.20";
  process.env.MIN_CONFIDENCE = "0.80";
  process.env.MAX_KELLY_FRACTION = "0.01";
  process.env.MAX_OPEN_POSITIONS = "3";
  process.env.MAX_CONTRACTS_PER_ORDER = "10";

  const config = loadConfig();
  expect(config.bot.edgeThreshold).toBe(0.20);
  expect(config.bot.minConfidence).toBe(0.80);
  expect(config.bot.maxKellyFraction).toBe(0.01);
  expect(config.bot.maxOpenPositions).toBe(3);
  expect(config.bot.maxContractsPerOrder).toBe(10);
});

test("anti-churn env vars override defaults", () => {
  process.env.MIN_CONTRACT_PRICE = "20";
  process.env.EXIT_COOLDOWN_TICKS = "5";
  process.env.MAX_EXPOSURE_PER_TICKER = "1000";

  const config = loadConfig();
  expect(config.bot.minContractPrice).toBe(20);
  expect(config.bot.exitCooldownTicks).toBe(5);
  expect(config.bot.maxExposurePerTicker).toBe(1000);
});

test("profit reserve env vars override defaults", () => {
  process.env.SEED_CAPITAL = "10000";
  process.env.PROFIT_RESERVE_PCT = "0.75";

  const config = loadConfig();
  expect(config.bot.seedCapital).toBe(10000);
  expect(config.bot.profitReservePct).toBe(0.75);
});

describe("parseStationSurcharge", () => {
  test("empty / null / undefined → empty map", () => {
    expect(parseStationSurcharge("")).toEqual({});
    expect(parseStationSurcharge(null)).toEqual({});
    expect(parseStationSurcharge(undefined)).toEqual({});
  });

  test("malformed JSON → empty map", () => {
    expect(parseStationSurcharge("not json")).toEqual({});
    expect(parseStationSurcharge("{KORD: 0.1}")).toEqual({});
  });

  test("non-object JSON → empty map", () => {
    expect(parseStationSurcharge("42")).toEqual({});
    expect(parseStationSurcharge("[1,2,3]")).toEqual({});
    expect(parseStationSurcharge("null")).toEqual({});
  });

  test("parses valid station map", () => {
    expect(parseStationSurcharge('{"KORD":0.15,"KLAX":0.10}')).toEqual({
      KORD: 0.15,
      KLAX: 0.1,
    });
  });

  test("string values are coerced when numeric, dropped when not", () => {
    expect(parseStationSurcharge('{"KORD":"0.10","KLAX":"bogus"}')).toEqual({
      KORD: 0.1,
    });
  });

  test("non-finite values are dropped", () => {
    // JSON.stringify drops NaN/Infinity, but we still guard against runtime parsers
    expect(parseStationSurcharge('{"KORD":1e9999}')).toEqual({});
  });
});

describe("applyRuntimeOverrides (refreshRuntimeConfig's re-apply behavior)", () => {
  // A unique temp DB per run so we don't touch the real ./data DB. We test the
  // pure re-apply path directly rather than via getConfig()/the singleton —
  // other test files mock.module("@kcb/config") globally, which would replace
  // getConfig in the full-suite process and make singleton assertions flaky.
  const dbPath = join(tmpdir(), `kcb-cfg-refresh-${process.pid}.db`);

  function seedRow(key: string, value: string) {
    const db = new Database(dbPath);
    db.run(
      "CREATE TABLE IF NOT EXISTS runtime_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    db.run(
      "INSERT INTO runtime_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value]
    );
    db.close();
  }

  test("re-applying picks up a row changed after the config was loaded", () => {
    // A complete config pointed at our temp DB (loadConfig is the real export
    // and reads env defaults for every key).
    process.env.DB_PATH = dbPath;
    seedRow("max_contracts_per_order", "10");
    const config = loadConfig();
    config.db.path = dbPath;
    expect(config.bot.maxContractsPerOrder).toBe(10); // baked in at load

    // Change the row AFTER load — this is the exact bug: getConfig caches once
    // per process, so without re-applying the value stays stale.
    seedRow("max_contracts_per_order", "20");
    expect(config.bot.maxContractsPerOrder).toBe(10); // still stale
    applyRuntimeOverrides(config); // what refreshRuntimeConfig calls each tick
    expect(config.bot.maxContractsPerOrder).toBe(20); // applied in place

    // A boolean knob (the 2026-06-09 sizing-enable class) flips the same way.
    seedRow("confidence_size_pct_enabled", "true");
    applyRuntimeOverrides(config);
    expect(config.bot.confidenceSizePctEnabled).toBe(true);
  });

  test("a missing DB is a silent no-op (does not throw)", () => {
    const config = loadConfig();
    config.db.path = join(tmpdir(), `kcb-cfg-absent-${process.pid}.db`);
    expect(() => applyRuntimeOverrides(config)).not.toThrow();
  });
});

test("stationEdgeSurcharge defaults to empty map", () => {
  delete process.env.STATION_EDGE_SURCHARGE;
  const config = loadConfig();
  expect(config.bot.stationEdgeSurcharge).toEqual({});
});

test("STATION_EDGE_SURCHARGE env var populates the map", () => {
  process.env.STATION_EDGE_SURCHARGE = '{"KORD":0.15,"KNYC":0.10}';
  const config = loadConfig();
  expect(config.bot.stationEdgeSurcharge).toEqual({ KORD: 0.15, KNYC: 0.1 });
  delete process.env.STATION_EDGE_SURCHARGE;
});
