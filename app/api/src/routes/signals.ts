import Elysia, { t } from "elysia";
import { getDb, signals, desc, eq, sql } from "@kcb/db";

export const signalRoutes = new Elysia({ prefix: "/api" })
  .get(
    "/signals",
    ({ query }) => {
      const db = getDb();
      const limit = Math.min(query.limit ?? 20, 200);

      if (query.actionable === "true") {
        return db
          .select()
          .from(signals)
          .where(sql`${signals.acted} = 1`)
          .orderBy(desc(signals.createdAt))
          .limit(limit)
          .all();
      }

      return db
        .select()
        .from(signals)
        .orderBy(desc(signals.createdAt))
        .limit(limit)
        .all();
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric()),
        actionable: t.Optional(t.String()),
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
