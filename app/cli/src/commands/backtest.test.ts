import { test, expect, describe, mock, beforeEach } from "bun:test";

// DO NOT mock @kcb/db — it leaks globally. Use real in-memory DB instead.

mock.module("@kcb/config", () => ({
  getConfig: () => ({
    kalshi: { apiKey: "", apiSecret: "", baseUrl: "" },
    bot: {
      dryRun: true,
      edgeThreshold: 0.08,
      minConfidence: 0.5,
      maxKellyFraction: 0.05,
      maxOpenPositions: 10,
      maxContractsPerOrder: 25,
      enabledSeries: [],
      enabledStations: ["KNYC"],
      tickIntervalSec: 60,
    },
    calibration: {
      biasWindowDays: 30,
      calibrationWindowDays: 30,
      maxCalibrationError: 0.05,
    },
    db: { path: ":memory:" },
    log: { level: "info" },
  }),
}));

import { runMigrations, getDb, weatherForecasts, calibration, stationBias } from "@kcb/db";

runMigrations();

import { backtestCommands } from "./backtest";

const backtestHandler = backtestCommands[0]!.handler;

beforeEach(() => {
  const db = getDb();
  db.delete(weatherForecasts).run();
  db.delete(calibration).run();
  db.delete(stationBias).run();
});

describe("backtest command", () => {
  test("returns usage when no series ticker provided", async () => {
    const result = await backtestHandler([]);
    expect(result).toContain("Usage:");
  });

  test("returns error for unknown station", async () => {
    const result = await backtestHandler(["KXHIGHXYZ"]);
    expect(result).toContain("Could not determine station");
  });

  test("returns no-data message when no forecasts found", async () => {
    const result = await backtestHandler(["KXHIGHNY"]);
    expect(result).toContain("No historical forecast data");
  });

  test("runs backtest with ensemble data and reports results", async () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const db = getDb();

    db.insert(weatherForecasts).values({
      id: "f1",
      stationId: "KNYC",
      targetDate: yesterday,
      source: "multi_ensemble",
      forecastType: "high_temp",
      forecastHorizon: 1,
      pointForecast: 30,
      ensembleValues: JSON.stringify([28, 29, 30, 30, 30, 31, 32]),
      ensembleSize: 7,
      ensembleMean: 30,
      ensembleStd: 1.2,
      actualValue: 30.5,
      fetchedAt: new Date().toISOString(),
    }).run();

    const result = await backtestHandler(["KXHIGHNY", "--days", "7"]);

    // Result is now a React element (JSX table), not a string
    expect(typeof result).not.toBe("string");
    expect(result).toBeTruthy();
  });

  test("parses --days argument", async () => {
    const result = await backtestHandler(["KXHIGHNY", "--days", "60"]);
    expect(result).toContain("60 days");
  });

  test("defaults to 30 days", async () => {
    const result = await backtestHandler(["KXHIGHNY"]);
    expect(result).toContain("30 days");
  });

  test("skips forecasts with invalid ensemble JSON", async () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const db = getDb();

    db.insert(weatherForecasts).values({
      id: "f1",
      stationId: "KNYC",
      targetDate: yesterday,
      source: "multi_ensemble",
      forecastType: "high_temp",
      forecastHorizon: 1,
      pointForecast: 30,
      ensembleValues: "not json",
      ensembleSize: 0,
      ensembleMean: null,
      ensembleStd: null,
      actualValue: 30.5,
      fetchedAt: new Date().toISOString(),
    }).run();

    const result = await backtestHandler(["KXHIGHNY"]);
    expect(result).toContain("No backtestable forecasts");
  });

  test("command is registered with correct name and aliases", () => {
    const cmd = backtestCommands[0]!;
    expect(cmd.name).toBe("backtest");
    expect(cmd.aliases).toContain("bt");
  });
});
