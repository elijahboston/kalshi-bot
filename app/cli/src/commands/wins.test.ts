import { test, expect, describe, beforeEach } from "bun:test";

// DO NOT mock @kcb/db — it leaks globally. Use real in-memory DB instead.
import { runMigrations, getDb, signals, markets, orders, sql } from "@kcb/db";

runMigrations();

import { winsCommands, gateFamily } from "./wins";

const winsHandler = winsCommands[0]!.handler;

/** All seeds default to the new regime (after 2026-06-05T20:00Z). */
const REGIME_TS = "2026-06-05T21:00:00.000Z";
const PRE_REGIME_TS = "2026-06-01T12:00:00.000Z";

let seq = 0;
const uid = () => `wins-test-${++seq}`;

function seedMarket(ticker: string, result: "yes" | "no", stationId = "KNYC") {
  getDb()
    .insert(markets)
    .values({
      ticker,
      eventTicker: ticker.split("-").slice(0, 2).join("-"),
      seriesTicker: ticker.split("-")[0]!,
      title: `test ${ticker}`,
      category: "high_temp",
      stationId,
      targetDate: "2026-06-05",
      bracketLow: 80.5,
      bracketHigh: 82.5,
      marketType: "bracket",
      status: "settled",
      result,
      discoveredAt: REGIME_TS,
      updatedAt: REGIME_TS,
    })
    .onConflictDoNothing()
    .run();
}

function seedActedTrade(opts: {
  ticker: string;
  side: "yes" | "no";
  result: "yes" | "no";
  price: number;
  qty?: number;
  recommendation?: string;
  confidence?: number;
  stationId?: string;
  createdAt?: string;
}) {
  const db = getDb();
  const createdAt = opts.createdAt ?? REGIME_TS;
  const signalId = uid();
  seedMarket(opts.ticker, opts.result, opts.stationId ?? "KNYC");
  db.insert(signals)
    .values({
      id: signalId,
      ticker: opts.ticker,
      seriesTicker: opts.ticker.split("-")[0]!,
      estimatedProb: 0.5,
      confidence: opts.confidence ?? 0.9,
      marketPrice: opts.price / 100,
      edge: 0.1,
      edgeThreshold: 0.05,
      recommendation: opts.recommendation ?? "buy_yes",
      side: opts.side,
      acted: true,
      createdAt,
      dryRun: true,
    })
    .run();
  db.insert(orders)
    .values({
      orderId: uid(),
      ticker: opts.ticker,
      action: "buy",
      side: opts.side,
      limitPrice: opts.price,
      quantity: opts.qty ?? 5,
      filledQuantity: opts.qty ?? 5,
      status: "filled",
      signalId,
      dryRun: true,
      createdAt,
      updatedAt: createdAt,
    })
    .run();
}

function seedSkippedSignal(opts: {
  ticker: string;
  side: "yes" | "no";
  result: "yes" | "no";
  skipReason: string;
  createdAt?: string;
}) {
  seedMarket(opts.ticker, opts.result);
  getDb()
    .insert(signals)
    .values({
      id: uid(),
      ticker: opts.ticker,
      seriesTicker: opts.ticker.split("-")[0]!,
      estimatedProb: 0.5,
      confidence: 0.9,
      marketPrice: 0.5,
      edge: 0.1,
      edgeThreshold: 0.05,
      recommendation: "skip",
      side: opts.side,
      acted: false,
      skipReason: opts.skipReason,
      createdAt: opts.createdAt ?? REGIME_TS,
      dryRun: true,
    })
    .run();
}

beforeEach(() => {
  const db = getDb();
  db.delete(signals).run();
  db.delete(orders).run();
  db.delete(markets).run();
});

describe("gateFamily", () => {
  test("maps 12-char reason keys to families", () => {
    expect(gateFamily("contra-marke")).toBe("contra-market");
    expect(gateFamily("coin-flip zo")).toBe("coin-flip");
    expect(gateFamily("scout mode (")).toBe("scout mode");
    expect(gateFamily("edge 9.1¢ < ")).toBe("edge < threshold");
    expect(gateFamily("no same-day ")).toBe("obs stale/missing");
    expect(gateFamily("hrrr unavail")).toBe("hrrr unavailable");
    expect(gateFamily("event argmax")).toBe("event argmax");
    expect(gateFamily(null)).toBe("other");
    expect(gateFamily("mystery thing")).toBe("other");
  });
});

describe("wins summary", () => {
  test("computes win rate and settle-assumed pnl with pathway split", async () => {
    // 3 wins / 1 loss → 75%
    seedActedTrade({ ticker: "KXHIGHNY-26JUN05-B81.5", side: "yes", result: "yes", price: 80, qty: 5 }); // +5×20
    seedActedTrade({ ticker: "KXHIGHNY-26JUN05-B83.5", side: "no", result: "no", price: 85, qty: 5, recommendation: "confirm_no" }); // +5×15
    seedActedTrade({ ticker: "KXHIGHDEN-26JUN05-T87", side: "yes", result: "yes", price: 82, qty: 6, recommendation: "confirm_yes" }); // +6×18
    seedActedTrade({ ticker: "KXHIGHCHI-26JUN05-B74.5", side: "no", result: "yes", price: 25, qty: 5 }); // −5×25

    const out = (await winsHandler(["summary"])) as string;

    expect(out).toContain("75.0% vs 80% target (n=4)");
    // pnl = (100 + 75 + 108 − 125)¢ = +158¢ gross, minus taker fees
    // (6 + 5 + 7 + 7)¢ = +133¢ = +$1.33
    expect(out).toContain("+$1.33");
    expect(out).toContain("confirmation");
    expect(out).toContain("contrarian");
    expect(out).toContain("settle-assumed");
  });

  test("empty new-regime window points at `all`", async () => {
    seedActedTrade({
      ticker: "KXHIGHNY-26MAY01-B70.5",
      side: "no",
      result: "no",
      price: 40,
      createdAt: PRE_REGIME_TS,
    });
    const out = (await winsHandler(["summary"])) as string;
    expect(out).toContain("wins summary all");
  });

  test("`all` includes pre-regime trades", async () => {
    seedActedTrade({
      ticker: "KXHIGHNY-26MAY01-B70.5",
      side: "no",
      result: "no",
      price: 40,
      createdAt: PRE_REGIME_TS,
    });
    const out = (await winsHandler(["summary", "all"])) as string;
    expect(out).toContain("(n=1)");
    expect(out).toContain("100.0%");
  });
});

