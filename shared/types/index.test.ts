import { test, expect, describe } from "bun:test";
import {
  seriesCategory,
  extractStationFromSeries,
  buildSeriesTickers,
  cToF,
  fToC,
  uuid,
  now,
} from "./index";

describe("seriesCategory", () => {
  test("maps KXHIGH prefix to high_temp", () => {
    expect(seriesCategory("KXHIGHNY")).toBe("high_temp");
  });

  test("maps KXLOW prefix to low_temp", () => {
    expect(seriesCategory("KXLOWCHI")).toBe("low_temp");
  });

  test("maps KXRAIN prefix to precip", () => {
    expect(seriesCategory("KXRAINLAX")).toBe("precip");
  });

  test("maps KXSNOW prefix to snowfall", () => {
    expect(seriesCategory("KXSNOWPHL")).toBe("snowfall");
  });

  test("falls back to high_temp for unknown prefix", () => {
    expect(seriesCategory("KXWIND")).toBe("high_temp");
    expect(seriesCategory("UNKNOWN")).toBe("high_temp");
  });
});

describe("extractStationFromSeries", () => {
  test("extracts NY → KNYC", () => {
    expect(extractStationFromSeries("KXHIGHNY")).toBe("KNYC");
  });

  test("extracts CHI → KORD", () => {
    expect(extractStationFromSeries("KXLOWCHI")).toBe("KORD");
  });

  test("extracts MIA → KMIA", () => {
    expect(extractStationFromSeries("KXRAINMIA")).toBe("KMIA");
  });

  test("works with ticker that has dash suffix", () => {
    expect(extractStationFromSeries("KXHIGHNY-25FEB19")).toBe("KNYC");
  });

  test("returns null for unknown suffix", () => {
    expect(extractStationFromSeries("KXHIGHXYZ")).toBeNull();
  });

  test("returns null for non-matching format", () => {
    expect(extractStationFromSeries("INVALID")).toBeNull();
  });
});

describe("buildSeriesTickers", () => {
  test("builds cross-product of prefixes × stations", () => {
    const result = buildSeriesTickers(["KXHIGH"], ["KNYC", "KORD"]);
    expect(result).toEqual(["KXHIGHNY", "KXHIGHCHI"]);
  });

  test("multiple prefixes × multiple stations", () => {
    const result = buildSeriesTickers(["KXHIGH", "KXLOW"], ["KNYC"]);
    expect(result).toEqual(["KXHIGHNY", "KXLOWNY"]);
  });

  test("skips unknown ICAO codes", () => {
    const result = buildSeriesTickers(["KXHIGH"], ["KNYC", "XXXX"]);
    expect(result).toEqual(["KXHIGHNY"]);
  });

  test("returns empty array when no valid ICAOs", () => {
    const result = buildSeriesTickers(["KXHIGH"], ["XXXX"]);
    expect(result).toEqual([]);
  });

  test("returns empty array for empty inputs", () => {
    expect(buildSeriesTickers([], ["KNYC"])).toEqual([]);
    expect(buildSeriesTickers(["KXHIGH"], [])).toEqual([]);
  });
});

describe("cToF", () => {
  test("converts 0°C to 32°F", () => {
    expect(cToF(0)).toBe(32);
  });

  test("converts 100°C to 212°F", () => {
    expect(cToF(100)).toBe(212);
  });

  test("converts negative temperatures", () => {
    expect(cToF(-40)).toBe(-40); // -40 is the same in both scales
  });
});

describe("fToC", () => {
  test("converts 32°F to 0°C", () => {
    expect(fToC(32)).toBe(0);
  });

  test("converts 212°F to 100°C", () => {
    expect(fToC(212)).toBe(100);
  });

  test("converts -40°F to -40°C", () => {
    expect(fToC(-40)).toBe(-40);
  });
});

describe("cToF / fToC roundtrip", () => {
  test("roundtrip preserves value", () => {
    for (const temp of [0, 25, -10, 37.5, 100]) {
      expect(fToC(cToF(temp))).toBeCloseTo(temp, 10);
    }
  });
});

describe("uuid", () => {
  test("returns a valid UUID v7 format", () => {
    const id = uuid();
    // UUIDv7: version nibble is 7, variant is 8/9/a/b
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  test("returns unique values", () => {
    const a = uuid();
    const b = uuid();
    expect(a).not.toBe(b);
  });

  test("is monotonically sortable", () => {
    const a = uuid();
    const b = uuid();
    // UUIDv7 embeds timestamp — later IDs sort after earlier ones
    expect(a < b).toBe(true);
  });
});

describe("now", () => {
  test("returns a valid ISO 8601 string", () => {
    const ts = now();
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  test("returns a recent timestamp", () => {
    const before = Date.now();
    const ts = now();
    const after = Date.now();
    const parsed = new Date(ts).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});
