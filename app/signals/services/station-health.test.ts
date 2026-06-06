import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  evaluateStationHealth,
  updateStationHealthGate,
  type StationTradeOutcome,
} from "./station-health";
import {
  runMigrations,
  getDb,
  orders,
  signals,
  markets,
  runtimeConfig,
  eq,
} from "@kcb/db";
import { getConfig } from "@kcb/config";

runMigrations();

// ----------------------------------------------------------------------------
// Pure: evaluateStationHealth
// ----------------------------------------------------------------------------

const PURE_CONFIG = {
  disableBelow: 0.45,
  reenableAbove: 0.55,
  minTrades: 10,
  reenableTrades: 15,
};

/** Build `n` outcomes for a station with `wins` of them winning. */
function outcomes(
  stationId: string,
  wins: number,
  total: number,
  startDay = 1
): StationTradeOutcome[] {
  const out: StationTradeOutcome[] = [];
  for (let i = 0; i < total; i++) {
    out.push({
      stationId,
      win: i < wins,
      settledAt: `2026-06-${String(startDay + i).padStart(2, "0")}T12:00:00.000Z`,
    });
  }
  return out;
}

describe("evaluateStationHealth — disable path", () => {
  test("disables an enabled station below the floor with enough trades", () => {
    // 6 wins / 19 = 31.6% < 45%, 19 ≥ 10
    const decisions = evaluateStationHealth({
      outcomes: outcomes("KNYC", 6, 19),
      currentlyDisabled: new Set(),
      config: PURE_CONFIG,
    });
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d.action).toBe("disable");
    expect(d.stationId).toBe("KNYC");
    expect(d.trades).toBe(19);
    expect(d.winRate).toBeCloseTo(6 / 19, 5);
    expect(d.reason).toBe("win rate 32% over 19 settled trades < 45% floor");
  });

  test("holds below minTrades even when win rate is terrible", () => {
    // 1 win / 9 = 11% (well below floor) but only 9 < 10 trades
    const decisions = evaluateStationHealth({
      outcomes: outcomes("KORD", 1, 9),
      currentlyDisabled: new Set(),
      config: PURE_CONFIG,
    });
    expect(decisions[0]!.action).toBe("hold");
    expect(decisions[0]!.trades).toBe(9);
    expect(decisions[0]!.reason).toContain("need 10 to disable");
  });

  test("holds an enabled station at/above the floor", () => {
    // 12 wins / 20 = 60% ≥ 45%
    const decisions = evaluateStationHealth({
      outcomes: outcomes("KMIA", 12, 20),
      currentlyDisabled: new Set(),
      config: PURE_CONFIG,
    });
    expect(decisions[0]!.action).toBe("hold");
  });
});

describe("evaluateStationHealth — reenable path", () => {
  test("re-enables when trailing-N wins at/above the bar", () => {
    // 20 outcomes; trailing 15 are all wins → 100% ≥ 55%
    const decisions = evaluateStationHealth({
      outcomes: outcomes("KLAX", 20, 20),
      currentlyDisabled: new Set(["KLAX"]),
      config: PURE_CONFIG,
    });
    const d = decisions[0]!;
    expect(d.action).toBe("reenable");
    expect(d.trades).toBe(15); // trailing window size
    expect(d.winRate).toBeCloseTo(1, 5);
    expect(d.reason).toContain("re-enable bar");
  });

  test("uses only the trailing-N most-recent outcomes for the rate", () => {
    // First 10 all losses, last 15 all wins. Trailing 15 = 100% → reenable,
    // even though the full set is only 15/25 = 60%.
    const losses = outcomes("KDEN", 0, 10, 1); // days 01-10, all losses
    const wins = outcomes("KDEN", 15, 15, 11); // days 11-25, all wins
    const decisions = evaluateStationHealth({
      outcomes: [...wins, ...losses], // deliberately unsorted
      currentlyDisabled: new Set(["KDEN"]),
      config: PURE_CONFIG,
    });
    const d = decisions[0]!;
    expect(d.action).toBe("reenable");
    expect(d.winRate).toBeCloseTo(1, 5);
    expect(d.trades).toBe(15);
  });

  test("holds disabled when trailing rate is below the re-enable bar", () => {
    // 15 outcomes, 7 wins = 46.7% — above the 45% disable floor but below the
    // 55% re-enable bar → stays disabled (the dead band).
    const decisions = evaluateStationHealth({
      outcomes: outcomes("KORD", 7, 15),
      currentlyDisabled: new Set(["KORD"]),
      config: PURE_CONFIG,
    });
    const d = decisions[0]!;
    expect(d.action).toBe("hold");
    expect(d.winRate).toBeCloseTo(7 / 15, 5);
    expect(d.reason).toContain("re-enable bar");
  });

  test("holds disabled when data is frozen / insufficient (< floor of 5)", () => {
    // Only 3 outcomes (all wins) — below the min(reenableTrades, 5) floor.
    const decisions = evaluateStationHealth({
      outcomes: outcomes("KNYC", 3, 3),
      currentlyDisabled: new Set(["KNYC"]),
      config: PURE_CONFIG,
    });
    const d = decisions[0]!;
    expect(d.action).toBe("hold");
    expect(d.trades).toBe(3);
    expect(d.reason).toContain("need 5 to re-enable");
  });

  test("disabled station with ZERO outcomes holds (frozen-data caveat)", () => {
    const decisions = evaluateStationHealth({
      outcomes: [],
      currentlyDisabled: new Set(["KNYC"]),
      config: PURE_CONFIG,
    });
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d.stationId).toBe("KNYC");
    expect(d.action).toBe("hold");
    expect(d.winRate).toBeNull();
    expect(d.trades).toBe(0);
  });
});

