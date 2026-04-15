import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { PerformanceCache, type CachedPerformanceData } from "./performance-cache";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";

function makeCacheData(overrides: Partial<CachedPerformanceData> = {}): CachedPerformanceData {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    stats: {
      cash: 10000,
      portfolio: 12000,
      unrealizedPnl: 200,
      realizedPnl: 1800,
      winRate: 0.6,
      brierScore: 0.15,
      orderCount: 50,
      positionCount: 3,
    },
    orderRows: [],
    portfolioHistory: [
      { portfolio: 10000, recordedAt: "2026-04-01T00:00:00Z" },
      { portfolio: 12000, recordedAt: "2026-04-14T00:00:00Z" },
    ],
    resolutions: [],
    bucketStats: [],
    dailyPnl: [],
    windowedWinRates: [
      { label: "24h", wins: 2, total: 3, rate: 0.667 },
      { label: "48h", wins: 4, total: 6, rate: 0.667 },
      { label: "7d", wins: 10, total: 15, rate: 0.667 },
    ],
    forecastAccuracy: null,
    ...overrides,
  };
}

function tmpCachePath(): string {
  return join(tmpdir(), `perf-cache-test-${crypto.randomUUID()}.json`);
}

describe("PerformanceCache disk persistence", () => {
  let cachePath: string;

  beforeEach(() => {
    cachePath = tmpCachePath();
  });

  afterEach(() => {
    try { unlinkSync(cachePath); } catch {}
  });

  test("saves data to disk and loads it back", async () => {
    const data = makeCacheData();
    await Bun.write(cachePath, JSON.stringify(data));

    const cache = new PerformanceCache(cachePath);
    const loaded = await (cache as any).loadFromDisk();

    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.stats.cash).toBe(10000);
    expect(loaded!.portfolioHistory).toHaveLength(2);
  });

  test("returns null for missing cache file", async () => {
    const cache = new PerformanceCache(cachePath);
    const loaded = await (cache as any).loadFromDisk();
    expect(loaded).toBeNull();
  });

  test("returns null for corrupted cache file", async () => {
    await Bun.write(cachePath, "not valid json{{{");
    const cache = new PerformanceCache(cachePath);
    const loaded = await (cache as any).loadFromDisk();
    expect(loaded).toBeNull();
  });

  test("returns null for wrong version", async () => {
    const data = makeCacheData({ version: 999 });
    await Bun.write(cachePath, JSON.stringify(data));

    const cache = new PerformanceCache(cachePath);
    const loaded = await (cache as any).loadFromDisk();
    expect(loaded).toBeNull();
  });

  test("saveToDisk persists current data", async () => {
    const cache = new PerformanceCache(cachePath);
    (cache as any).data = makeCacheData();
    await (cache as any).saveToDisk();

    const file = Bun.file(cachePath);
    expect(await file.exists()).toBe(true);
    const saved = await file.json();
    expect(saved.version).toBe(1);
    expect(saved.stats.cash).toBe(10000);
  });
});

describe("PerformanceCache subscribe", () => {
  test("notifies listeners with current data on subscribe", () => {
    const cache = new PerformanceCache(tmpCachePath());
    const data = makeCacheData();
    (cache as any).data = data;

    let received: CachedPerformanceData | null = null;
    cache.subscribe((d) => { received = d; });

    expect(received).not.toBeNull();
    expect(received!.stats.cash).toBe(10000);
  });

  test("does not notify after unsubscribe", () => {
    const cache = new PerformanceCache(tmpCachePath());
    (cache as any).data = makeCacheData();

    let callCount = 0;
    const unsub = cache.subscribe(() => { callCount++; });
    expect(callCount).toBe(1); // initial notification

    unsub();
    (cache as any).notify();
    expect(callCount).toBe(1); // no additional notification
  });

  test("multiple listeners all receive updates", () => {
    const cache = new PerformanceCache(tmpCachePath());
    (cache as any).data = makeCacheData();

    const received: number[] = [];
    cache.subscribe(() => received.push(1));
    cache.subscribe(() => received.push(2));

    expect(received).toEqual([1, 2]);

    (cache as any).notify();
    expect(received).toEqual([1, 2, 1, 2]);
  });
});

describe("PerformanceCache debouncing", () => {
  test("scheduleRefresh debounces multiple calls", async () => {
    const cache = new PerformanceCache(tmpCachePath());
    let refreshCount = 0;
    const originalRefresh = cache.refresh.bind(cache);
    cache.refresh = async () => {
      refreshCount++;
    };

    // Schedule 5 rapid refreshes with short delay
    for (let i = 0; i < 5; i++) {
      (cache as any).scheduleRefresh(50);
    }

    // Wait for debounce to settle
    await new Promise((r) => setTimeout(r, 150));
    expect(refreshCount).toBe(1);
  });

  test("getData returns null before init", () => {
    const cache = new PerformanceCache(tmpCachePath());
    expect(cache.getData()).toBeNull();
  });
});
