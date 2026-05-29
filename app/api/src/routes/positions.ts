import Elysia, { t } from "elysia";
import { getDb, positions, balanceHistory, desc, eq, gte, and } from "@kcb/db";
import type { SQL } from "drizzle-orm";

type DryRunCol = typeof balanceHistory.dryRun | typeof positions.dryRun;

function dryRunFilter(raw: string | undefined, col: DryRunCol): SQL | null {
  if (raw == null || raw === "all") return null;
  if (raw === "true" || raw === "1") return eq(col, true);
  if (raw === "false" || raw === "0") return eq(col, false);
  return null;
}

function spanFilter(span: string | undefined): SQL | null {
  if (span == null || span === "all") return null;
  const days = span === "7d" ? 7 : span === "30d" ? 30 : null;
  if (days == null) return null;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return gte(balanceHistory.recordedAt, cutoff);
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

      const filters = [
        dryRunFilter(query.dryRun, balanceHistory.dryRun),
        spanFilter(query.span),
      ].filter((f): f is SQL => f != null);

      const base = db
        .select({
          totalEquity: balanceHistory.totalEquity,
          balance: balanceHistory.balance,
          openPositions: balanceHistory.openPositions,
          recordedAt: balanceHistory.recordedAt,
          dryRun: balanceHistory.dryRun,
        })
        .from(balanceHistory);

      const where =
        filters.length === 0
          ? null
          : filters.length === 1
            ? filters[0]
            : and(...filters)!;

      const all = (where ? base.where(where) : base)
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
        span: t.Optional(
          t.Union([t.Literal("7d"), t.Literal("30d"), t.Literal("all")]),
        ),
      }),
    },
  );