describe("evaluateStationHealth — hysteresis band", () => {
  test("win rate 0.50 between 0.45/0.55: enabled stays enabled AND disabled stays disabled", () => {
    // Same 50% rate, same outcome set, different starting states.
    const half = outcomes("KX", 10, 20); // 50%

    const enabled = evaluateStationHealth({
      outcomes: half.map((o) => ({ ...o, stationId: "KENABLED" })),
      currentlyDisabled: new Set(),
      config: PURE_CONFIG,
    });
    expect(enabled[0]!.action).toBe("hold"); // 50% ≥ 45% floor → not disabled

    const disabled = evaluateStationHealth({
      outcomes: half.map((o) => ({ ...o, stationId: "KDISABLED" })),
      currentlyDisabled: new Set(["KDISABLED"]),
      config: PURE_CONFIG,
    });
    expect(disabled[0]!.action).toBe("hold"); // 50% < 55% bar → not re-enabled
  });
});

describe("evaluateStationHealth — misconfig clamp", () => {
  test("reenableAbove ≤ disableBelow clamps to disableBelow + 0.10", () => {
    // Misconfigured: reenableAbove (0.40) ≤ disableBelow (0.45). Effective bar
    // becomes 0.55. A trailing 50% rate must therefore NOT re-enable.
    const decisions = evaluateStationHealth({
      outcomes: outcomes("KMIS", 10, 20), // 50%
      currentlyDisabled: new Set(["KMIS"]),
      config: { ...PURE_CONFIG, disableBelow: 0.45, reenableAbove: 0.4 },
    });
    expect(decisions[0]!.action).toBe("hold");

    // A trailing-15 rate of 60% clears the clamped 0.55 bar → re-enable.
    // Build exactly 15 outcomes, 9 wins (60%) — every outcome is in the
    // trailing window so the slice rate equals the overall rate.
    const ok = evaluateStationHealth({
      outcomes: outcomes("KMIS2", 9, 15), // 9/15 = 60%, all within trailing-15
      currentlyDisabled: new Set(["KMIS2"]),
      config: { ...PURE_CONFIG, disableBelow: 0.45, reenableAbove: 0.4 },
    });
    expect(ok[0]!.action).toBe("reenable");
  });
});

