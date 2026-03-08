import { getDb, orders, positions, balanceHistory, calibration, desc, eq, sql, count, avg, sum } from "@kcb/db";
import type { SnapshotData, StationInfo, PerformanceData } from "./frontend/lib/types";

/** Station coordinates — mirrors app/data/services/ensemble.ts */
const STATION_COORDS: Record<string, { lat: number; lon: number }> = {
  KNYC: { lat: 40.7789, lon: -73.9692 },
  KORD: { lat: 41.9742, lon: -87.9073 },
  KLAX: { lat: 33.9425, lon: -118.4081 },
  KDFW: { lat: 32.8998, lon: -97.0403 },
  KIAH: { lat: 29.9844, lon: -95.3414 },
  KDEN: { lat: 39.8561, lon: -104.6737 },
  KPHL: { lat: 39.8719, lon: -75.2411 },
  KATL: { lat: 33.6407, lon: -84.4277 },
  KSFO: { lat: 37.6213, lon: -122.379 },
  KMIA: { lat: 25.7959, lon: -80.287 },
  KAUS: { lat: 30.1945, lon: -97.6699 },
};

/** Reverse map: ICAO → Kalshi city suffix for ticker matching */
const ICAO_TO_SUFFIX: Record<string, string> = {
  KNYC: "NY", KORD: "CHI", KLAX: "LAX", KDFW: "DFW", KIAH: "IAH",
  KDEN: "DEN", KPHL: "PHL", KATL: "ATL", KSFO: "SFO", KMIA: "MIA",
  KAUS: "AUS",
};

function tickerMatchesStation(ticker: string, stationId: string): boolean {
  const suffix = ICAO_TO_SUFFIX[stationId];
  if (!suffix) return false;
  // Tickers like KXHIGHNY-25FEB19-B37 contain the suffix after the prefix
  return new RegExp(`^KX(?:HIGH|LOW|RAIN|SNOW)${suffix}(?:-|$)`).test(ticker);
}

export function getStations(): StationInfo[] {
  const db = getDb();
  const openPositions = db.select().from(positions).all();

  return Object.entries(STATION_COORDS).map(([id, coords]) => {
    const activeMarkets = openPositions.filter((p) =>
      tickerMatchesStation(p.ticker, id)
    ).length;
    return { id, lat: coords.lat, lon: coords.lon, activeMarkets };
  });
}

export function getPositions() {
  const db = getDb();
  return db.select().from(positions).all();
}

export function getBalance() {
  const db = getDb();
  const rows = db
    .select()
    .from(balanceHistory)
    .orderBy(desc(balanceHistory.recordedAt))
    .limit(1)
    .all();
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return { cash: row.balance, portfolio: row.totalEquity };
}

export function getRecentOrders() {
  const db = getDb();
  return db
    .select()
    .from(orders)
    .orderBy(desc(orders.createdAt))
    .limit(20)
    .all();
}

export function getSnapshot(): SnapshotData {
  const pos = getPositions().map((p) => ({
    ticker: p.ticker,
    side: p.side,
    quantity: p.quantity,
    avgEntryPrice: p.avgEntryPrice,
    unrealizedPnl: p.unrealizedPnl,
  }));

  return {
    positions: pos,
    balance: getBalance(),
    stations: getStations(),
    recentOrders: getRecentOrders().map((o) => ({
      orderId: o.orderId,
      ticker: o.ticker,
      action: o.action,
      side: o.side,
      limitPrice: o.limitPrice,
      filledQuantity: o.filledQuantity,
      status: o.status,
      createdAt: o.createdAt,
    })),
  };
}

