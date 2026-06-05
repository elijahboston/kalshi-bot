import { test, expect, describe } from "bun:test";
import { parseTicker, parseBracketFromTitle } from "./discovery";

describe("parseBracketFromTitle (Finding 11 — rounded-integer settlement geometry)", () => {
  test("two-value range '87-88°' → [86.5, 88.5)", () => {
    expect(
      parseBracketFromTitle("Will the **high temp in Denver** be 87-88° on Jun 5, 2026?", "high_temp")
    ).toEqual({ marketType: "bracket", bracketLow: 86.5, bracketHigh: 88.5 });
  });

  test("lower tail '<87°' → threshold 86.5", () => {
    expect(
      parseBracketFromTitle("Will the **high temp in Denver** be <87° on Jun 5, 2026?", "high_temp")
    ).toEqual({ marketType: "lower_tail", bracketLow: 86.5, bracketHigh: null });
  });

  test("upper tail '>94°' → threshold 94.5", () => {
    expect(
      parseBracketFromTitle("Will the **high temp in Denver** be >94° on Jun 5, 2026?", "high_temp")
    ).toEqual({ marketType: "upper_tail", bracketLow: 94.5, bracketHigh: null });
  });

  test("single value 'be 78°' → [77.5, 78.5)", () => {
    expect(
      parseBracketFromTitle("Will the **high temp in NYC** be 78° on May 29, 2026?", "high_temp")
    ).toEqual({ marketType: "bracket", bracketLow: 77.5, bracketHigh: 78.5 });
  });

  test("low_temp markets parse identically", () => {
    expect(
      parseBracketFromTitle("Will the **low temp in Chicago** be 20-21° on Mar 5, 2026?", "low_temp")
    ).toEqual({ marketType: "bracket", bracketLow: 19.5, bracketHigh: 21.5 });
  });

  test("negative temperatures", () => {
    expect(
      parseBracketFromTitle("Will the **low temp in Chicago** be -5--4° on Jan 5, 2026?", "low_temp")
    ).toEqual({ marketType: "bracket", bracketLow: -5.5, bracketHigh: -3.5 });
  });

  test("non-temperature categories return null (legacy parse keeps them)", () => {
    expect(
      parseBracketFromTitle("Will it rain 1-2 inches in Miami on Jun 15, 2026?", "precip")
    ).toBeNull();
  });

  test("unrecognized title returns null (caller falls back)", () => {
    expect(parseBracketFromTitle("Some unrelated market", "high_temp")).toBeNull();
  });
});

describe("parseTicker", () => {
  test("parses standard HIGH ticker", () => {
    const result = parseTicker("KXHIGHNY-25FEB19-B37");
    expect(result).toEqual({
      seriesTicker: "KXHIGHNY",
      eventTicker: "KXHIGHNY-25FEB19",
      targetDate: "2025-02-19",
      bracketLow: 37,
      isThreshold: false,
      stationId: "KNYC",
      category: "high_temp",
    });
  });

  test("parses LOW ticker", () => {
    const result = parseTicker("KXLOWCHI-25MAR05-B20");
    expect(result).toEqual({
      seriesTicker: "KXLOWCHI",
      eventTicker: "KXLOWCHI-25MAR05",
      targetDate: "2025-03-05",
      bracketLow: 20,
      isThreshold: false,
      stationId: "KORD",
      category: "low_temp",
    });
  });

  test("parses RAIN ticker", () => {
    const result = parseTicker("KXRAINMIA-25JUN15-B1");
    expect(result).toEqual({
      seriesTicker: "KXRAINMIA",
      eventTicker: "KXRAINMIA-25JUN15",
      targetDate: "2025-06-15",
      bracketLow: 1,
      isThreshold: false,
      stationId: "KMIA",
      category: "precip",
    });
  });

  test("parses SNOW ticker", () => {
    const result = parseTicker("KXSNOWPHL-25DEC25-B5");
    expect(result).toEqual({
      seriesTicker: "KXSNOWPHL",
      eventTicker: "KXSNOWPHL-25DEC25",
      targetDate: "2025-12-25",
      bracketLow: 5,
      isThreshold: false,
      stationId: "KPHL",
      category: "snowfall",
    });
  });

  test("parses decimal bracket (B51.5)", () => {
    const result = parseTicker("KXHIGHNY-25FEB19-B51.5");
    expect(result).not.toBeNull();
    expect(result!.bracketLow).toBe(51.5);
    expect(result!.isThreshold).toBe(false);
  });

  test("parses threshold ticker (T57)", () => {
    const result = parseTicker("KXHIGHNY-25FEB19-T57");
    expect(result).not.toBeNull();
    expect(result!.bracketLow).toBe(57);
    expect(result!.isThreshold).toBe(true);
  });

  test("returns null for fewer than 3 parts", () => {
    expect(parseTicker("KXHIGHNY-25FEB19")).toBeNull();
    expect(parseTicker("KXHIGHNY")).toBeNull();
  });

  test("returns null for invalid date component", () => {
    expect(parseTicker("KXHIGHNY-BADDATE-B37")).toBeNull();
    expect(parseTicker("KXHIGHNY-25XXX19-B37")).toBeNull();
  });

  test("returns stationId null for unknown station suffix", () => {
    const result = parseTicker("KXHIGHXYZ-25FEB19-B37");
    expect(result).not.toBeNull();
    expect(result!.stationId).toBeNull();
  });

  test("handles all 12 months", () => {
    const months = [
      "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
      "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
    ];
    for (let i = 0; i < months.length; i++) {
      const month = months[i]!;
      const expected = String(i + 1).padStart(2, "0");
      const result = parseTicker(`KXHIGHNY-25${month}15-B37`);
      expect(result).not.toBeNull();
      expect(result!.targetDate).toBe(`2025-${expected}-15`);
    }
  });
});
