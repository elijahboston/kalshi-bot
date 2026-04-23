import Elysia, { t } from "elysia";
import {
  getDb,
  positions,
  orders,
  calibration,
  balanceHistory,
  desc,
  sql,
  count,
  avg,
  sum,
} from "@kcb/db";

export const performanceRoutes = new Elysia({ prefix: "/api/performance" })
  .get("/", () => {
    const db = getDb();

    // Open positions + unrealized PnL
    const openPos = db.select().from(positions).all();
    const unrealizedPnl = openPos.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);

    // Balance
    const [latestBal] = db
      .select()
      .from(balanceHistory)
      .orderBy(desc(balanceHistory.recordedAt))
      .limit(1)
      .all();

    // Calibration aggregates (settled traded markets)
    const [calAgg] = db
      .select({
        avgBrier: avg(
          sql`(${calibration.predictedProb} - ${calibration.actualOutcome}) * (${calibration.predictedProb} - ${calibration.actualOutcome})`,
        ),
        settledCount: count(),
        totalPnl: sum(calibration.realizedPnl),
        wins: count(sql`CASE WHEN ${calibration.realizedPnl} > 0 THEN 1 END`),
      })
      .from(calibration)
      .where(sql`${calibration.traded} = 1`)
      .all();

    const settledCount = Number(calAgg?.settledCount ?? 0);
    const wins = Number(calAgg?.wins ?? 0);
    const orderCount = db.select({ value: count() }).from(orders).all()[0]?.value ?? 0;

    return {
      cash: latestBal?.balance ?? 0,
      portfolio: latestBal?.totalEquity ?? 0,
      unrealizedPnl,
      realizedPnl: Number(calAgg?.totalPnl ?? 0),
      winRate: settledCount > 0 ? wins / settledCount : 0,
      brierScore: Number(calAgg?.avgBrier ?? 0),
      orderCount,
      positionCount: openPos.length,
    };
  })
  .get(
    "/daily-pnl",
    ({ query }) => {
      const db = getDb();
      const days = query.days ?? 7;

      return db
        .select({
          date: sql<string>`date(${calibration.resolvedAt})`.as("day"),
          pnl: sql<number>`COALESCE(SUM(${calibration.realizedPnl}), 0)`.as("pnl"),
        })
        .from(calibration)
        .where(sql`${calibration.traded} = 1`)
        .groupBy(sql`date(${calibration.resolvedAt})`)
        .orderBy(sql`date(${calibration.resolvedAt}) DESC`)
        .limit(days)
        .all()
        .reverse();
    },
    {
      query: t.Object({
        days: t.Optional(t.Numeric()),
      }),
    },
  )
  .get(
    "/daily-win-rates",
    ({ query }) => {
      const db = getDb();
      const days = query.days ?? 84;

      return db
        .select({
          date: sql<string>`date(${calibration.resolvedAt})`.as("day"),
          total: count(),
          wins: sql<number>`SUM(CASE WHEN ${calibration.realizedPnl} > 0 THEN 1 ELSE 0 END)`,
        })
        .from(calibration)
        .where(sql`${calibration.traded} = 1`)
        .groupBy(sql`date(${calibration.resolvedAt})`)
        .orderBy(sql`date(${calibration.resolvedAt}) DESC`)
        .limit(days)
        .all()
        .map((r) => {
          const total = Number(r.total ?? 0);
          const wins = Number(r.wins ?? 0);
          return {
            date: r.date,
            total,
            wins,
            winRate: total > 0 ? wins / total : 0,
          };
        })
        .reverse();
    },
    {
      query: t.Object({
        days: t.Optional(t.Numeric()),
      }),
    },
  )
  .get("/win-rates", () => {
    const db = getDb();
    const windows = [
      { label: "24h", hours: 24 },
      { label: "48h", hours: 48 },
      { label: "7d", hours: 168 },
    ];

    return windows.map(({ label, hours }) => {
      const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
      const [row] = db
        .select({
          total: count(),
          wins: sql<number>`SUM(CASE WHEN ${calibration.realizedPnl} > 0 THEN 1 ELSE 0 END)`,
        })
        .from(calibration)
        .where(sql`${calibration.traded} = 1 AND ${calibration.resolvedAt} >= ${cutoff}`)
        .all();

      const total = Number(row?.total ?? 0);
      const w = Number(row?.wins ?? 0);
      return { label, wins: w, total, rate: total > 0 ? w / total : 0 };
    });
  })
  .get("/calibration", () => {
    const db = getDb();
    const buckets = [
      { label: "0.0-0.1", low: 0.0, high: 0.1 },
      { label: "0.1-0.2", low: 0.1, high: 0.2 },
      { label: "0.2-0.3", low: 0.2, high: 0.3 },
      { label: "0.3-0.5", low: 0.3, high: 0.5 },
      { label: "0.5-0.7", low: 0.5, high: 0.7 },
      { label: "0.7-1.0", low: 0.7, high: 1.0 },
    ];

    return buckets.map(({ label, low, high }) => {
      const [row] = db
        .select({
          total: count(),
          actualRate: avg(calibration.actualOutcome),
          avgPredicted: avg(calibration.predictedProb),
        })
        .from(calibration)
        .where(
          sql`${calibration.predictedProb} >= ${low} AND ${calibration.predictedProb} < ${high}`,
        )
        .all();

      return {
        bucket: label,
        total: Number(row?.total ?? 0),
        actualRate: Number(row?.actualRate ?? 0),
        avgPredicted: Number(row?.avgPredicted ?? 0),
      };
    });
  })
  .get(
    "/resolutions",
    ({ query }) => {
      const db = getDb();
      const limit = Math.min(query.limit ?? 10, 100);

      return db
        .select({
          ticker: calibration.ticker,
          category: calibration.category,
          predictedProb: calibration.predictedProb,
          actualOutcome: calibration.actualOutcome,
          marketPrice: calibration.marketPrice,
          edge: calibration.edge,
          realizedPnl: calibration.realizedPnl,
          traded: calibration.traded,
          resolvedAt: calibration.resolvedAt,
        })
        .from(calibration)
        .where(sql`${calibration.traded} = 1`)
        .orderBy(desc(calibration.resolvedAt))
        .limit(limit)
        .all();
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric()),
      }),
    },
  );
