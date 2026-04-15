import {
  getDb,
  orders,
  trades,
  positions,
  calibration,
  balanceHistory,
  desc,
  sql,
  count,
  avg,
  sum,
} from "@kcb/db";
import { getConfig } from "@kcb/config";
import { bus } from "@kcb/engine";
import { resolve, dirname, join } from "node:path";
import type { PortfolioPoint, BucketData, DailyPnlEntry } from "./charts";

const CACHE_VERSION = 1;
const DEBOUNCE_MS = 500;

// ─── Types ──────────────────────────────────────────────────

export interface Stats {
  cash: number;
  portfolio: number;
  unrealizedPnl: number;
  realizedPnl: number;
  winRate: number;
  brierScore: number;
  orderCount: number;
  positionCount: number;
}

export interface WindowedWinRate {
  label: string;
  wins: number;
  total: number;
  rate: number;
}

export interface OrderRow {
  createdAt: string;
  ticker: string;
  side: string;
  quantity: number;
  limitPrice: number;
  status: string;
  kellyFraction: number | null;
  dryRun: boolean;
}

export interface Resolution {
  ticker: string;
  predictedProb: number;
  actualOutcome: number;
  edge: number;
  realizedPnl: number | null;
}

export interface ForecastAccuracy {
  bracketAccuracy: number;
  bracketCorrect: number;
  bracketTotal: number;
  avgSigmaUsed: number;
  avgEnsembleStd: number;
  avgActualError: number;
  accuracyHistory: number[];
}

export interface CachedPerformanceData {
  version: number;
  updatedAt: string;
  stats: Stats;
  orderRows: OrderRow[];
  portfolioHistory: PortfolioPoint[];
  resolutions: Resolution[];
  bucketStats: BucketData[];
  dailyPnl: DailyPnlEntry[];
  windowedWinRates: WindowedWinRate[];
  forecastAccuracy: ForecastAccuracy | null;
}

// ─── Query helpers ──────────────────────────────────────────

const BUCKETS = [
  { label: "0.0-0.1", low: 0.0, high: 0.1 },
  { label: "0.1-0.2", low: 0.1, high: 0.2 },
  { label: "0.2-0.3", low: 0.2, high: 0.3 },
  { label: "0.3-0.5", low: 0.3, high: 0.5 },
  { label: "0.5-0.7", low: 0.5, high: 0.7 },
  { label: "0.7-1.0", low: 0.7, high: 1.0 },
] as const;

export async function queryWindowedWinRates(
  db: ReturnType<typeof getDb>,
): Promise<WindowedWinRate[]> {
  const windows = [
    { label: "24h", hours: 24 },
    { label: "48h", hours: 48 },
    { label: "7d", hours: 168 },
  ];

  const results: WindowedWinRate[] = [];
  for (const w of windows) {
    const cutoff = new Date(
      Date.now() - w.hours * 60 * 60 * 1000,
    ).toISOString();
    const rows = await db
      .select({
        total: count(),
        wins: sql<number>`SUM(CASE WHEN ${calibration.realizedPnl} > 0 THEN 1 ELSE 0 END)`,
      })
      .from(calibration)
      .where(
        sql`${calibration.traded} = 1 AND ${calibration.resolvedAt} >= ${cutoff}`,
      );

    const total = Number(rows[0]?.total ?? 0);
    const wins = Number(rows[0]?.wins ?? 0);
    results.push({ label: w.label, wins, total, rate: total > 0 ? wins / total : 0 });
  }

  return results;
}

