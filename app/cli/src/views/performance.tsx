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

interface Stats {
  balance: number;
  totalEquity: number;
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

const SPARKLINE_CHARS = "▁▂▃▄▅▆▇█";

function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (SPARKLINE_CHARS.length - 1));
      return SPARKLINE_CHARS[idx];
    })
    .join("");
}

export function PerformanceView() {
  const [stats, setStats] = useState<Stats>({
    balance: 0,
    totalEquity: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
    winRate: 0,
    brierScore: 0,
    orderCount: 0,
    positionCount: 0,
  });
  const [orderRows, setOrderRows] = useState<OrderRow[]>([]);
  const [equityHistory, setEquityHistory] = useState<number[]>([]);
  const [equityMin, setEquityMin] = useState(0);
  const [equityMax, setEquityMax] = useState(0);
  const [equityCurrent, setEquityCurrent] = useState(0);
  const [resolutions, setResolutions] = useState<Resolution[]>([]);

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
      balance: latestBalance[0]?.balance ?? 0,
      totalEquity: latestBalance[0]?.totalEquity ?? 0,
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

    // Load equity history for sparkline
    const eqHistory = await db
      .select({
        totalEquity: balanceHistory.totalEquity,
      })
      .from(balanceHistory)
      .orderBy(desc(balanceHistory.recordedAt))
      .limit(20);

    const values = eqHistory.map((r) => r.totalEquity).reverse();
    setEquityHistory(values);
    if (values.length > 0) {
      setEquityMin(Math.min(...values));
      setEquityMax(Math.max(...values));
      setEquityCurrent(values[values.length - 1]!);
    }

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
      {/* Stats Bar */}
      <Box gap={2} marginBottom={1}>
        <Text>
          <Text bold color="cyan">Bal</Text>{" "}
          <Text>${(stats.balance / 100).toFixed(2)}</Text>
        </Text>
        <Text>
          <Text bold color="cyan">Eq</Text>{" "}
          <Text>${(stats.totalEquity / 100).toFixed(2)}</Text>
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
        <Text>
          <Text bold color="cyan">Win</Text>{" "}
          <Text>{(stats.winRate * 100).toFixed(0)}%</Text>
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

      <Text color="gray">{"─".repeat(80)}</Text>

      {/* Order History */}
      <Text bold color="cyan">Order History ({orderRows.length})</Text>
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

      <Text color="gray">{"─".repeat(80)}</Text>

      {/* Equity Curve */}
      <Box gap={2}>
        <Text bold color="cyan">Equity</Text>
        {equityHistory.length > 0 ? (
          <>
            <Text color="green">{sparkline(equityHistory)}</Text>
            <Text color="gray">
              min ${(equityMin / 100).toFixed(2)} │ max ${(equityMax / 100).toFixed(2)} │ now ${(equityCurrent / 100).toFixed(2)}
            </Text>
          </>
        ) : (
          <Text color="gray">No equity data yet.</Text>
        )}
      </Box>

      <Text color="gray">{"─".repeat(80)}</Text>

      {/* Recent Resolutions */}
      <Text bold color="cyan">Recent Resolutions</Text>
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
    </Box>
  );
}
