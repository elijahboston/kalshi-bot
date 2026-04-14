import React from "react";
import { Text, Box } from "ink";
import Table from "../components/table";
import { getDb, weatherForecasts, calibration, and, sql, gte, eq, desc } from "@kcb/db";
import type { Market } from "@kcb/db";
import { ProbabilityEstimator } from "@kcb/signals";
import { computeKelly } from "@kcb/execution";
import { parseTicker } from "../../../../app/engine/services/discovery";
import { seriesCategory, extractStationFromSeries } from "@kcb/shared";
import type { CommandDef, CommandResult } from "./index";

export const backtestCommands: CommandDef[] = [
  {
    name: "backtest",
    aliases: ["bt"],
    description: "Backtest estimator against historical weather data",
    usage: "backtest <series_ticker> [--days N]",
    handler: async (args) => {
      const seriesTicker = args[0]?.toUpperCase();
      if (!seriesTicker) {
        return "Usage: backtest <series_ticker> [--days N]\nExample: backtest KXHIGHNY --days 30";
      }

      let days = 30;
      const daysIdx = args.indexOf("--days");
      if (daysIdx !== -1 && args[daysIdx + 1]) {
        const parsed = Number(args[daysIdx + 1]);
        if (!Number.isNaN(parsed) && parsed > 0) {
          days = parsed;
        }
      }

      return await runBacktest(seriesTicker, days);
    },
  },
];

interface BacktestResult {
  targetDate: string;
  bracketLow: number;
  bracketHigh: number;
  probability: number;
  actualOutcome: number;
  brierContribution: number;
  kellyFraction: number;
  simulatedPnl: number;
}

async function runBacktest(seriesTicker: string, days: number): Promise<CommandResult> {
  const db = getDb();
  const stationId = extractStationFromSeries(seriesTicker);
  const category = seriesCategory(seriesTicker);

  if (!stationId) {
    return `Could not determine station for series ${seriesTicker}`;
  }

  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  // Get forecasts with actual values and ensemble data
  const forecasts = await db
    .select()
    .from(weatherForecasts)
    .where(
      and(
        eq(weatherForecasts.stationId, stationId),
        eq(weatherForecasts.forecastType, category),
        sql`${weatherForecasts.actualValue} IS NOT NULL`,
        sql`${weatherForecasts.ensembleValues} IS NOT NULL`,
        gte(weatherForecasts.targetDate, cutoff)
      )
    )
    .orderBy(desc(weatherForecasts.targetDate));

  if (forecasts.length === 0) {
    return `No historical forecast data with actuals found for ${seriesTicker} (station ${stationId}, category ${category}) in the last ${days} days.`;
  }

  // Group by targetDate — take first forecast per day
  const byDate = new Map<string, typeof forecasts[0]>();
  for (const f of forecasts) {
    if (!byDate.has(f.targetDate)) {
      byDate.set(f.targetDate, f);
    }
  }

  // Get resolved calibration records for this series to determine brackets
  const calRecords = await db
    .select()
    .from(calibration)
    .where(
      and(
        eq(calibration.stationId, stationId),
        eq(calibration.category, category),
        gte(calibration.resolvedAt, new Date(Date.now() - days * 86400_000).toISOString())
      )
    );

  // Build bracket set from calibration data — each ticker tells us what brackets existed
  // If no calibration data, use a default bracket width of 1 degree around the actual
  const estimator = new ProbabilityEstimator();
  const results: BacktestResult[] = [];

  for (const [targetDate, forecast] of byDate) {
    let ensembleValues: number[];
    try {
      ensembleValues = JSON.parse(forecast.ensembleValues!);
      if (!Array.isArray(ensembleValues) || ensembleValues.length === 0) continue;
    } catch {
      continue;
    }

    const actualValue = forecast.actualValue!;

    // Find calibration records for this target date to get bracket info
    const dateCalRecords = calRecords.filter((r) => {
      const parsed = parseTicker(r.ticker);
      return parsed?.targetDate === targetDate;
    });

    if (dateCalRecords.length > 0) {
      // Evaluate each bracket that had a calibration record
      for (const calRecord of dateCalRecords) {
        const parsed = parseTicker(calRecord.ticker);
        if (!parsed || parsed.bracketLow == null) continue;

        const bracketLow = parsed.bracketLow;
        const bracketHigh = bracketLow + 1;

        const market: Market = {
          ticker: calRecord.ticker,
          eventTicker: parsed.eventTicker,
          seriesTicker: parsed.seriesTicker,
          title: `Backtest ${calRecord.ticker}`,
          category,
          stationId,
          targetDate,
          bracketLow,
          bracketHigh,
          status: "settled",
          closeTime: null,
          result: null,
          lastYesPrice: Math.round(calRecord.marketPrice * 100),
          lastNoPrice: Math.round((1 - calRecord.marketPrice) * 100),
          discoveredAt: forecast.fetchedAt,
          updatedAt: forecast.fetchedAt,
        };

        try {
          const estimate = await estimator.estimate(market, ensembleValues);
          const actualOutcome = (actualValue >= bracketLow && actualValue < bracketHigh) ? 1 : 0;
          const brierContribution = (estimate.probability - actualOutcome) ** 2;
          const marketPrice = calRecord.marketPrice;
          const side: "yes" | "no" = estimate.probability > marketPrice ? "yes" : "no";
          const kellyFraction = computeKelly(estimate.probability, marketPrice, side);

          // Simulate PnL: if Kelly > 0, we would have traded
          let simulatedPnl = 0;
          if (kellyFraction > 0) {
            const cost = side === "yes" ? marketPrice : (1 - marketPrice);
            const won = (side === "yes" && actualOutcome === 1) || (side === "no" && actualOutcome === 0);
            simulatedPnl = won ? (1 - cost) : -cost;
            simulatedPnl *= kellyFraction; // Scale by Kelly fraction
          }

          results.push({
            targetDate,
            bracketLow,
            bracketHigh,
            probability: estimate.probability,
            actualOutcome,
            brierContribution,
            kellyFraction,
            simulatedPnl,
          });
        } catch {
          // Skip markets where estimation fails
        }
      }
    } else {
      // No calibration data for this date — create a synthetic bracket around actual value
      const bracketLow = Math.floor(actualValue);
      const bracketHigh = bracketLow + 1;

      const syntheticTicker = `${seriesTicker}-BACKTEST-B${bracketLow}`;
      const market: Market = {
        ticker: syntheticTicker,
        eventTicker: `${seriesTicker}-BACKTEST`,
        seriesTicker,
        title: `Backtest ${syntheticTicker}`,
        category,
        stationId,
        targetDate,
        bracketLow,
        bracketHigh,
        status: "settled",
        closeTime: null,
        result: null,
        lastYesPrice: 50,
        lastNoPrice: 50,
        discoveredAt: forecast.fetchedAt,
        updatedAt: forecast.fetchedAt,
      };

      try {
        const estimate = await estimator.estimate(market, ensembleValues);
        const actualOutcome = (actualValue >= bracketLow && actualValue < bracketHigh) ? 1 : 0;
        const brierContribution = (estimate.probability - actualOutcome) ** 2;
        const marketPrice = 0.5; // no market data, assume 50%
        const side: "yes" | "no" = estimate.probability > marketPrice ? "yes" : "no";
        const kellyFraction = computeKelly(estimate.probability, marketPrice, side);

        let simulatedPnl = 0;
        if (kellyFraction > 0) {
          const cost = side === "yes" ? marketPrice : (1 - marketPrice);
          const won = (side === "yes" && actualOutcome === 1) || (side === "no" && actualOutcome === 0);
          simulatedPnl = won ? (1 - cost) : -cost;
          simulatedPnl *= kellyFraction;
        }

        results.push({
          targetDate,
          bracketLow,
          bracketHigh,
          probability: estimate.probability,
          actualOutcome,
          brierContribution,
          kellyFraction,
          simulatedPnl,
        });
      } catch {
        // Skip
      }
    }
  }

  if (results.length === 0) {
    return `No backtestable forecasts found for ${seriesTicker} in the last ${days} days.`;
  }

  return formatReport(seriesTicker, days, results);
}

