import { test, expect, describe } from "bun:test";
import { parseTicker } from "./discovery";

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
