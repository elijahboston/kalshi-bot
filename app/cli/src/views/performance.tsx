import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Table from "../components/table";
import { bus } from "@kcb/engine";
import {
  getDb,
  orders,
  trades,
  positions,
  calibration,
  balanceHistory,
  desc,
  sql,
  count,
  avg,
  sum,
} from "@kcb/db";
import {
  PortfolioChart,
  CalibrationChart,
  DailyPnlChart,
  SigmaComparisonChart,
  AccuracySparkline,
  formatDuration,
  type PortfolioPoint,
  type BucketData,
  type DailyPnlEntry,
} from "./charts";

interface Stats {
  cash: number;
  portfolio: number;
  unrealizedPnl: number;
  realizedPnl: number;
  winRate: number;
  brierScore: number;
  orderCount: number;
  positionCount: number;
}

export interface WindowedWinRate {
  label: string;
  wins: number;
  total: number;
  rate: number;
}

/**
 * Query win rates for multiple time windows from the calibration table.
 * Exported for testing.
 */
export async function queryWindowedWinRates(
  db: ReturnType<typeof getDb>,
): Promise<WindowedWinRate[]> {
  const windows = [
    { label: "24h", hours: 24 },
    { label: "48h", hours: 48 },
    { label: "7d", hours: 168 },
  ];

  const results: WindowedWinRate[] = [];
  for (const w of windows) {
    const cutoff = new Date(Date.now() - w.hours * 60 * 60 * 1000).toISOString();
    const rows = await db
      .select({
        total: count(),
        wins: sql<number>`SUM(CASE WHEN ${calibration.realizedPnl} > 0 THEN 1 ELSE 0 END)`,
      })
      .from(calibration)
      .where(sql`${calibration.traded} = 1 AND ${calibration.resolvedAt} >= ${cutoff}`);

    const total = Number(rows[0]?.total ?? 0);
    const wins = Number(rows[0]?.wins ?? 0);
    results.push({
      label: w.label,
      wins,
      total,
      rate: total > 0 ? wins / total : 0,
    });
  }

  return results;
}

interface OrderRow {
  createdAt: string;
  ticker: string;
  side: string;
  quantity: number;
  limitPrice: number;
  status: string;
  kellyFraction: number | null;
  dryRun: boolean;
}

interface Resolution {
  ticker: string;
  predictedProb: number;
  actualOutcome: number;
  edge: number;
  realizedPnl: number | null;
}

const BUCKETS = [
  { label: "0.0-0.1", low: 0.0, high: 0.1 },
  { label: "0.1-0.2", low: 0.1, high: 0.2 },
  { label: "0.2-0.3", low: 0.2, high: 0.3 },
  { label: "0.3-0.5", low: 0.3, high: 0.5 },
  { label: "0.5-0.7", low: 0.5, high: 0.7 },
  { label: "0.7-1.0", low: 0.7, high: 1.0 },
] as const;

