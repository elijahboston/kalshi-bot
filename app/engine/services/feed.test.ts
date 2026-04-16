import { test, expect, describe, beforeEach, mock } from "bun:test";

mock.module("@kcb/config", () => ({
  getConfig: () => ({
    bot: { dryRun: true },
    db: { path: ":memory:" },
    kalshi: { apiKey: "", apiSecret: "", baseUrl: "https://api.example.com/trade-api/v2" },
  }),
}));

import type { KalshiFeedEvents } from "@kcb/kalshi-client";
import { bus } from "../events";
import { startFeed, stopFeed } from "./feed";

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
  };
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
