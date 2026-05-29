import { test, expect, describe } from "bun:test";
import { evaluateTailGate } from "./entry-gates";

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
