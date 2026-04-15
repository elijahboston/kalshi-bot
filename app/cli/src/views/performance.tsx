import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Table from "../components/table";
import {
  PortfolioChart,
  CalibrationChart,
  DailyPnlChart,
  SigmaComparisonChart,
  AccuracySparkline,
  formatDuration,
} from "./charts";
import {
  getPerformanceCache,
  type CachedPerformanceData,
} from "./performance-cache";

// Re-export for existing test imports
export { queryWindowedWinRates } from "./performance-cache";
export type { WindowedWinRate } from "./performance-cache";

export function PerformanceView() {
  const [data, setData] = useState<CachedPerformanceData | null>(null);

  useEffect(() => {
    const cache = getPerformanceCache();
    const unsubscribe = cache.subscribe(setData);
    cache.init();
    const stopListening = cache.startListening();
    return () => {
      unsubscribe();
      stopListening();
    };
  }, []);

  if (!data) {
    return <Text color="gray">Loading performance data...</Text>;
  }

  const { stats, orderRows, portfolioHistory, resolutions, bucketStats, dailyPnl, windowedWinRates, forecastAccuracy } = data;

  return (
    <Box flexDirection="column">
      {/* Stats Bar — Row 1 */}
      <Box gap={2}>
        <Text>
          <Text bold color="cyan">Cash</Text>{" "}
          <Text>${(stats.cash / 100).toFixed(2)}</Text>
        </Text>
        <Text>
          <Text bold color="cyan">Portfolio</Text>{" "}
          <Text>${(stats.portfolio / 100).toFixed(2)}</Text>
        </Text>
        <Text>
          <Text bold color="cyan">Unreal</Text>{" "}
          <Text color={stats.unrealizedPnl >= 0 ? "green" : "red"}>
            {stats.unrealizedPnl >= 0 ? "+" : ""}${(stats.unrealizedPnl / 100).toFixed(2)}
          </Text>
        </Text>
        <Text>
          <Text bold color="cyan">Real</Text>{" "}
          <Text color={stats.realizedPnl >= 0 ? "green" : "red"}>
            {stats.realizedPnl >= 0 ? "+" : ""}${(stats.realizedPnl / 100).toFixed(2)}
          </Text>
        </Text>
      </Box>
      {/* Stats Bar — Row 2 */}
      <Box gap={2} marginBottom={1}>
        <Text>
          <Text bold color="cyan">Win</Text>{" "}
          <Text>{(stats.winRate * 100).toFixed(1)}%</Text>
        </Text>
        <Text>
          <Text bold color="cyan">Brier</Text>{" "}
          <Text>{stats.brierScore.toFixed(3)}</Text>
        </Text>
        <Text>
          <Text bold color="cyan">Orders</Text>{" "}
          <Text>{stats.orderCount}</Text>
        </Text>
        <Text>
          <Text bold color="cyan">Pos</Text>{" "}
          <Text>{stats.positionCount}</Text>
        </Text>
      </Box>

      {/* Windowed Win Rates */}
      <Box gap={2} marginBottom={1}>
        {windowedWinRates.map((w) => (
          <Text key={w.label}>
            <Text bold color="cyan">{w.label}</Text>{" "}
            <Text color={w.total === 0 ? "gray" : w.rate >= 0.5 ? "green" : "red"}>
              {w.total === 0 ? "—" : `${(w.rate * 100).toFixed(1)}%`}
            </Text>
            <Text color="gray"> ({w.wins}/{w.total})</Text>
          </Text>
        ))}
      </Box>

      {/* Portfolio Curve */}
      <Text bold color="cyan">{"─── Portfolio (" + (portfolioHistory.length >= 2
        ? formatDuration(
            new Date(portfolioHistory[portfolioHistory.length - 1]!.recordedAt).getTime() -
            new Date(portfolioHistory[0]!.recordedAt).getTime()
          )
        : portfolioHistory.length + " snapshots") + ") " + "─".repeat(40)}</Text>
      <Box marginBottom={1}>
        <PortfolioChart points={portfolioHistory} width={60} height={8} />
      </Box>

      {/* Calibration Buckets */}
      <Text bold color="cyan">{"─── Calibration Buckets " + "─".repeat(56)}</Text>
      <Box marginBottom={1}>
        <CalibrationChart buckets={bucketStats} />
      </Box>

      {/* P&L by Day */}
      <Text bold color="cyan">{"─── P&L by Day " + "─".repeat(65)}</Text>
      <Box marginBottom={1}>
        <DailyPnlChart days={dailyPnl} />
      </Box>

      {/* Recent Resolutions */}
      <Text bold color="cyan">{"─── Recent Resolutions " + "─".repeat(57)}</Text>
      {resolutions.length === 0 ? (
        <Text color="gray">No resolved trades yet.</Text>
      ) : (
        <Table
          data={resolutions.map((r) => ({
            ticker: r.ticker,
            predicted: `${(r.predictedProb * 100).toFixed(0)}%`,
            actual: r.actualOutcome === 1 ? "YES" : "NO",
            edge: `${r.edge > 0 ? "+" : ""}${(r.edge * 100).toFixed(1)}`,
            pnl: r.realizedPnl != null
              ? `${r.realizedPnl > 0 ? "+" : ""}$${(r.realizedPnl / 100).toFixed(2)}`
              : "—",
          }))}
          columns={["ticker", "predicted", "actual", "edge", "pnl"]}
          cell={({ children, column }) => {
            const val = String(children);
            if (column === "edge") {
              return <Text color={val.startsWith("+") ? "green" : "red"}>{children}</Text>;
            }
            if (column === "pnl") {
              const color = val.startsWith("+$") ? "green" : val.startsWith("-$") ? "red" : "gray";
              return <Text color={color}>{children}</Text>;
            }
            if (column === "actual") {
              return <Text color={val === "YES" ? "green" : "red"}>{children}</Text>;
            }
            return <Text>{children}</Text>;
          }}
        />
      )}

      <Box marginTop={1} />

      {/* Forecast Accuracy (#8) */}
      {forecastAccuracy && (
        <>
          <Text bold color="cyan">{"─── Forecast Accuracy (last 30 days) " + "─".repeat(43)}</Text>
          <Box flexDirection="column" marginBottom={1}>
            <Box gap={2}>
              <Text>
                <Text bold color="cyan">Correct bracket (top-1)</Text>{" "}
                <Text color={forecastAccuracy.bracketAccuracy >= 0.5 ? "green" : "yellow"}>
                  {(forecastAccuracy.bracketAccuracy * 100).toFixed(1)}%
                </Text>
                <Text color="gray"> ({forecastAccuracy.bracketCorrect}/{forecastAccuracy.bracketTotal})</Text>
              </Text>
            </Box>
            {forecastAccuracy.accuracyHistory.length > 2 && (
              <Box gap={1}>
                <Text bold color="cyan">Accuracy trend</Text>
                <AccuracySparkline values={forecastAccuracy.accuracyHistory} threshold={0.7} />
              </Box>
            )}
            {forecastAccuracy.avgSigmaUsed > 0 && forecastAccuracy.avgEnsembleStd > 0 && (
              <>
                <Text bold color="cyan" dimColor>Sigma comparison:</Text>
                <SigmaComparisonChart
                  ensembleSpread={forecastAccuracy.avgEnsembleStd}
                  empiricalSigma={forecastAccuracy.avgSigmaUsed}
                  actualError={forecastAccuracy.avgActualError}
                />
              </>
            )}
          </Box>
        </>
      )}

      {/* Order History (compact) */}
      <Text bold color="cyan">{"─── Order History (" + orderRows.length + ") " + "─".repeat(57)}</Text>
      {orderRows.length === 0 ? (
        <Text color="gray">No orders yet.</Text>
      ) : (
        <Table
          data={orderRows.map((o) => ({
            time: o.createdAt.slice(11, 19),
            ticker: o.ticker,
            side: o.side.toUpperCase(),
            qty: String(o.quantity),
            price: `${o.limitPrice}¢`,
            status: o.status,
            kelly: o.kellyFraction != null ? o.kellyFraction.toFixed(2) : "—",
            dry: o.dryRun ? "DRY" : "—",
          }))}
          columns={["time", "ticker", "side", "qty", "price", "status", "kelly", "dry"]}
          cell={({ children, column }) => {
            const val = String(children);
            if (column === "status") {
              const color = val === "filled" ? "green" : val === "open" ? "yellow" : "gray";
              return <Text color={color}>{children}</Text>;
            }
            if (column === "dry") {
              return <Text color={val === "DRY" ? "yellow" : "gray"}>{children}</Text>;
            }
            if (column === "time") {
              return <Text color="gray">{children}</Text>;
            }
            return <Text>{children}</Text>;
          }}
        />
      )}
    </Box>
  );
}
