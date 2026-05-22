import Elysia, { t } from "elysia";
import { getDb, signals, desc, eq, sql, and } from "@kcb/db";
import type { SQL } from "drizzle-orm";

/**
 * Parse `?dryRun=true|false|all` query param.
 * Returns a filter fragment or null when no filter should apply.
 */
function dryRunFilter(raw: string | undefined, col: typeof signals.dryRun): SQL | null {
  if (raw == null || raw === "all") return null;
  if (raw === "true" || raw === "1") return eq(col, true);
  if (raw === "false" || raw === "0") return eq(col, false);
  return null;
}

export const signalRoutes = new Elysia({ prefix: "/api" })
  .get(
    "/signals",
    ({ query }) => {
      const db = getDb();
      const limit = Math.min(query.limit ?? 20, 200);

      const filters: SQL[] = [];
      if (query.actionable === "true") filters.push(sql`${signals.acted} = 1`);
      const dryFilter = dryRunFilter(query.dryRun, signals.dryRun);
      if (dryFilter) filters.push(dryFilter);

      const whereClause = filters.length === 0
        ? undefined
        : filters.length === 1
        ? filters[0]
        : and(...filters);

      const baseQuery = db.select().from(signals);
      const withWhere = whereClause ? baseQuery.where(whereClause) : baseQuery;

      return withWhere
        .orderBy(desc(signals.createdAt))
        .limit(limit)
        .all();
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric()),
        actionable: t.Optional(t.String()),
        dryRun: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/signals/:id",
    ({ params }) => {
      const db = getDb();
      const [signal] = db
        .select()
        .from(signals)
        .where(eq(signals.id, params.id))
        .limit(1)
        .all();

      if (!signal) {
        return new Response("Signal not found", { status: 404 });
      }

      return {
        ...signal,
        reasoning: signal.reasoning ? JSON.parse(signal.reasoning) : null,
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    },
  );