export function getPerformance(): PerformanceData {
  const db = getDb();

  // Open positions + unrealized PnL
  const openPos = db.select().from(positions).all();
  const unrealizedPnl = openPos.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);

  // Calibration aggregates (settled traded markets)
  const calAgg = db
    .select({
      avgBrier: avg(
        sql`(${calibration.predictedProb} - ${calibration.actualOutcome}) * (${calibration.predictedProb} - ${calibration.actualOutcome})`
      ),
      settledCount: count(),
      totalPnl: sum(calibration.realizedPnl),
      wins: count(sql`CASE WHEN ${calibration.realizedPnl} > 0 THEN 1 END`),
    })
    .from(calibration)
    .where(sql`${calibration.traded} = 1`)
    .all();

  const settledCount = Number(calAgg[0]?.settledCount ?? 0);
  const wins = Number(calAgg[0]?.wins ?? 0);

  // Windowed win rates (24h, 48h, 7d)
  const windowedWinRates = [24, 48, 168].map((hours) => {
    const label = hours <= 48 ? `${hours}h` : `${hours / 24}d`;
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    const rows = db
      .select({
        total: count(),
        wins: sql<number>`SUM(CASE WHEN ${calibration.realizedPnl} > 0 THEN 1 ELSE 0 END)`,
      })
      .from(calibration)
      .where(sql`${calibration.traded} = 1 AND ${calibration.resolvedAt} >= ${cutoff}`)
      .all();
    const total = Number(rows[0]?.total ?? 0);
    const w = Number(rows[0]?.wins ?? 0);
    return { label, wins: w, total, rate: total > 0 ? w / total : 0 };
  });

  // Equity history (downsampled to ~200 points)
  const allEquity = db
    .select({ totalEquity: balanceHistory.totalEquity, recordedAt: balanceHistory.recordedAt })
    .from(balanceHistory)
    .orderBy(balanceHistory.recordedAt)
    .all();

  const step = Math.max(1, Math.floor(allEquity.length / 200));
  const sampled = allEquity.filter((_, i) => i % step === 0 || i === allEquity.length - 1);

  // Cap outlier equity values (e.g. from the over-sell bug) at p95 * 1.5
  const sortedVals = sampled.map((r) => r.totalEquity).sort((a, b) => a - b);
  const p95 = sortedVals[Math.floor(sortedVals.length * 0.95)] ?? Infinity;
  const cap = Math.round(p95 * 1.5);

  const equityHistory = sampled.map((r) => ({
    value: Math.min(r.totalEquity, cap),
    time: r.recordedAt,
  }));

  // Daily PnL (last 7 days)
  const dailyPnl = db
    .select({
      day: sql<string>`date(${calibration.resolvedAt})`.as("day"),
      pnl: sql<number>`COALESCE(SUM(${calibration.realizedPnl}), 0)`.as("pnl"),
    })
    .from(calibration)
    .where(sql`${calibration.traded} = 1`)
    .groupBy(sql`date(${calibration.resolvedAt})`)
    .orderBy(sql`date(${calibration.resolvedAt}) DESC`)
    .limit(7)
    .all()
    .map((r) => ({ date: r.day, pnl: Number(r.pnl) }))
    .reverse();

  // Recent resolutions
  const resolutions = db
    .select({
      ticker: calibration.ticker,
      predictedProb: calibration.predictedProb,
      actualOutcome: calibration.actualOutcome,
      edge: calibration.edge,
      realizedPnl: calibration.realizedPnl,
    })
    .from(calibration)
    .where(sql`${calibration.traded} = 1`)
    .orderBy(desc(calibration.resolvedAt))
    .limit(10)
    .all();

  const bal = getBalance();

  return {
    cash: bal?.cash ?? 0,
    portfolio: bal?.portfolio ?? 0,
    unrealizedPnl,
    realizedPnl: Number(calAgg[0]?.totalPnl ?? 0),
    winRate: settledCount > 0 ? wins / settledCount : 0,
    brierScore: Number(calAgg[0]?.avgBrier ?? 0),
    orderCount: db.select({ value: count() }).from(orders).all()[0]?.value ?? 0,
    positionCount: openPos.length,
    windowedWinRates,
    equityHistory,
    dailyPnl,
    resolutions,
  };
}

/** Handle REST API requests */
export function handleApiRequest(req: Request): Response | null {
  const url = new URL(req.url);

  switch (url.pathname) {
    case "/api/stations":
      return Response.json(getStations());
    case "/api/positions":
      return Response.json(getPositions());
    case "/api/balance":
      return Response.json(getBalance());
    case "/api/orders/recent":
      return Response.json(getRecentOrders());
    case "/api/performance":
      return Response.json(getPerformance());
    default:
      return null;
  }
}
