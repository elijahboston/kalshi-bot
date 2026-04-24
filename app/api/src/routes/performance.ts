import Elysia, { t } from "elysia";
import {
  getDb,
  positions,
  orders,
  calibration,
  balanceHistory,
  desc,
  eq,
  sql,
  count,
  avg,
  sum,
} from "@kcb/db";
import type { SQL } from "drizzle-orm";

/**
 * Calibration rows don't carry a dry_run flag themselves — they inherit their
 * mode from the bot orders for the same ticker. A calibration is "paper" when
 * there's a dry_run=1 bot order for the ticker; "live" when there's a dry_run=0
 * bot order. This matches the operational invariant that a given market's
 * positions are all paper or all live at any point in time.
 */
function calibrationDryRunFilter(raw: string | undefined): SQL | null {
  if (raw == null || raw === "all") return null;
  if (raw === "true" || raw === "1") {
    return sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.ticker} = ${calibration.ticker} AND ${orders.signalId} IS NOT NULL AND ${orders.dryRun} = 1)`;
  }
  if (raw === "false" || raw === "0") {
    return sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.ticker} = ${calibration.ticker} AND ${orders.signalId} IS NOT NULL AND ${orders.dryRun} = 0)`;
  }
  return null;
}

function balanceHistoryDryRunFilter(raw: string | undefined): SQL | null {
  if (raw == null || raw === "all") return null;
  if (raw === "true" || raw === "1") return eq(balanceHistory.dryRun, true);
  if (raw === "false" || raw === "0") return eq(balanceHistory.dryRun, false);
  return null;
}

export const performanceRoutes = new Elysia({ prefix: "/api/performance" })
  .get(
    "/",
    ({ query }) => {
      const db = getDb();

      // Open positions + unrealized PnL
      const openPos = db.select().from(positions).all();
      const unrealizedPnl = openPos.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);

      // Balance — prefer mode-scoped latest when filter is set.
      const balFilter = balanceHistoryDryRunFilter(query.dryRun);
      const balBase = db.select().from(balanceHistory);
      const balRows = (balFilter ? balBase.where(balFilter) : balBase)
        .orderBy(desc(balanceHistory.recordedAt))
        .limit(1)
        .all();
      const latestBal = balRows[0];

      // Calibration aggregates (settled traded markets)
      const calFilter = calibrationDryRunFilter(query.dryRun);
      const calWhere = calFilter
        ? sql`${calibration.traded} = 1 AND (${calFilter})`
        : sql`${calibration.traded} = 1`;
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
        .where(calWhere)
        .all();

      const settledCount = Number(calAgg?.settledCount ?? 0);
      const wins = Number(calAgg?.wins ?? 0);

      // Order count — direct dry_run filter on orders.
      const orderFilter = query.dryRun === "true" || query.dryRun === "1"
        ? sql`${orders.dryRun} = 1`
        : query.dryRun === "false" || query.dryRun === "0"
        ? sql`${orders.dryRun} = 0`
        : null;
      const orderBase = db.select({ value: count() }).from(orders);
      const orderRow = orderFilter
        ? orderBase.where(orderFilter).all()
        : orderBase.all();
      const orderCount = orderRow[0]?.value ?? 0;

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
    },
    {
      query: t.Object({
        dryRun: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/daily-pnl",
    ({ query }) => {
      const db = getDb();
      const days = query.days ?? 7;
      const calFilter = calibrationDryRunFilter(query.dryRun);
      const where = calFilter
        ? sql`${calibration.traded} = 1 AND (${calFilter})`
        : sql`${calibration.traded} = 1`;

      return db
        .select({
          date: sql<string>`date(${calibration.resolvedAt})`.as("day"),
          pnl: sql<number>`COALESCE(SUM(${calibration.realizedPnl}), 0)`.as("pnl"),
        })
        .from(calibration)
        .where(where)
        .groupBy(sql`date(${calibration.resolvedAt})`)
        .orderBy(sql`date(${calibration.resolvedAt}) DESC`)
        .limit(days)
        .all()
        .reverse();
    },
    {
      query: t.Object({
        days: t.Optional(t.Numeric()),
        dryRun: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/daily-win-rates",
    ({ query }) => {
      const db = getDb();
      const days = query.days ?? 84;
      const calFilter = calibrationDryRunFilter(query.dryRun);
      const where = calFilter
        ? sql`${calibration.traded} = 1 AND (${calFilter})`
        : sql`${calibration.traded} = 1`;

      return db
        .select({
          date: sql<string>`date(${calibration.resolvedAt})`.as("day"),
          total: count(),
          wins: sql<number>`SUM(CASE WHEN ${calibration.realizedPnl} > 0 THEN 1 ELSE 0 END)`,
        })
        .from(calibration)
        .where(where)
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
        dryRun: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/win-rates",
    ({ query }) => {
      const db = getDb();
      const windows = [
        { label: "24h", hours: 24 },
        { label: "48h", hours: 48 },
        { label: "7d", hours: 168 },
      ];
      const calFilter = calibrationDryRunFilter(query.dryRun);

      return windows.map(({ label, hours }) => {
        const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
        const base = sql`${calibration.traded} = 1 AND ${calibration.resolvedAt} >= ${cutoff}`;
        const where = calFilter ? sql`${base} AND (${calFilter})` : base;
        const [row] = db
          .select({
            total: count(),
            wins: sql<number>`SUM(CASE WHEN ${calibration.realizedPnl} > 0 THEN 1 ELSE 0 END)`,
          })
          .from(calibration)
          .where(where)
          .all();

        const total = Number(row?.total ?? 0);
        const w = Number(row?.wins ?? 0);
        return { label, wins: w, total, rate: total > 0 ? w / total : 0 };
      });
    },
    {
      query: t.Object({
        dryRun: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/calibration",
    ({ query }) => {
      const db = getDb();
      const buckets = [
        { label: "0.0-0.1", low: 0.0, high: 0.1 },
        { label: "0.1-0.2", low: 0.1, high: 0.2 },
        { label: "0.2-0.3", low: 0.2, high: 0.3 },
        { label: "0.3-0.5", low: 0.3, high: 0.5 },
        { label: "0.5-0.7", low: 0.5, high: 0.7 },
        { label: "0.7-1.0", low: 0.7, high: 1.0 },
      ];
      const calFilter = calibrationDryRunFilter(query.dryRun);

      return buckets.map(({ label, low, high }) => {
        const base = sql`${calibration.predictedProb} >= ${low} AND ${calibration.predictedProb} < ${high}`;
        const where = calFilter ? sql`${base} AND (${calFilter})` : base;
        const [row] = db
          .select({
            total: count(),
            actualRate: avg(calibration.actualOutcome),
            avgPredicted: avg(calibration.predictedProb),
          })
          .from(calibration)
          .where(where)
          .all();

        return {
          bucket: label,
          total: Number(row?.total ?? 0),
          actualRate: Number(row?.actualRate ?? 0),
          avgPredicted: Number(row?.avgPredicted ?? 0),
        };
      });
    },
    {
      query: t.Object({
        dryRun: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/resolutions",
    ({ query }) => {
      const db = getDb();
      const limit = Math.min(query.limit ?? 10, 100);
      const calFilter = calibrationDryRunFilter(query.dryRun);
      const where = calFilter
        ? sql`${calibration.traded} = 1 AND (${calFilter})`
        : sql`${calibration.traded} = 1`;

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
        .where(where)
        .orderBy(desc(calibration.resolvedAt))
        .limit(limit)
        .all();
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric()),
        dryRun: t.Optional(t.String()),
      }),
    },
  );