export function PerformanceView() {
  const [stats, setStats] = useState<Stats>({
    cash: 0,
    portfolio: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
    winRate: 0,
    brierScore: 0,
    orderCount: 0,
    positionCount: 0,
  });
  const [orderRows, setOrderRows] = useState<OrderRow[]>([]);
  const [portfolioHistory, setPortfolioHistory] = useState<PortfolioPoint[]>([]);
  const [resolutions, setResolutions] = useState<Resolution[]>([]);
  const [bucketStats, setBucketStats] = useState<BucketData[]>([]);
  const [dailyPnl, setDailyPnl] = useState<DailyPnlEntry[]>([]);
  const [windowedWinRates, setWindowedWinRates] = useState<WindowedWinRate[]>([]);
  const [forecastAccuracy, setForecastAccuracy] = useState<{
    bracketAccuracy: number;
    bracketCorrect: number;
    bracketTotal: number;
    avgSigmaUsed: number;
    avgEnsembleStd: number;
    avgActualError: number;
    accuracyHistory: number[];
  } | null>(null);

  const loadData = async () => {
    const db = getDb();

    // Load latest balance
    const latestBalance = await db
      .select()
      .from(balanceHistory)
      .orderBy(desc(balanceHistory.recordedAt))
      .limit(1);

    // Load positions for count + unrealized PnL
    const openPositions = await db.select().from(positions);
    const unrealizedPnl = openPositions.reduce(
      (s, p) => s + (p.unrealizedPnl ?? 0),
      0,
    );

    // Load order + trade counts from orders/trades tables (live data)
    const orderCount = await db.select({ value: count() }).from(orders);
    const tradeCount = await db.select({ value: count() }).from(trades);

    // Load calibration aggregates (only populated after markets settle)
    const calAgg = await db
      .select({
        avgBrier: avg(
          sql`(${calibration.predictedProb} - ${calibration.actualOutcome}) * (${calibration.predictedProb} - ${calibration.actualOutcome})`,
        ),
        settledCount: count(),
        totalPnl: sum(calibration.realizedPnl),
        wins: count(
          sql`CASE WHEN ${calibration.realizedPnl} > 0 THEN 1 END`,
        ),
      })
      .from(calibration)
      .where(sql`${calibration.traded} = 1`);

    const settledCount = Number(calAgg[0]?.settledCount ?? 0);
    const wins = Number(calAgg[0]?.wins ?? 0);

    setStats({
      cash: latestBalance[0]?.balance ?? 0,
      portfolio: latestBalance[0]?.totalEquity ?? 0,
      unrealizedPnl,
      realizedPnl: Number(calAgg[0]?.totalPnl ?? 0),
      winRate: settledCount > 0 ? wins / settledCount : 0,
      brierScore: Number(calAgg[0]?.avgBrier ?? 0),
      orderCount: Number(orderCount[0]?.value ?? 0) + Number(tradeCount[0]?.value ?? 0),
      positionCount: openPositions.length,
    });

    // Load recent orders
    const recentOrders = await db
      .select({
        createdAt: orders.createdAt,
        ticker: orders.ticker,
        side: orders.side,
        quantity: orders.quantity,
        limitPrice: orders.limitPrice,
        status: orders.status,
        kellyFraction: orders.kellyFraction,
        dryRun: orders.dryRun,
      })
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(20);

    setOrderRows(recentOrders);

    // Load full equity history for chart (all snapshots since bot init)
    const eqHistory = await db
      .select({
        totalEquity: balanceHistory.totalEquity,
        recordedAt: balanceHistory.recordedAt,
      })
      .from(balanceHistory)
      .orderBy(balanceHistory.recordedAt);

    setPortfolioHistory(
      eqHistory.map((r) => ({ portfolio: r.totalEquity, recordedAt: r.recordedAt })),
    );

    // Load recent resolutions
    const recentRes = await db
      .select({
        ticker: calibration.ticker,
        predictedProb: calibration.predictedProb,
        actualOutcome: calibration.actualOutcome,
        edge: calibration.edge,
        realizedPnl: calibration.realizedPnl,
      })
      .from(calibration)
      .where(sql`${calibration.traded} = 1`)
      .orderBy(desc(calibration.resolvedAt))
      .limit(10);

    setResolutions(recentRes);

    // Load calibration bucket stats
    const calRecords = await db
      .select({
        predictedProb: calibration.predictedProb,
        actualOutcome: calibration.actualOutcome,
      })
      .from(calibration);

    const bucketData: BucketData[] = BUCKETS.map((bucket) => {
      const inBucket = calRecords.filter(
        (r) => r.predictedProb >= bucket.low && r.predictedProb < bucket.high,
      );
      return {
        label: bucket.label,
        hits: inBucket.filter((r) => r.actualOutcome === 1).length,
        total: inBucket.length,
      };
    });
    setBucketStats(bucketData);

    // Load daily P&L (last 7 days)
    const dailyRows = await db
      .select({
        day: sql<string>`date(${calibration.resolvedAt})`.as("day"),
        pnl: sql<number>`COALESCE(SUM(${calibration.realizedPnl}), 0)`.as("pnl"),
      })
      .from(calibration)
      .where(sql`${calibration.traded} = 1`)
      .groupBy(sql`date(${calibration.resolvedAt})`)
      .orderBy(sql`date(${calibration.resolvedAt}) DESC`)
      .limit(7);

    setDailyPnl(
      dailyRows
        .map((r) => ({ date: r.day, pnl: Number(r.pnl) }))
        .reverse(),
    );

    // Load windowed win rates
    setWindowedWinRates(await queryWindowedWinRates(db));

    // Load forecast accuracy (#8)
    try {
      const cutoff30d = new Date(Date.now() - 30 * 86400_000).toISOString();
      const accuracyRecords = await db
        .select({
          predictedProb: calibration.predictedProb,
          actualOutcome: calibration.actualOutcome,
        })
        .from(calibration)
        .where(sql`${calibration.resolvedAt} >= ${cutoff30d}`);

      if (accuracyRecords.length > 0) {
        // Bracket accuracy: was our top-1 bracket correct?
        // A correct bracket = predicted prob > 0.5 and actual = YES, or predicted prob < 0.5 and actual = NO
        const bracketCorrect = accuracyRecords.filter((r) =>
          (r.predictedProb >= 0.5 && r.actualOutcome === 1) ||
          (r.predictedProb < 0.5 && r.actualOutcome === 0)
        ).length;

        // Compute rolling accuracy for sparkline (window of 10)
        const accHistory: number[] = [];
        const windowSize = Math.min(10, accuracyRecords.length);
        for (let i = windowSize; i <= accuracyRecords.length; i++) {
          const window = accuracyRecords.slice(i - windowSize, i);
          const correct = window.filter((r) =>
            (r.predictedProb >= 0.5 && r.actualOutcome === 1) ||
            (r.predictedProb < 0.5 && r.actualOutcome === 0)
          ).length;
          accHistory.push(correct / window.length);
        }

        setForecastAccuracy({
          bracketAccuracy: bracketCorrect / accuracyRecords.length,
          bracketCorrect,
          bracketTotal: accuracyRecords.length,
          avgSigmaUsed: 0,    // Would need signal reasoning data
          avgEnsembleStd: 0,  // Would need signal reasoning data
          avgActualError: 0,  // Would need weather forecast data
          accuracyHistory: accHistory,
        });
      }
    } catch {
      // Forecast accuracy is optional — don't crash if tables are missing
    }
  };

  useEffect(() => {
    loadData();

    const unsubs = [
      bus.on("bot:status", () => { loadData(); }),
      bus.on("balance:update", () => { loadData(); }),
      bus.on("position:update", () => { loadData(); }),
      bus.on("calibration:updated", () => { loadData(); }),
      bus.on("order:placed", () => { loadData(); }),
      bus.on("order:update", () => { loadData(); }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

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
                <Text bold color="cyan">Accuracy trend</Text>{" "}
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
