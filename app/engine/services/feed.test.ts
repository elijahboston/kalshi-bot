import { test, expect, describe, beforeEach, mock } from "bun:test";

mock.module("@kcb/config", () => ({
  getConfig: () => ({
    bot: { dryRun: true },
    db: { path: ":memory:" },
    kalshi: { apiKey: "", apiSecret: "", baseUrl: "https://api.example.com/trade-api/v2" },
  }),
}));

import type { KalshiFeedEvents, WsTickerMsg } from "@kcb/kalshi-client";
import { runMigrations, getDb, markets, eq } from "@kcb/db";
import { bus } from "../events";
import { startFeed, stopFeed } from "./feed";

runMigrations();

function createStubFeed() {
  let events: KalshiFeedEvents = {};
  const calls: { method: string; args: unknown[] }[] = [];

  return {
    stub: {
      get isConnected() { return false; },
      on(e: KalshiFeedEvents) { events = e; },
      connect() { calls.push({ method: "connect", args: [] }); },
      subscribe(channels: string[], tickers?: string[]) {
        calls.push({ method: "subscribe", args: [channels, tickers] });
        return 1;
      },
      updateSubscription() { return 1; },
      getSubscriptionId() { return undefined; },
      disconnect() { calls.push({ method: "disconnect", args: [] }); },
    } as any,
    calls,
    simulateConnected() { events.onConnected?.(); },
    simulateDisconnected() { events.onDisconnected?.(); },
    simulateSequenceGap(sid: number, expected: number, got: number) {
      events.onSequenceGap?.({ sid, expected, got, missed: got - expected });
    },
    simulateError(err: Error) { events.onError?.(err); },
    simulateTicker(msg: Partial<WsTickerMsg["msg"]> & { market_ticker: string; price: number }) {
      events.onTicker?.({
        type: "ticker",
        sid: 1,
        seq: 1,
        msg: { volume: 0, open_interest: 0, ts: 0, ...msg } as WsTickerMsg["msg"],
      });
    },
  };
}

function seedMarket(ticker: string) {
  const ts = new Date().toISOString();
  getDb()
    .insert(markets)
    .values({
      ticker,
      eventTicker: "KXHIGHNY-25FEB19",
      seriesTicker: "KXHIGHNY",
      title: "test market",
      category: "high_temp",
      marketType: "bracket",
      status: "open",
      discoveredAt: ts,
      updatedAt: ts,
    })
    .onConflictDoNothing()
    .run();
}

function readMarket(ticker: string) {
  return getDb().select().from(markets).where(eq(markets.ticker, ticker)).get();
}

beforeEach(() => {
  stopFeed();
});

describe("startFeed", () => {
  test("does not subscribe before WebSocket connects", () => {
    const { stub, calls } = createStubFeed();
    startFeed(stub);

    const subscribeCalls = calls.filter((c) => c.method === "subscribe");
    expect(subscribeCalls).toHaveLength(0);
    expect(calls.some((c) => c.method === "connect")).toBe(true);
  });

  test("subscribes to lifecycle on connect", () => {
    const { stub, calls, simulateConnected } = createStubFeed();
    startFeed(stub);

    simulateConnected();

    const subscribeCalls = calls.filter((c) => c.method === "subscribe");
    expect(subscribeCalls).toHaveLength(1);
    expect(subscribeCalls[0]!.args[0]).toEqual(["market_lifecycle_v2"]);
  });

  test("re-subscribes to lifecycle on reconnect", () => {
    const { stub, calls, simulateConnected, simulateDisconnected } = createStubFeed();
    startFeed(stub);

    simulateConnected();
    simulateDisconnected();
    simulateConnected();

    const subscribeCalls = calls.filter((c) => c.method === "subscribe");
    expect(subscribeCalls).toHaveLength(2);
  });

  test("sequence gaps do not emit bot:error", () => {
    const { stub, simulateSequenceGap } = createStubFeed();
    startFeed(stub);

    const errorEvents: { module: string; message: string }[] = [];
    const off = bus.on("bot:error", (e) => errorEvents.push({ module: e.module, message: e.message }));

    try {
      simulateSequenceGap(1, 528, 529);
      simulateSequenceGap(1, 530, 535);
      expect(errorEvents).toEqual([]);
    } finally {
      off();
    }
  });

  test("real WebSocket errors still emit bot:error", () => {
    const { stub, simulateError } = createStubFeed();
    startFeed(stub);

    const errorEvents: { module: string; message: string }[] = [];
    const off = bus.on("bot:error", (e) => errorEvents.push({ module: e.module, message: e.message }));

    try {
      simulateError(new Error("WebSocket not connected, cannot send"));
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]!.module).toBe("feed");
      expect(errorEvents[0]!.message).toBe("WebSocket not connected, cannot send");
    } finally {
      off();
    }
  });
});

describe("onTicker — bid/ask persistence (addendum N4)", () => {
  test("persists yes_bid / yes_ask alongside last price", () => {
    const ticker = "KXHIGHNY-25FEB19-B30";
    seedMarket(ticker);

    const { stub, simulateTicker } = createStubFeed();
    startFeed(stub);

    simulateTicker({ market_ticker: ticker, price: 72, yes_bid: 70, yes_ask: 74 });

    const row = readMarket(ticker);
    expect(row).toBeDefined();
    expect(row!.lastYesPrice).toBe(72);
    expect(row!.lastNoPrice).toBe(28);
    expect(row!.yesBid).toBe(70);
    expect(row!.yesAsk).toBe(74);
  });

  test("tolerates absent book fields (null) without clobbering price", () => {
    const ticker = "KXHIGHNY-25FEB19-B31";
    seedMarket(ticker);

    const { stub, simulateTicker } = createStubFeed();
    startFeed(stub);

    // Ticker message with no book — yes_bid/yes_ask undefined.
    simulateTicker({ market_ticker: ticker, price: 55 });

    const row = readMarket(ticker);
    expect(row).toBeDefined();
    expect(row!.lastYesPrice).toBe(55);
    expect(row!.yesBid).toBeNull();
    expect(row!.yesAsk).toBeNull();
  });

  test("a later book update overwrites a prior one", () => {
    const ticker = "KXHIGHNY-25FEB19-B32";
    seedMarket(ticker);

    const { stub, simulateTicker } = createStubFeed();
    startFeed(stub);

    simulateTicker({ market_ticker: ticker, price: 60, yes_bid: 58, yes_ask: 62 });
    simulateTicker({ market_ticker: ticker, price: 61, yes_bid: 59, yes_ask: 63 });

    const row = readMarket(ticker);
    expect(row!.yesBid).toBe(59);
    expect(row!.yesAsk).toBe(63);
  });
});