async function computeAll(): Promise<CachedPerformanceData> {
  const db = getDb();

  const [
    latestBalance,
    openPositions,
    orderCount,
    tradeCount,
    calAgg,
    recentOrders,
    eqHistory,
    recentRes,
    calRecords,
    dailyRows,
    windowedRates,
  ] = await Promise.all([
    db
      .select()
      .from(balanceHistory)
      .orderBy(desc(balanceHistory.recordedAt))
      .limit(1),
    db.select().from(positions),
    db.select({ value: count() }).from(orders),
    db.select({ value: count() }).from(trades),
    db
      .select({
        avgBrier: avg(
          sql`(${calibration.predictedProb} - ${calibration.actualOutcome}) * (${calibration.predictedProb} - ${calibration.actualOutcome})`,
        ),
        settledCount: count(),
        totalPnl: sum(calibration.realizedPnl),
        wins: count(
          sql`CASE WHEN ${calibration.realizedPnl} > 0 THEN 1 END`,
        ),
      })
      .from(calibration)
      .where(sql`${calibration.traded} = 1`),
    db
      .select({
        createdAt: orders.createdAt,
        ticker: orders.ticker,
        side: orders.side,
        quantity: orders.quantity,
        limitPrice: orders.limitPrice,
        status: orders.status,
        kellyFraction: orders.kellyFraction,
        dryRun: orders.dryRun,
      })
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(20),
    db
      .select({
        totalEquity: balanceHistory.totalEquity,
        recordedAt: balanceHistory.recordedAt,
      })
      .from(balanceHistory)
      .orderBy(balanceHistory.recordedAt),
    db
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
      .limit(10),
    db
      .select({
        predictedProb: calibration.predictedProb,
        actualOutcome: calibration.actualOutcome,
      })
      .from(calibration),
    db
      .select({
        day: sql<string>`date(${calibration.resolvedAt})`.as("day"),
        pnl: sql<number>`COALESCE(SUM(${calibration.realizedPnl}), 0)`.as(
          "pnl",
        ),
      })
      .from(calibration)
      .where(sql`${calibration.traded} = 1`)
      .groupBy(sql`date(${calibration.resolvedAt})`)
      .orderBy(sql`date(${calibration.resolvedAt}) DESC`)
      .limit(7),
    queryWindowedWinRates(db),
  ]);

  const unrealizedPnl = openPositions.reduce(
    (s, p) => s + (p.unrealizedPnl ?? 0),
    0,
  );
  const settledCount = Number(calAgg[0]?.settledCount ?? 0);
  const wins = Number(calAgg[0]?.wins ?? 0);

  const stats: Stats = {
    cash: latestBalance[0]?.balance ?? 0,
    portfolio: latestBalance[0]?.totalEquity ?? 0,
    unrealizedPnl,
    realizedPnl: Number(calAgg[0]?.totalPnl ?? 0),
    winRate: settledCount > 0 ? wins / settledCount : 0,
    brierScore: Number(calAgg[0]?.avgBrier ?? 0),
    orderCount:
      Number(orderCount[0]?.value ?? 0) + Number(tradeCount[0]?.value ?? 0),
    positionCount: openPositions.length,
  };

  const bucketStats: BucketData[] = BUCKETS.map((bucket) => {
    const inBucket = calRecords.filter(
      (r) => r.predictedProb >= bucket.low && r.predictedProb < bucket.high,
    );
    return {
      label: bucket.label,
      hits: inBucket.filter((r) => r.actualOutcome === 1).length,
      total: inBucket.length,
    };
  });

  let forecastAccuracy: ForecastAccuracy | null = null;
  try {
    const cutoff30d = new Date(Date.now() - 30 * 86400_000).toISOString();
    const accuracyRecords = await db
      .select({
        predictedProb: calibration.predictedProb,
        actualOutcome: calibration.actualOutcome,
      })
      .from(calibration)
      .where(sql`${calibration.resolvedAt} >= ${cutoff30d}`);

    if (accuracyRecords.length > 0) {
      const bracketCorrect = accuracyRecords.filter(
        (r) =>
          (r.predictedProb >= 0.5 && r.actualOutcome === 1) ||
          (r.predictedProb < 0.5 && r.actualOutcome === 0),
      ).length;

      const accHistory: number[] = [];
      const windowSize = Math.min(10, accuracyRecords.length);
      for (let i = windowSize; i <= accuracyRecords.length; i++) {
        const window = accuracyRecords.slice(i - windowSize, i);
        const correct = window.filter(
          (r) =>
            (r.predictedProb >= 0.5 && r.actualOutcome === 1) ||
            (r.predictedProb < 0.5 && r.actualOutcome === 0),
        ).length;
        accHistory.push(correct / window.length);
      }

      forecastAccuracy = {
        bracketAccuracy: bracketCorrect / accuracyRecords.length,
        bracketCorrect,
        bracketTotal: accuracyRecords.length,
        avgSigmaUsed: 0,
        avgEnsembleStd: 0,
        avgActualError: 0,
        accuracyHistory: accHistory,
      };
    }
  } catch {
    // Forecast accuracy is optional
  }

  return {
    version: CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    stats,
    orderRows: recentOrders,
    portfolioHistory: eqHistory.map((r) => ({
      portfolio: r.totalEquity,
      recordedAt: r.recordedAt,
    })),
    resolutions: recentRes,
    bucketStats,
    dailyPnl: dailyRows
      .map((r) => ({ date: r.day, pnl: Number(r.pnl) }))
      .reverse(),
    windowedWinRates: windowedRates,
    forecastAccuracy,
  };
}

// ─── Cache class ────────────────────────────────────────────

type Listener = (data: CachedPerformanceData) => void;

export class PerformanceCache {
  private data: CachedPerformanceData | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();
  private cachePath: string;
  private refreshing = false;

  constructor(cachePath: string) {
    this.cachePath = cachePath;
  }

  async init(): Promise<void> {
    const diskData = await this.loadFromDisk();
    if (diskData) {
      this.data = diskData;
      this.notify();
      // Refresh from DB in background to pick up changes since last run
      this.scheduleRefresh(100);
    } else {
      await this.refresh();
    }
  }

  getData(): CachedPerformanceData | null {
    return this.data;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.data) listener(this.data);
    return () => this.listeners.delete(listener);
  }

  startListening(): () => void {
    const unsubs = [
      bus.on("bot:status", () => this.scheduleRefresh()),
      bus.on("balance:update", () => this.scheduleRefresh()),
      bus.on("position:update", () => this.scheduleRefresh()),
      bus.on("calibration:updated", () => this.scheduleRefresh()),
      bus.on("order:placed", () => this.scheduleRefresh()),
      bus.on("order:update", () => this.scheduleRefresh()),
    ];
    return () => {
      unsubs.forEach((u) => u());
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
    };
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.data = await computeAll();
      this.notify();
      this.saveToDisk().catch(() => {});
    } finally {
      this.refreshing = false;
    }
  }

  private scheduleRefresh(delayMs = DEBOUNCE_MS): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), delayMs);
  }

  private notify(): void {
    if (this.data) {
      for (const l of this.listeners) l(this.data);
    }
  }

  private async loadFromDisk(): Promise<CachedPerformanceData | null> {
    try {
      const file = Bun.file(this.cachePath);
      if (await file.exists()) {
        const data = await file.json();
        if (data?.version === CACHE_VERSION) return data;
      }
    } catch {}
    return null;
  }

  private async saveToDisk(): Promise<void> {
    if (!this.data) return;
    await Bun.write(this.cachePath, JSON.stringify(this.data));
  }
}

// ─── Singleton ──────────────────────────────────────────────

let _cache: PerformanceCache | null = null;

export function getPerformanceCache(): PerformanceCache {
  if (!_cache) {
    const config = getConfig();
    const dbDir = dirname(resolve(config.db.path));
    _cache = new PerformanceCache(join(dbDir, "performance-cache.json"));
  }
  return _cache;
}