describe("wins by_gate", () => {
  test("computes would-have-won per gate family with saving/costing verdicts", async () => {
    // contra-market gate blocked 6 signals whose side would have LOST 5/6 → SAVING
    for (let i = 0; i < 6; i++) {
      seedSkippedSignal({
        ticker: `KXHIGHNY-26JUN05-B${70 + i}.5`,
        side: "no",
        result: i === 0 ? "no" : "yes", // would-have-won only 1/6
        skipReason: "contra-market: buy_no blocked (market 80¢ ≥ 65¢ says YES)",
      });
    }
    // coin-flip gate blocked 5 signals that would have WON 4/5 → COSTING
    for (let i = 0; i < 5; i++) {
      seedSkippedSignal({
        ticker: `KXHIGHDEN-26JUN05-B${80 + i}.5`,
        side: "yes",
        result: i === 0 ? "no" : "yes",
        skipReason: "coin-flip zone: market 50¢ in [40, 60]¢",
      });
    }

    const out = (await winsHandler(["by_gate"])) as string;

    expect(out).toContain("contra-market");
    expect(out).toContain("16.7%"); // 1/6
    expect(out).toContain("SAVING");
    expect(out).toContain("coin-flip");
    expect(out).toContain("80.0%"); // 4/5
    expect(out).toContain("COSTING");
  });

  test("dedupes to the last signal per (ticker, family)", async () => {
    // Same ticker hit the same gate on two ticks with opposite sides; only the
    // LAST (yes, which wins) counts.
    seedSkippedSignal({
      ticker: "KXHIGHNY-26JUN05-B81.5",
      side: "no",
      result: "yes",
      skipReason: "coin-flip zone: market 50¢ in [40, 60]¢",
      createdAt: "2026-06-05T20:30:00.000Z",
    });
    seedSkippedSignal({
      ticker: "KXHIGHNY-26JUN05-B81.5",
      side: "yes",
      result: "yes",
      skipReason: "coin-flip zone: market 51¢ in [40, 60]¢",
      createdAt: "2026-06-05T22:30:00.000Z",
    });

    const out = (await winsHandler(["by_gate"])) as string;
    // one deduped row, would-win 1/1 = 100%
    expect(out).toContain("coin-flip");
    expect(out).toContain("100.0%");
    expect(out).toContain("(n too small)");
  });
});

describe("wins by_path / by_confidence / by_station / by_hour", () => {
  test("by_path splits recommendations", async () => {
    seedActedTrade({ ticker: "KXHIGHNY-26JUN05-B81.5", side: "yes", result: "yes", price: 80, recommendation: "confirm_yes" });
    seedActedTrade({ ticker: "KXHIGHNY-26JUN05-B83.5", side: "no", result: "no", price: 30, recommendation: "buy_no" });

    const out = (await winsHandler(["by_path"])) as string;
    expect(out).toContain("confirm_yes");
    expect(out).toContain("buy_no");
  });

  test("by_confidence buckets boundaries", async () => {
    seedActedTrade({ ticker: "KXHIGHNY-26JUN05-B81.5", side: "yes", result: "yes", price: 80, confidence: 0.95 });
    seedActedTrade({ ticker: "KXHIGHNY-26JUN05-B83.5", side: "no", result: "no", price: 30, confidence: 0.84 });

    const out = (await winsHandler(["by_confidence"])) as string;
    expect(out).toContain("≥0.95");
    expect(out).toContain("0.80-0.85");
  });

  test("by_station marks disabled stations", async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO runtime_config (key, value, updated_at)
        VALUES ('disabled_stations', 'KORD', '2026-06-05T00:00:00Z')
        ON CONFLICT(key) DO UPDATE SET value='KORD'`);
    seedActedTrade({ ticker: "KXHIGHCHI-26JUN05-B74.5", side: "no", result: "no", price: 30, stationId: "KORD" });

    const out = (await winsHandler(["by_station"])) as string;
    expect(out).toContain("KORD [disabled]");
  });

  test("by_hour buckets UTC entry hour", async () => {
    seedActedTrade({
      ticker: "KXHIGHNY-26JUN05-B81.5",
      side: "yes",
      result: "yes",
      price: 80,
      createdAt: "2026-06-05T22:04:00.000Z",
    });
    const out = (await winsHandler(["by_hour"])) as string;
    expect(out).toContain("22Z");
  });
});

describe("wins usage", () => {
  test("unknown subcommand returns usage", async () => {
    const out = (await winsHandler(["bogus"])) as string;
    expect(out).toContain("Usage: wins");
  });
});
