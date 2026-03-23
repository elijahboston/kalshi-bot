import { test, expect, beforeEach } from "bun:test";
import { loadConfig } from "./index";

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
  expect(config.bot.edgeThreshold).toBe(0.15);
  expect(config.bot.minConfidence).toBe(0.65);
  expect(config.bot.maxKellyFraction).toBe(0.025);
  expect(config.bot.maxOpenPositions).toBe(6);
  expect(config.bot.maxContractsPerOrder).toBe(15);
});

test("loadConfig returns correct anti-churn defaults", () => {
  const config = loadConfig();
  expect(config.bot.minContractPrice).toBe(15);
  expect(config.bot.exitCooldownTicks).toBe(3);
  expect(config.bot.maxExposurePerTicker).toBe(500);
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
