import Elysia, { t } from "elysia";
import { getDb, orders, trades, desc, eq, and } from "@kcb/db";
import type { SQL } from "drizzle-orm";

function dryRunFilter(raw: string | undefined, col: typeof orders.dryRun): SQL | null {
  if (raw == null || raw === "all") return null;
  if (raw === "true" || raw === "1") return eq(col, true);
  if (raw === "false" || raw === "0") return eq(col, false);
  return null;
}

export const orderRoutes = new Elysia({ prefix: "/api" })
  .get(
    "/orders",
    ({ query }) => {
      const db = getDb();
      const limit = Math.min(query.limit ?? 20, 200);

      const filters: SQL[] = [];
      if (query.status) filters.push(eq(orders.status, query.status));
      const dryFilter = dryRunFilter(query.dryRun, orders.dryRun);
      if (dryFilter) filters.push(dryFilter);

      const whereClause = filters.length === 0
        ? undefined
        : filters.length === 1
        ? filters[0]
        : and(...filters);

      const baseQuery = db.select().from(orders);
      const withWhere = whereClause ? baseQuery.where(whereClause) : baseQuery;

      return withWhere
        .orderBy(desc(orders.createdAt))
        .limit(limit)
        .all();
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric()),
        status: t.Optional(t.String()),
        dryRun: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/trades",
    ({ query }) => {
      const db = getDb();
      const limit = Math.min(query.limit ?? 20, 200);

      return db
        .select()
        .from(trades)
        .orderBy(desc(trades.filledAt))
        .limit(limit)
        .all();
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric()),
      }),
    },
  );
