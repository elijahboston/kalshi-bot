import Elysia, { t } from "elysia";
import { getDb, positions, balanceHistory, desc } from "@kcb/db";

export const positionRoutes = new Elysia({ prefix: "/api" })
  .get("/positions", () => {
    const db = getDb();
    return db.select().from(positions).all();
  })
  .get("/balance", () => {
    const db = getDb();
    const [latest] = db
      .select()
      .from(balanceHistory)
      .orderBy(desc(balanceHistory.recordedAt))
      .limit(1)
      .all();

    if (!latest) return { cash: 0, portfolio: 0 };
    return { cash: latest.balance, portfolio: latest.totalEquity };
  })
  .get(
    "/balance/history",
    ({ query }) => {
      const db = getDb();
      const limit = Math.min(query.limit ?? 200, 1000);

      const all = db
        .select({
          totalEquity: balanceHistory.totalEquity,
          balance: balanceHistory.balance,
          openPositions: balanceHistory.openPositions,
          recordedAt: balanceHistory.recordedAt,
        })
        .from(balanceHistory)
        .orderBy(balanceHistory.recordedAt)
        .all();

      // Downsample to requested limit
      const step = Math.max(1, Math.floor(all.length / limit));
      return all.filter((_, i) => i % step === 0 || i === all.length - 1);
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric()),
      }),
    },
  );
