import Elysia, { t } from "elysia";
import { getDb, markets, signals, desc, eq, sql } from "@kcb/db";

export const marketRoutes = new Elysia({ prefix: "/api" })
  .get(
    "/markets",
    ({ query }) => {
      const db = getDb();
      const limit = Math.min(query.limit ?? 50, 200);
      const status = query.status ?? "open";

      const rows = db
        .select()
        .from(markets)
        .where(
          status === "all"
            ? undefined
            : eq(markets.status, status),
        )
        .orderBy(desc(markets.updatedAt))
        .limit(limit)
        .all();

      return rows.map((m) => ({
        ticker: m.ticker,
        eventTicker: m.eventTicker,
        seriesTicker: m.seriesTicker,
        title: m.title,
        category: m.category,
        stationId: m.stationId,
        targetDate: m.targetDate,
        bracketLow: m.bracketLow,
        bracketHigh: m.bracketHigh,
        marketType: m.marketType,
        status: m.status,
        closeTime: m.closeTime,
        result: m.result,
        lastYesPrice: m.lastYesPrice,
        lastNoPrice: m.lastNoPrice,
        discoveredAt: m.discoveredAt,
        updatedAt: m.updatedAt,
      }));
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric()),
        status: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/markets/:ticker",
    ({ params }) => {
      const db = getDb();
      const [market] = db
        .select()
        .from(markets)
        .where(eq(markets.ticker, params.ticker))
        .limit(1)
        .all();

      if (!market) {
        return new Response("Market not found", { status: 404 });
      }

      // Get latest signal for this market
      const [latestSignal] = db
        .select()
        .from(signals)
        .where(eq(signals.ticker, params.ticker))
        .orderBy(desc(signals.createdAt))
        .limit(1)
        .all();

      return {
        ...market,
        latestSignal: latestSignal
          ? {
              id: latestSignal.id,
              estimatedProb: latestSignal.estimatedProb,
              confidence: latestSignal.confidence,
              marketPrice: latestSignal.marketPrice,
              edge: latestSignal.edge,
              recommendation: latestSignal.recommendation,
              side: latestSignal.side,
              kellyFraction: latestSignal.kellyFraction,
              ensembleSize: latestSignal.ensembleSize,
              reasoning: latestSignal.reasoning,
              createdAt: latestSignal.createdAt,
            }
          : null,
      };
    },
    {
      params: t.Object({
        ticker: t.String(),
      }),
    },
  );