function formatReport(seriesTicker: string, days: number, results: BacktestResult[]): CommandResult {
  const totalMarkets = results.length;
  const signalsGenerated = results.filter((r) => r.kellyFraction > 0).length;
  const wins = results.filter((r) => {
    if (r.kellyFraction <= 0) return false;
    const side = r.probability > 0.5 ? "yes" : "no";
    return (side === "yes" && r.actualOutcome === 1) || (side === "no" && r.actualOutcome === 0);
  }).length;
  const winRate = signalsGenerated > 0 ? wins / signalsGenerated : 0;

  const brierScore = results.reduce((sum, r) => sum + r.brierContribution, 0) / totalMarkets;
  const totalPnl = results.reduce((sum, r) => sum + r.simulatedPnl, 0);

  const shown = results.slice(0, 20);
  const tableData = shown.map((r) => ({
    date: r.targetDate,
    bracket: `[${r.bracketLow},${r.bracketHigh})`,
    "est p": `${(r.probability * 100).toFixed(0)}%`,
    actual: r.actualOutcome === 1 ? "YES" : "NO",
    brier: r.brierContribution.toFixed(4),
    kelly: r.kellyFraction > 0 ? r.kellyFraction.toFixed(3) : "—",
    "p&l": r.kellyFraction > 0 ? `${r.simulatedPnl >= 0 ? "+" : ""}${r.simulatedPnl.toFixed(3)}` : "—",
  }));

  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true }, `=== Backtest: ${seriesTicker} (${days} days) ===`),
    React.createElement(Text, null, ""),
    React.createElement(Text, null, `Markets evaluated:   ${totalMarkets}`),
    React.createElement(Text, null, `Signals generated:   ${signalsGenerated}`),
    React.createElement(Text, null, `Win rate:            ${signalsGenerated > 0 ? `${(winRate * 100).toFixed(1)}% (${wins}/${signalsGenerated})` : "N/A"}`),
    React.createElement(Text, null, `Brier score:         ${brierScore.toFixed(4)} ${brierScore < 0.25 ? "(good)" : brierScore < 0.33 ? "(fair)" : "(poor)"}`),
    React.createElement(Text, null, `Simulated P\&L:       ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} (Kelly-weighted units)`),
    React.createElement(Text, null, ""),
    React.createElement(Text, { bold: true }, "Per-day breakdown:"),
    React.createElement(Table, {
      data: tableData,
      columns: ["date", "bracket", "est p", "actual", "brier", "kelly", "p&l"],
      cell: ({ children, column }: { children: React.ReactNode; column: string }) => {
        const val = String(children);
        if (column === "actual") {
          return React.createElement(Text, { color: val === "YES" ? "green" : "red" }, children);
        }
        if (column === "p&l" && val !== "—") {
          return React.createElement(Text, { color: val.startsWith("+") ? "green" : "red" }, children);
        }
        return React.createElement(Text, null, children);
      },
    }),
    results.length > 20 ? React.createElement(Text, { color: "gray" }, `  ... and ${results.length - 20} more`) : null,
  );
}

export { runBacktest };
