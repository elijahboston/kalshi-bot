import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
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
  renderPortfolioChart,
  renderBucketChart,
  renderDailyPnl,
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

      {/* Portfolio Curve */}
      <Text bold color="cyan">{"─── Portfolio (" + (portfolioHistory.length >= 2
        ? formatDuration(
            new Date(portfolioHistory[portfolioHistory.length - 1]!.recordedAt).getTime() -
            new Date(portfolioHistory[0]!.recordedAt).getTime()
          )
        : portfolioHistory.length + " snapshots") + ") " + "─".repeat(40)}</Text>
      <Box marginBottom={1}>
        <Text color="green">{renderPortfolioChart(portfolioHistory, 60, 8)}</Text>
      </Box>

      {/* Calibration Buckets */}
      <Text bold color="cyan">{"─── Calibration Buckets " + "─".repeat(56)}</Text>
      <Box marginBottom={1}>
        <Text>{renderBucketChart(bucketStats)}</Text>
      </Box>

      {/* P&L by Day */}
      <Text bold color="cyan">{"─── P&L by Day " + "─".repeat(65)}</Text>
      <Box marginBottom={1}>
        <Text>{renderDailyPnl(dailyPnl)}</Text>
      </Box>

      {/* Recent Resolutions */}
      <Text bold color="cyan">{"─── Recent Resolutions " + "─".repeat(57)}</Text>
      <Box gap={1}>
        <Box width={28}><Text bold color="gray">TICKER</Text></Box>
        <Box width={10}><Text bold color="gray">PREDICTED</Text></Box>
        <Box width={8}><Text bold color="gray">ACTUAL</Text></Box>
        <Box width={8}><Text bold color="gray">EDGE</Text></Box>
        <Box width={10}><Text bold color="gray">PnL</Text></Box>
      </Box>
      {resolutions.length === 0 ? (
        <Text color="gray">No resolved trades yet.</Text>
      ) : (
        resolutions.map((r, i) => {
          const pnlColor = r.realizedPnl != null && r.realizedPnl > 0 ? "green" : r.realizedPnl != null && r.realizedPnl < 0 ? "red" : "gray";
          return (
            <Box key={`${r.ticker}-${i}`} gap={1}>
              <Box width={28}><Text>{r.ticker}</Text></Box>
              <Box width={10}>
                <Text>{(r.predictedProb * 100).toFixed(0)}%</Text>
              </Box>
              <Box width={8}>
                <Text>{r.actualOutcome === 1 ? "YES" : "NO"}</Text>
              </Box>
              <Box width={8}>
                <Text color={r.edge > 0 ? "green" : "red"}>
                  {r.edge > 0 ? "+" : ""}{(r.edge * 100).toFixed(1)}
                </Text>
              </Box>
              <Box width={10}>
                <Text color={pnlColor}>
                  {r.realizedPnl != null
                    ? `${r.realizedPnl > 0 ? "+" : ""}$${(r.realizedPnl / 100).toFixed(2)}`
                    : "—"}
                </Text>
              </Box>
            </Box>
          );
        })
      )}

      <Box marginTop={1} />

      {/* Order History (compact) */}
      <Text bold color="cyan">{"─── Order History (" + orderRows.length + ") " + "─".repeat(57)}</Text>
      <Box gap={1}>
        <Box width={10}><Text bold color="gray">TIME</Text></Box>
        <Box width={28}><Text bold color="gray">TICKER</Text></Box>
        <Box width={6}><Text bold color="gray">SIDE</Text></Box>
        <Box width={5}><Text bold color="gray">QTY</Text></Box>
        <Box width={7}><Text bold color="gray">PRICE</Text></Box>
        <Box width={9}><Text bold color="gray">STATUS</Text></Box>
        <Box width={7}><Text bold color="gray">KELLY</Text></Box>
        <Box width={5}><Text bold color="gray">DRY</Text></Box>
      </Box>
      {orderRows.length === 0 ? (
        <Text color="gray">No orders yet.</Text>
      ) : (
        orderRows.map((o, i) => {
          const statusColor =
            o.status === "filled" ? "green" :
            o.status === "open" ? "yellow" :
            "gray";
          return (
            <Box key={`${o.createdAt}-${i}`} gap={1}>
              <Box width={10}>
                <Text color="gray">{o.createdAt.slice(11, 19)}</Text>
              </Box>
              <Box width={28}>
                <Text>{o.ticker}</Text>
              </Box>
              <Box width={6}>
                <Text>{o.side.toUpperCase()}</Text>
              </Box>
              <Box width={5}>
                <Text>{o.quantity}</Text>
              </Box>
              <Box width={7}>
                <Text>{o.limitPrice}¢</Text>
              </Box>
              <Box width={9}>
                <Text color={statusColor}>{o.status}</Text>
              </Box>
              <Box width={7}>
                <Text>{o.kellyFraction != null ? o.kellyFraction.toFixed(2) : "—"}</Text>
              </Box>
              <Box width={5}>
                {o.dryRun ? <Text color="yellow">DRY</Text> : <Text color="gray">—</Text>}
              </Box>
            </Box>
          );
        })
      )}
    </Box>
  );
}
