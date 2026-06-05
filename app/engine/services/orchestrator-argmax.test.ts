import { test, expect, describe } from "bun:test";
import {
  selectArgmaxPerEvent,
  argmaxSkipReason,
  type ActionableSignal,
} from "./orchestrator";

/**
 * Unit tests for the addendum-N2 argmax-per-event selection. Pure functions, no
 * DB — the orchestrator runner persists the demotions; these only cover the
 * keep/demote decision and the skip-reason wording.
 */

let seq = 0;
function sig(overrides: Partial<ActionableSignal> = {}): ActionableSignal {
  seq += 1;
  return {
    id: `s${seq}`,
    ticker: `T${seq}`,
    seriesTicker: "KXHIGHNY",
    eventTicker: "EVT-A",
    estimatedProb: 0.4,
    confidence: 0.8,
    marketPrice: 0.3,
    edge: 0.1,
    edgeThreshold: 0.05,
    recommendation: "buy_no",
    side: "no",
    kellyFraction: 0.1,
    ensembleSize: 100,
    reasoning: "{}",
    ...overrides,
  };
}

describe("selectArgmaxPerEvent", () => {
  test("keeps only the highest-edge contrarian signal per event", () => {
    const a = sig({ id: "a", ticker: "A", eventTicker: "EVT-A", edge: 0.03, recommendation: "buy_no" });
    const b = sig({ id: "b", ticker: "B", eventTicker: "EVT-A", edge: 0.08, recommendation: "buy_no" });
    const c = sig({ id: "c", ticker: "C", eventTicker: "EVT-A", edge: 0.05, recommendation: "buy_yes" });

    const { kept, demoted } = selectArgmaxPerEvent([a, b, c]);

    expect(kept.map((s) => s.id)).toEqual(["b"]);
    expect(demoted.map((d) => d.signal.id).sort()).toEqual(["a", "c"]);
    // Both losers reference the winner b.
    for (const d of demoted) expect(d.winner.id).toBe("b");
  });

  test("independent across events — one winner each", () => {
    const a1 = sig({ id: "a1", eventTicker: "EVT-A", edge: 0.02 });
    const a2 = sig({ id: "a2", eventTicker: "EVT-A", edge: 0.09 });
    const b1 = sig({ id: "b1", eventTicker: "EVT-B", edge: 0.04 });
    const b2 = sig({ id: "b2", eventTicker: "EVT-B", edge: 0.01 });

    const { kept, demoted } = selectArgmaxPerEvent([a1, a2, b1, b2]);

    expect(kept.map((s) => s.id).sort()).toEqual(["a2", "b1"]);
    expect(demoted.map((d) => d.signal.id).sort()).toEqual(["a1", "b2"]);
  });

  test("confirmation signals are EXEMPT — multiple per event all kept", () => {
    const c1 = sig({ id: "c1", eventTicker: "EVT-A", edge: 0.01, recommendation: "confirm_no", side: "no" });
    const c2 = sig({ id: "c2", eventTicker: "EVT-A", edge: 0.02, recommendation: "confirm_yes", side: "yes" });
    const c3 = sig({ id: "c3", eventTicker: "EVT-A", edge: 0.005, recommendation: "confirm_no", side: "no" });

    const { kept, demoted } = selectArgmaxPerEvent([c1, c2, c3]);

    expect(kept.map((s) => s.id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(demoted).toHaveLength(0);
  });

  test("contrarian winner kept alongside exempt confirmations in the same event", () => {
    const win = sig({ id: "win", eventTicker: "EVT-A", edge: 0.07, recommendation: "buy_no" });
    const lose = sig({ id: "lose", eventTicker: "EVT-A", edge: 0.02, recommendation: "buy_no" });
    const conf = sig({ id: "conf", eventTicker: "EVT-A", edge: 0.001, recommendation: "confirm_yes", side: "yes" });

    const { kept, demoted } = selectArgmaxPerEvent([win, lose, conf]);

    expect(kept.map((s) => s.id).sort()).toEqual(["conf", "win"]);
    expect(demoted.map((d) => d.signal.id)).toEqual(["lose"]);
    expect(demoted[0]!.winner.id).toBe("win");
  });

  test("single contrarian signal per event is never demoted", () => {
    const a = sig({ id: "a", eventTicker: "EVT-A", recommendation: "buy_yes", side: "yes" });
    const b = sig({ id: "b", eventTicker: "EVT-B", recommendation: "buy_no", side: "no" });

    const { kept, demoted } = selectArgmaxPerEvent([a, b]);

    expect(kept.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(demoted).toHaveLength(0);
  });

  test("ties keep the first-seen signal (stable on input order)", () => {
    const first = sig({ id: "first", eventTicker: "EVT-A", edge: 0.05, recommendation: "buy_no" });
    const second = sig({ id: "second", eventTicker: "EVT-A", edge: 0.05, recommendation: "buy_no" });

    const { kept, demoted } = selectArgmaxPerEvent([first, second]);

    expect(kept.map((s) => s.id)).toEqual(["first"]);
    expect(demoted.map((d) => d.signal.id)).toEqual(["second"]);
  });

  test("empty input → empty output", () => {
    const { kept, demoted } = selectArgmaxPerEvent([]);
    expect(kept).toHaveLength(0);
    expect(demoted).toHaveLength(0);
  });

  test("does not mutate the input signals", () => {
    const a = sig({ id: "a", eventTicker: "EVT-A", edge: 0.02, recommendation: "buy_no" });
    const b = sig({ id: "b", eventTicker: "EVT-A", edge: 0.08, recommendation: "buy_no" });
    selectArgmaxPerEvent([a, b]);
    expect(a.recommendation).toBe("buy_no");
    expect(b.recommendation).toBe("buy_no");
  });
});

describe("argmaxSkipReason", () => {
  test("formats the winner ticker and both edges in cents (1 decimal)", () => {
    const winner = sig({ ticker: "KXHIGHNY-26JUN05-B81", edge: 0.062 });
    const loser = sig({ ticker: "KXHIGHNY-26JUN05-B78", edge: 0.031 });
    expect(argmaxSkipReason(winner, loser)).toBe(
      "event argmax: KXHIGHNY-26JUN05-B81 has higher edge (6.2¢ > 3.1¢)"
    );
  });

  test("rounds to one decimal place", () => {
    const winner = sig({ ticker: "W", edge: 0.10005 });
    const loser = sig({ ticker: "L", edge: 0.04449 });
    expect(argmaxSkipReason(winner, loser)).toBe(
      "event argmax: W has higher edge (10.0¢ > 4.4¢)"
    );
  });
});
