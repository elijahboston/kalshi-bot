import { test, expect, describe, beforeEach, mock } from "bun:test";

// Only @kcb/config is safe to module-mock. We never call connect() in these
// tests, so auth is never invoked and does not need to be mocked.
mock.module("@kcb/config", () => ({
  getConfig: () => ({
    kalshi: {
      apiKey: "test-key",
      apiSecret: "test-secret",
      baseUrl: "https://api.test.kalshi.com/trade-api/v2",
    },
  }),
}));

import { KalshiFeed, type SequenceGap } from "./feed";

function feedFor(channel: "ticker" | "market_lifecycle_v2" = "ticker") {
  const feed = new KalshiFeed();
  const errors: Error[] = [];
  const gaps: SequenceGap[] = [];
  feed.on({
    onError: (e) => errors.push(e),
    onSequenceGap: (g) => gaps.push(g),
  });
  // Inject a synthetic message of `type` directly into the private message
  // handler so we can exercise trackSeq without a real socket.
  const send = (sid: number, seq: number) => {
    const wrapper =
      channel === "ticker"
        ? {
            type: "ticker",
            sid,
            seq,
            msg: { market_ticker: "T", price: 50, yes_bid: 49, yes_ask: 51, volume: 0, open_interest: 0, ts: 0 },
          }
        : {
            type: "market_lifecycle_v2",
            sid,
            seq,
            msg: { market_ticker: "T", event_type: "new_market" },
          };
    (feed as any).handleMessage(JSON.stringify(wrapper));
  };
  return { feed, errors, gaps, send };
}

describe("KalshiFeed sequence-gap handling", () => {
  beforeEach(() => {
    // KalshiFeed instances are isolated per-test; nothing to reset.
  });

  test("first message on a sid does not raise a gap", () => {
    const { gaps, errors, send } = feedFor();
    send(1, 100);
    expect(gaps).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test("contiguous messages do not raise a gap", () => {
    const { gaps, errors, send } = feedFor();
    send(1, 1);
    send(1, 2);
    send(1, 3);
    expect(gaps).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test("missed message reports a SequenceGap, not an Error", () => {
    const { gaps, errors, send } = feedFor();
    send(1, 5);
    send(1, 7); // missed seq 6
    expect(errors).toHaveLength(0);
    expect(gaps).toEqual([{ sid: 1, expected: 6, got: 7, missed: 1 }]);
  });

  test("multiple missed messages report missed count", () => {
    const { gaps, send } = feedFor();
    send(1, 10);
    send(1, 15); // missed 11, 12, 13, 14
    expect(gaps).toEqual([{ sid: 1, expected: 11, got: 15, missed: 4 }]);
  });

  test("gap detection is per-sid", () => {
    const { gaps, send } = feedFor();
    send(1, 1);
    send(2, 100); // first message on sid 2
    send(1, 3); // gap on sid 1
    send(2, 101); // contiguous on sid 2
    expect(gaps).toEqual([{ sid: 1, expected: 2, got: 3, missed: 1 }]);
  });

  test("lifecycle channel also reports gaps via onSequenceGap", () => {
    const { gaps, errors, send } = feedFor("market_lifecycle_v2");
    send(2, 1);
    send(2, 4);
    expect(errors).toHaveLength(0);
    expect(gaps).toEqual([{ sid: 2, expected: 2, got: 4, missed: 2 }]);
  });

  test("unrecognized message types with sid/seq do not cause false gaps", () => {
    const feed = new KalshiFeed();
    const gaps: SequenceGap[] = [];
    feed.on({ onSequenceGap: (g) => gaps.push(g) });

    // seq 1: recognized ticker
    (feed as any).handleMessage(
      JSON.stringify({
        type: "ticker",
        sid: 1,
        seq: 1,
        msg: { market_ticker: "T", price: 50, yes_bid: 49, yes_ask: 51, volume: 0, open_interest: 0, ts: 0 },
      })
    );
    // seq 2: unrecognized type (e.g. market_lifecycle v1)
    (feed as any).handleMessage(
      JSON.stringify({ type: "market_lifecycle", sid: 1, seq: 2, msg: {} })
    );
    // seq 3: recognized ticker — should be contiguous, no gap
    (feed as any).handleMessage(
      JSON.stringify({
        type: "ticker",
        sid: 1,
        seq: 3,
        msg: { market_ticker: "T", price: 51, yes_bid: 50, yes_ask: 52, volume: 0, open_interest: 0, ts: 0 },
      })
    );
    expect(gaps).toHaveLength(0);
  });
});
