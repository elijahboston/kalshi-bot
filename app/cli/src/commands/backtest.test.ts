import { test, expect, describe, mock } from "bun:test";

// Track rows per table name for the mock
const tableRows = new Map<string, any[]>();

function setTableRows(tableName: string, rows: any[]) {
  tableRows.set(tableName, rows);
}

function getTableRows(tableName: string): any[] {
  return tableRows.get(tableName) || [];
}

// The drizzle table objects have a Symbol that references the table name.
// We extract it via the table's own properties.
function getTableName(table: any): string {
  // Drizzle SQLite tables store the name in Symbol.for("drizzle:Name") or _.name
  if (table?._?.name) return table._.name;
  if (table?.[Symbol.for("drizzle:Name")]) return table[Symbol.for("drizzle:Name")];
  return "unknown";
}

mock.module("@kcb/db", () => {
  const actual = require("@kcb/db");
  return {
    ...actual,
    getDb: () => ({
      select: (...selectArgs: any[]) => ({
        from: (table: any) => {
          const tableName = getTableName(table);
          const rows = getTableRows(tableName);
          return {
            where: (..._args: any[]) => {
              const chainable = {
                orderBy: () => Promise.resolve(rows),
                limit: () => Promise.resolve(rows),
              };
              return Object.assign(Promise.resolve(rows), chainable);
            },
            orderBy: () => ({
              limit: () => Promise.resolve(rows),
            }),
            limit: () => Promise.resolve(rows),
          };
        },
      }),
    }),
  };
});

// Mock config
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

import { backtestCommands } from "./backtest";

const backtestHandler = backtestCommands[0]!.handler;

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
    setTableRows("weather_forecasts", []);
    setTableRows("calibration", []);
    setTableRows("station_bias", []);

    const result = await backtestHandler(["KXHIGHNY"]);
    expect(result).toContain("No historical forecast data");
  });

  test("runs backtest with ensemble data and reports results", async () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

    setTableRows("weather_forecasts", [
      {
        id: "f1",
        stationId: "KNYC",
        targetDate: yesterday,
        source: "gfs_ensemble",
        forecastType: "high_temp",
        forecastHorizon: 1,
        pointForecast: 30,
        ensembleValues: JSON.stringify([28, 29, 30, 30, 30, 31, 32]),
        ensembleSize: 7,
        ensembleMean: 30,
        ensembleStd: 1.2,
        actualValue: 30.5,
        fetchedAt: new Date().toISOString(),
      },
    ]);

    // No calibration records — will use synthetic bracket
    setTableRows("calibration", []);
    // No bias data
    setTableRows("station_bias", []);

    const result = await backtestHandler(["KXHIGHNY", "--days", "7"]);

    expect(result).toContain("Backtest: KXHIGHNY");
    expect(result).toContain("Markets evaluated:");
    expect(result).toContain("Brier score:");
    expect(result).toContain("Simulated P&L:");
  });

  test("parses --days argument", async () => {
    setTableRows("weather_forecasts", []);
    setTableRows("calibration", []);
    setTableRows("station_bias", []);

    const result = await backtestHandler(["KXHIGHNY", "--days", "60"]);
    expect(result).toContain("60 days");
  });

  test("defaults to 30 days", async () => {
    setTableRows("weather_forecasts", []);
    setTableRows("calibration", []);
    setTableRows("station_bias", []);

    const result = await backtestHandler(["KXHIGHNY"]);
    expect(result).toContain("30 days");
  });

  test("skips forecasts with invalid ensemble JSON", async () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

    setTableRows("weather_forecasts", [
      {
        id: "f1",
        stationId: "KNYC",
        targetDate: yesterday,
        source: "gfs_ensemble",
        forecastType: "high_temp",
        forecastHorizon: 1,
        pointForecast: 30,
        ensembleValues: "not json",
        ensembleSize: 0,
        ensembleMean: null,
        ensembleStd: null,
        actualValue: 30.5,
        fetchedAt: new Date().toISOString(),
      },
    ]);
    setTableRows("calibration", []);
    setTableRows("station_bias", []);

    const result = await backtestHandler(["KXHIGHNY"]);
    expect(result).toContain("No backtestable forecasts");
  });

  test("command is registered with correct name and aliases", () => {
    const cmd = backtestCommands[0]!;
    expect(cmd.name).toBe("backtest");
    expect(cmd.aliases).toContain("bt");
  });
});
