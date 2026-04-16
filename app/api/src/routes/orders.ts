import Elysia, { t } from "elysia";
import { getDb, orders, trades, desc, eq } from "@kcb/db";

export const orderRoutes = new Elysia({ prefix: "/api" })
  .get(
    "/orders",
    ({ query }) => {
      const db = getDb();
      const limit = Math.min(query.limit ?? 20, 200);

      if (query.status) {
        return db
          .select()
          .from(orders)
          .where(eq(orders.status, query.status))
          .orderBy(desc(orders.createdAt))
          .limit(limit)
          .all();
      }

      return db
        .select()
        .from(orders)
        .orderBy(desc(orders.createdAt))
        .limit(limit)
        .all();
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric()),
        status: t.Optional(t.String()),
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
