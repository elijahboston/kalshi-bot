import { getDb, orders, positions, balanceHistory, desc, eq } from "@kcb/db";
import type { SnapshotData, StationInfo } from "./frontend/lib/types";

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
    default:
      return null;
  }
}
