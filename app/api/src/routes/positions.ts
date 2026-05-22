import Elysia, { t } from "elysia";
import { getDb, positions, balanceHistory, desc, eq } from "@kcb/db";
import type { SQL } from "drizzle-orm";

type DryRunCol = typeof balanceHistory.dryRun | typeof positions.dryRun;

function dryRunFilter(raw: string | undefined, col: DryRunCol): SQL | null {
  if (raw == null || raw === "all") return null;
  if (raw === "true" || raw === "1") return eq(col, true);
  if (raw === "false" || raw === "0") return eq(col, false);
  return null;
}

export const positionRoutes = new Elysia({ prefix: "/api" })
  .get(
    "/positions",
    ({ query }) => {
      const db = getDb();
      const dryFilter = dryRunFilter(query.dryRun, positions.dryRun);
      const base = db.select().from(positions);
      return (dryFilter ? base.where(dryFilter) : base).all();
    },
    {
      query: t.Object({
        dryRun: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/balance",
    ({ query }) => {
      const db = getDb();
      const dryFilter = dryRunFilter(query.dryRun, balanceHistory.dryRun);
      const base = db.select().from(balanceHistory);
      const withWhere = dryFilter ? base.where(dryFilter) : base;

      const [latest] = withWhere
        .orderBy(desc(balanceHistory.recordedAt))
        .limit(1)
        .all();

      if (!latest) return { cash: 0, portfolio: 0 };
      return { cash: latest.balance, portfolio: latest.totalEquity };
    },
    {
      query: t.Object({
        dryRun: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/balance/history",
    ({ query }) => {
      const db = getDb();
      const limit = Math.min(query.limit ?? 200, 1000);

      const dryFilter = dryRunFilter(query.dryRun, balanceHistory.dryRun);
      const base = db
        .select({
          totalEquity: balanceHistory.totalEquity,
          balance: balanceHistory.balance,
          openPositions: balanceHistory.openPositions,
          recordedAt: balanceHistory.recordedAt,
          dryRun: balanceHistory.dryRun,
        })
        .from(balanceHistory);

      const all = (dryFilter ? base.where(dryFilter) : base)
        .orderBy(balanceHistory.recordedAt)
        .all();

      // Downsample to requested limit
      const step = Math.max(1, Math.floor(all.length / limit));
      return all.filter((_, i) => i % step === 0 || i === all.length - 1);
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric()),
        dryRun: t.Optional(t.String()),
      }),
    },
  );