describe("evaluateStationHealth — zero outcomes, not disabled", () => {
  test("enabled station with no outcomes is not emitted unless disabled", () => {
    // No outcomes at all, nothing disabled → empty decision set.
    const decisions = evaluateStationHealth({
      outcomes: [],
      currentlyDisabled: new Set(),
      config: PURE_CONFIG,
    });
    expect(decisions).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// DB-aware: updateStationHealthGate
// ----------------------------------------------------------------------------

const original = { ...getConfig().bot };

function seedTrade(opts: {
  station: string;
  side: "yes" | "no";
  result: "yes" | "no";
  recommendation?: string;
  settledAt?: string;
}) {
  const db = getDb();
  const id = crypto.randomUUID();
  const ticker = `KXHIGH-${id.slice(0, 8)}`;
  const settledAt = opts.settledAt ?? new Date().toISOString();
  db.insert(signals)
    .values({
      id,
      ticker,
      seriesTicker: "KXHIGH",
      estimatedProb: 0.5,
      confidence: 0.5,
      marketPrice: 0.5,
      edge: 0.1,
      edgeThreshold: 0.05,
      recommendation: opts.recommendation ?? (opts.side === "yes" ? "buy_yes" : "buy_no"),
      side: opts.side,
      createdAt: settledAt,
    })
    .run();
  db.insert(markets)
    .values({
      ticker,
      eventTicker: "KXHIGH-EVT",
      seriesTicker: "KXHIGH",
      title: "test market",
      category: "high_temp",
      stationId: opts.station,
      marketType: "bracket",
      status: "settled",
      result: opts.result,
      discoveredAt: settledAt,
      updatedAt: settledAt,
    })
    .run();
  db.insert(orders)
    .values({
      orderId: crypto.randomUUID(),
      ticker,
      action: "buy",
      side: opts.side,
      limitPrice: 50,
      quantity: 1,
      status: "filled",
      signalId: id,
      createdAt: settledAt,
      updatedAt: settledAt,
    })
    .run();
}

function readDisabledCsv(): string | null {
  const db = getDb();
  const row = db
    .select({ value: runtimeConfig.value })
    .from(runtimeConfig)
    .where(eq(runtimeConfig.key, "disabled_stations"))
    .all()[0];
  return row?.value ?? null;
}

describe("updateStationHealthGate — DB wrapper", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(orders).run();
    db.delete(signals).run();
    db.delete(markets).run();
    db.delete(runtimeConfig).run();
    const bot = getConfig().bot;
    bot.stationHealthEnabled = true;
    bot.stationHealthWindowDays = 30;
    bot.stationHealthDisableBelow = 0.45;
    bot.stationHealthReenableAbove = 0.55;
    bot.stationHealthMinTrades = 10;
    bot.stationHealthReenableTrades = 15;
  });

  afterEach(() => {
    Object.assign(getConfig().bot, original);
  });

  test("disable path writes the runtime row", async () => {
    // 12 losing buy_no trades at KNYC (NO bet, market resolved YES → loss).
    for (let i = 0; i < 12; i++) {
      seedTrade({ station: "KNYC", side: "no", result: "yes" });
    }
    const acted = await updateStationHealthGate();
    expect(acted).toHaveLength(1);
    expect(acted[0]!.action).toBe("disable");
    expect(acted[0]!.stationId).toBe("KNYC");
    expect(readDisabledCsv()).toBe("KNYC");
  });

  test("confirmation trades are excluded from the rate", async () => {
    // 12 LOSING confirmation trades + 0 contrarian trades at KORD. If confirms
    // counted, KORD would have a 0% rate and disable. They must be excluded →
    // no contrarian outcomes → no action.
    for (let i = 0; i < 12; i++) {
      seedTrade({
        station: "KORD",
        side: "no",
        result: "yes",
        recommendation: "confirm_no",
      });
    }
    const acted = await updateStationHealthGate();
    expect(acted).toHaveLength(0);
    expect(readDisabledCsv()).toBeNull();
  });

  test("confirmation wins do not mask a sick contrarian station", async () => {
    // KLAX: 11 losing contrarian trades (→ 0% over 11 ≥ 10 → disable) PLUS a
    // pile of winning confirmations that, if counted, would lift the rate above
    // the floor. The disable must still fire on the contrarian-only subset.
    for (let i = 0; i < 11; i++) {
      seedTrade({ station: "KLAX", side: "no", result: "yes" }); // contrarian loss
    }
    for (let i = 0; i < 20; i++) {
      seedTrade({
        station: "KLAX",
        side: "yes",
        result: "yes",
        recommendation: "confirm_yes",
      }); // confirmation win
    }
    const acted = await updateStationHealthGate();
    expect(acted).toHaveLength(1);
    expect(acted[0]!.action).toBe("disable");
    expect(readDisabledCsv()).toBe("KLAX");
  });

  test("disabled-with-no-data station survives in CSV (manual override preserved)", async () => {
    const db = getDb();
    // Operator manually disabled KAUS (no recent settled data exists for it).
    db.insert(runtimeConfig)
      .values({
        key: "disabled_stations",
        value: "KAUS",
        updatedAt: new Date().toISOString(),
      })
      .run();
    // And a fresh sick station KNYC that the gate should newly disable.
    for (let i = 0; i < 12; i++) {
      seedTrade({ station: "KNYC", side: "no", result: "yes" });
    }
    const acted = await updateStationHealthGate();
    expect(acted.map((d) => d.stationId)).toEqual(["KNYC"]);
    // KAUS preserved, KNYC added, sorted CSV.
    expect(readDisabledCsv()).toBe("KAUS,KNYC");
  });

  test("re-enable path removes the station from the CSV", async () => {
    const db = getDb();
    db.insert(runtimeConfig)
      .values({
        key: "disabled_stations",
        value: "KLAX,KNYC",
        updatedAt: new Date().toISOString(),
      })
      .run();
    // KLAX accrued 15 winning settled trades (e.g. via a shadow stream) → re-enable.
    for (let i = 0; i < 15; i++) {
      seedTrade({ station: "KLAX", side: "yes", result: "yes" });
    }
    const acted = await updateStationHealthGate();
    expect(acted).toHaveLength(1);
    expect(acted[0]!.action).toBe("reenable");
    expect(acted[0]!.stationId).toBe("KLAX");
    // KLAX removed, KNYC (no data) preserved.
    expect(readDisabledCsv()).toBe("KNYC");
  });

  test("stationHealthEnabled=false → untouched (no-op)", async () => {
    getConfig().bot.stationHealthEnabled = false;
    for (let i = 0; i < 12; i++) {
      seedTrade({ station: "KNYC", side: "no", result: "yes" });
    }
    const acted = await updateStationHealthGate();
    expect(acted).toHaveLength(0);
    // No runtime_config row was written.
    expect(readDisabledCsv()).toBeNull();
  });

  test("window filter excludes outcomes older than stationHealthWindowDays", async () => {
    // 12 losing trades but settled 40 days ago — outside the 30-day window.
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    for (let i = 0; i < 12; i++) {
      seedTrade({ station: "KNYC", side: "no", result: "yes", settledAt: old });
    }
    const acted = await updateStationHealthGate();
    expect(acted).toHaveLength(0);
    expect(readDisabledCsv()).toBeNull();
  });
});
