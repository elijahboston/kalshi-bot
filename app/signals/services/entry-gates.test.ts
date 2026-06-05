import { test, expect, describe } from "bun:test";
import {
  evaluateTailGate,
  evaluateEntryGates,
  evaluateConfirmation,
} from "./entry-gates";
import type { EntryGateInput, ConfirmationInput } from "./entry-gates";

describe("evaluateTailGate", () => {
  test("non-tail market passes unconditionally", () => {
    const result = evaluateTailGate({
      market: { marketType: "bracket" },
      side: "no",
      marketPrice: 0.5,
      tailMaxEntryPrice: 0.1,
    });
    expect(result.allowed).toBe(true);
  });

  test("tailMaxEntryPrice=0 disables the gate (allows any tail trade)", () => {
    const result = evaluateTailGate({
      market: { marketType: "upper_tail" },
      side: "no",
      marketPrice: 0.5, // NO entry = 50¢
      tailMaxEntryPrice: 0,
    });
    expect(result.allowed).toBe(true);
  });

  test("NO side: gates when (1 - marketPrice) > tailMaxEntryPrice", () => {
    // marketPrice 0.5 → NO costs 0.5; cap is 0.10 → blocked
    const result = evaluateTailGate({
      market: { marketType: "lower_tail" },
      side: "no",
      marketPrice: 0.5,
      tailMaxEntryPrice: 0.1,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("50¢");
    expect(result.reason).toContain("10¢");
  });

  test("NO side: allows cheap NO entry on a strong-YES market", () => {
    // marketPrice 0.95 → NO costs 0.05 (cheap, deep tail)
    const result = evaluateTailGate({
      market: { marketType: "lower_tail" },
      side: "no",
      marketPrice: 0.95,
      tailMaxEntryPrice: 0.1,
    });
    expect(result.allowed).toBe(true);
  });

  test("YES side: gates when marketPrice > tailMaxEntryPrice", () => {
    const result = evaluateTailGate({
      market: { marketType: "upper_tail" },
      side: "yes",
      marketPrice: 0.25,
      tailMaxEntryPrice: 0.1,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("25¢");
  });

  test("YES side: allows cheap YES entry on a long-shot tail", () => {
    const result = evaluateTailGate({
      market: { marketType: "upper_tail" },
      side: "yes",
      marketPrice: 0.05,
      tailMaxEntryPrice: 0.1,
    });
    expect(result.allowed).toBe(true);
  });

  test("entry exactly at cap is allowed", () => {
    const result = evaluateTailGate({
      market: { marketType: "lower_tail" },
      side: "yes",
      marketPrice: 0.1,
      tailMaxEntryPrice: 0.1,
    });
    expect(result.allowed).toBe(true);
  });
});

describe("evaluateEntryGates", () => {
  // Default config = the shipped win-rate-80 defaults; tests override per-case.
  const defaultConfig: EntryGateInput["config"] = {
    disagreementCap: 0.25,
    noSideMaxMarketPrice: 0.65,
    yesSideMinMarketPrice: 0.35,
    coinFlipZoneLow: 0.4,
    coinFlipZoneHigh: 0.6,
    disabledStations: [],
  };

  // `over.config` is treated as a partial override merged onto defaultConfig.
  const baseInput = (
    over: Partial<Omit<EntryGateInput, "config">> & {
      config?: Partial<EntryGateInput["config"]>;
    } = {}
  ): EntryGateInput => {
    const { config: configOver, ...rest } = over;
    return {
      side: "no",
      estimatedProb: 0.2,
      marketPrice: 0.8,
      stationId: "KMIA",
      ...rest,
      config: { ...defaultConfig, ...configOver },
    };
  };

  describe("each gate fires with correct reason", () => {
    test("station health gate: disabled station blocked", () => {
      const result = evaluateEntryGates(
        baseInput({
          stationId: "KORD",
          // keep other gates from firing: agreeing YES on a non-coin market
          side: "yes",
          estimatedProb: 0.85,
          marketPrice: 0.8,
          config: { disabledStations: ["KORD", "KLAX", "KNYC"] },
        })
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("station health gate: KORD disabled");
    });

    test("side-vs-market: buy_no blocked at ≥65¢ (market says YES)", () => {
      const result = evaluateEntryGates(
        baseInput({ side: "no", estimatedProb: 0.6, marketPrice: 0.8 })
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(
        "contra-market: buy_no blocked (market 80¢ ≥ 65¢ says YES)"
      );
    });

    test("side-vs-market: buy_yes blocked at ≤35¢ (market says NO)", () => {
      const result = evaluateEntryGates(
        baseInput({ side: "yes", estimatedProb: 0.4, marketPrice: 0.2 })
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(
        "contra-market: buy_yes blocked (market 20¢ ≤ 35¢ says NO)"
      );
    });

    test("concordance: large disagreement blocked", () => {
      // YES side, market 0.50 (out of side-vs-market + coin-flip zones via cfg
      // disable), model 0.90 → 40pp disagreement > 25pp cap.
      const result = evaluateEntryGates(
        baseInput({
          side: "yes",
          estimatedProb: 0.9,
          marketPrice: 0.5,
          config: {
            // disable coin-flip + side gates so concordance is what fires
            coinFlipZoneLow: 0,
            coinFlipZoneHigh: 0,
          },
        })
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(
        "disagreement 40.0¢ > cap 25¢ (market better calibrated)"
      );
    });

    test("coin-flip zone: mid-priced market blocked", () => {
      // model agrees closely (no concordance trip), side ok, market 0.50.
      const result = evaluateEntryGates(
        baseInput({ side: "yes", estimatedProb: 0.52, marketPrice: 0.5 })
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("coin-flip zone: market 50¢ in [40, 60]¢");
    });
  });

  describe("gate disable semantics", () => {
    test("empty disabledStations → station gate off", () => {
      const result = evaluateEntryGates(
        baseInput({
          stationId: "KORD",
          side: "yes",
          estimatedProb: 0.85,
          marketPrice: 0.8,
          config: { disabledStations: [] },
        })
      );
      expect(result.allowed).toBe(true);
    });

    test("noSideMaxMarketPrice=0 → side-vs-market (NO) off", () => {
      // buy_no at 0.80 would normally trip side-vs-market; with cap 0 it passes
      // that gate. Disable concordance too (40pp) so we isolate the disable.
      const result = evaluateEntryGates(
        baseInput({
          side: "no",
          estimatedProb: 0.2,
          marketPrice: 0.8,
          config: {
            noSideMaxMarketPrice: 0,
            disagreementCap: 0,
          },
        })
      );
      expect(result.allowed).toBe(true);
    });

    test("yesSideMinMarketPrice=0 → side-vs-market (YES) off", () => {
      const result = evaluateEntryGates(
        baseInput({
          side: "yes",
          estimatedProb: 0.8,
          marketPrice: 0.2,
          config: {
            yesSideMinMarketPrice: 0,
            disagreementCap: 0,
          },
        })
      );
      expect(result.allowed).toBe(true);
    });

    test("disagreementCap=0 → concordance off", () => {
      // 70pp disagreement, but cap 0 disables; keep other gates clear.
      const result = evaluateEntryGates(
        baseInput({
          side: "yes",
          estimatedProb: 0.95,
          marketPrice: 0.25,
          config: {
            disagreementCap: 0,
            yesSideMinMarketPrice: 0, // 0.25 ≤ 0.35 would trip otherwise
            coinFlipZoneLow: 0,
            coinFlipZoneHigh: 0,
          },
        })
      );
      expect(result.allowed).toBe(true);
    });

    test("coin-flip bounds at 0 → zone gate off", () => {
      const result = evaluateEntryGates(
        baseInput({
          side: "yes",
          estimatedProb: 0.52,
          marketPrice: 0.5,
          config: { coinFlipZoneLow: 0, coinFlipZoneHigh: 0 },
        })
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("pass-through", () => {
    test("agreeing YES at market 0.70, model 0.75 → allowed", () => {
      const result = evaluateEntryGates(
        baseInput({ side: "yes", estimatedProb: 0.75, marketPrice: 0.7 })
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test("agreeing NO at market 0.30, model 0.25 → allowed", () => {
      // buy_no, market 0.30 (< 0.65 so side gate clear, not in coin zone),
      // disagreement 5pp.
      const result = evaluateEntryGates(
        baseInput({ side: "no", estimatedProb: 0.25, marketPrice: 0.3 })
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("boundaries", () => {
    test("marketPrice exactly at noSideMaxMarketPrice → blocked (>=)", () => {
      const result = evaluateEntryGates(
        baseInput({ side: "no", estimatedProb: 0.5, marketPrice: 0.65 })
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(
        "contra-market: buy_no blocked (market 65¢ ≥ 65¢ says YES)"
      );
    });

    test("marketPrice exactly at yesSideMinMarketPrice → blocked (<=)", () => {
      const result = evaluateEntryGates(
        baseInput({ side: "yes", estimatedProb: 0.5, marketPrice: 0.35 })
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("buy_yes blocked");
    });

    test("disagreement exactly at cap → allowed (> cap blocks)", () => {
      // YES side, market 0.50, model 0.75 → exactly 25pp == cap, allowed.
      // Disable coin-flip so the 0.50 market doesn't trip that gate.
      const result = evaluateEntryGates(
        baseInput({
          side: "yes",
          estimatedProb: 0.75,
          marketPrice: 0.5,
          config: { coinFlipZoneLow: 0, coinFlipZoneHigh: 0 },
        })
      );
      expect(result.allowed).toBe(true);
    });

    test("disagreement just over cap → blocked", () => {
      const result = evaluateEntryGates(
        baseInput({
          side: "yes",
          estimatedProb: 0.751,
          marketPrice: 0.5,
          config: { coinFlipZoneLow: 0, coinFlipZoneHigh: 0 },
        })
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("disagreement");
    });

    test("coin-flip lower boundary 0.40 → blocked (>= low)", () => {
      const result = evaluateEntryGates(
        baseInput({ side: "yes", estimatedProb: 0.45, marketPrice: 0.4 })
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("coin-flip zone");
    });

    test("coin-flip upper boundary 0.60 → blocked (<= high)", () => {
      const result = evaluateEntryGates(
        baseInput({ side: "no", estimatedProb: 0.45, marketPrice: 0.6 })
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("coin-flip zone");
    });
  });

  describe("check order (first failure wins)", () => {
    test("disabled station + contra-market both true → station reason wins", () => {
      const result = evaluateEntryGates(
        baseInput({
          stationId: "KNYC",
          side: "no",
          estimatedProb: 0.2,
          marketPrice: 0.8, // would also trip side-vs-market
          config: { disabledStations: ["KNYC"] },
        })
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("station health gate: KNYC disabled");
    });

    test("side-vs-market beats concordance + coin-flip", () => {
      // buy_no at 0.80: side gate (priority 2) fires before concordance (3).
      const result = evaluateEntryGates(
        baseInput({ side: "no", estimatedProb: 0.1, marketPrice: 0.8 })
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("contra-market: buy_no");
    });

    test("concordance beats coin-flip when both would fire", () => {
      // market 0.50 (coin zone) AND model 0.90 (40pp disagreement). Concordance
      // (priority 3) wins over coin-flip (4).
      const result = evaluateEntryGates(
        baseInput({ side: "yes", estimatedProb: 0.9, marketPrice: 0.5 })
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("disagreement");
    });
  });
});

describe("evaluateConfirmation", () => {
  // Shipped confirmation defaults; tests override per-case. `enabled` defaults
  // true here so most cases exercise the arms, not the master switch.
  const defaultConfig: ConfirmationInput["config"] = {
    enabled: true,
    minMarketConviction: 0.8,
    minModelAgreement: 0.5,
    maxEntryPrice: 0.93,
  };

  // `over.config` is a partial override merged onto defaultConfig.
  const baseInput = (
    over: Partial<Omit<ConfirmationInput, "config">> & {
      config?: Partial<ConfirmationInput["config"]>;
    } = {}
  ): ConfirmationInput => {
    const { config: configOver, ...rest } = over;
    return {
      estimatedProb: 0.6,
      marketPrice: 0.85,
      ...rest,
      config: { ...defaultConfig, ...configOver },
    };
  };

  describe("disabled", () => {
    test("never fires even on otherwise-perfect YES inputs", () => {
      const result = evaluateConfirmation(
        baseInput({
          estimatedProb: 0.6,
          marketPrice: 0.85,
          config: { enabled: false },
        })
      );
      expect(result.fire).toBe(false);
    });

    test("never fires even on otherwise-perfect NO inputs", () => {
      const result = evaluateConfirmation(
        baseInput({
          estimatedProb: 0.3,
          marketPrice: 0.15,
          config: { enabled: false },
        })
      );
      expect(result.fire).toBe(false);
    });
  });

  describe("YES arm", () => {
    test("fires at market 0.85 / est 0.60; entryPrice = 0.85", () => {
      const result = evaluateConfirmation(
        baseInput({ estimatedProb: 0.6, marketPrice: 0.85 })
      );
      expect(result).toEqual({ fire: true, side: "yes", entryPrice: 0.85 });
    });

    test("blocked when model disagrees (market 0.85 / est 0.45)", () => {
      const result = evaluateConfirmation(
        baseInput({ estimatedProb: 0.45, marketPrice: 0.85 })
      );
      expect(result.fire).toBe(false);
    });

    test("blocked when too expensive (market 0.95 / maxEntryPrice 0.93)", () => {
      const result = evaluateConfirmation(
        baseInput({ estimatedProb: 0.6, marketPrice: 0.95 })
      );
      expect(result.fire).toBe(false);
    });
  });

  describe("YES arm boundaries (inclusive thresholds)", () => {
    test("market exactly at conviction floor 0.80 fires (>=)", () => {
      const result = evaluateConfirmation(
        baseInput({ estimatedProb: 0.6, marketPrice: 0.8 })
      );
      expect(result).toEqual({ fire: true, side: "yes", entryPrice: 0.8 });
    });

    test("est exactly at agreement floor 0.50 fires (>=)", () => {
      const result = evaluateConfirmation(
        baseInput({ estimatedProb: 0.5, marketPrice: 0.85 })
      );
      expect(result).toEqual({ fire: true, side: "yes", entryPrice: 0.85 });
    });

    test("market exactly at maxEntryPrice 0.93 fires (<=)", () => {
      const result = evaluateConfirmation(
        baseInput({ estimatedProb: 0.6, marketPrice: 0.93 })
      );
      expect(result).toEqual({ fire: true, side: "yes", entryPrice: 0.93 });
    });

    test("market 0.94 blocked (just over maxEntryPrice)", () => {
      const result = evaluateConfirmation(
        baseInput({ estimatedProb: 0.6, marketPrice: 0.94 })
      );
      expect(result.fire).toBe(false);
    });
  });

  describe("NO arm", () => {
    test("fires at market 0.15 / est 0.30 → side no, entryPrice 0.85", () => {
      const result = evaluateConfirmation(
        baseInput({ estimatedProb: 0.3, marketPrice: 0.15 })
      );
      expect(result).toEqual({ fire: true, side: "no", entryPrice: 0.85 });
    });

    test("blocked when model says too YES-y (market 0.15 / est 0.55)", () => {
      const result = evaluateConfirmation(
        baseInput({ estimatedProb: 0.55, marketPrice: 0.15 })
      );
      expect(result.fire).toBe(false);
    });

    test("blocked by maxEntryPrice: market 0.05 → NO costs 0.95 > 0.93", () => {
      const result = evaluateConfirmation(
        baseInput({ estimatedProb: 0.3, marketPrice: 0.05 })
      );
      expect(result.fire).toBe(false);
    });
  });

  describe("mid-range market never fires", () => {
    test("market 0.50 fires neither arm", () => {
      const result = evaluateConfirmation(
        baseInput({ estimatedProb: 0.5, marketPrice: 0.5 })
      );
      expect(result.fire).toBe(false);
    });
  });
});
