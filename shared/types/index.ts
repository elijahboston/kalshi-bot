/** Climate market categories on Kalshi */
export type MarketCategory =
  | "high_temp"
  | "low_temp"
  | "precip"
  | "snowfall"
  | "wind"
  | "humidity";

/** Kalshi market series prefixes for climate */
export const CLIMATE_SERIES_PREFIXES = [
  "KXHIGH",   // Daily high temperature
  "KXLOW",    // Daily low temperature
  "KXRAIN",   // Daily precipitation
  "KXSNOW",   // Daily snowfall
] as const;

/** Map series prefix to category */
export function seriesCategory(seriesTicker: string): MarketCategory {
  if (seriesTicker.startsWith("KXHIGH")) return "high_temp";
  if (seriesTicker.startsWith("KXLOW")) return "low_temp";
  if (seriesTicker.startsWith("KXRAIN")) return "precip";
  if (seriesTicker.startsWith("KXSNOW")) return "snowfall";
  return "high_temp"; // fallback
}

/**
 * Map Kalshi city suffixes → ICAO station codes.
 * Kalshi uses city abbreviations (CHI, NY, MIA) not airport codes (ORD, JFK).
 */
const SUFFIX_TO_ICAO: Record<string, string> = {
  NY: "KNYC",
  CHI: "KORD",
  LAX: "KLAX",
  DFW: "KDFW",
  IAH: "KIAH",
  DEN: "KDEN",
  PHL: "KPHL",
  ATL: "KATL",
  SFO: "KSFO",
  MIA: "KMIA",
  AUS: "KAUS",
};

/** Reverse map: ICAO station code → series suffix */
const ICAO_TO_SUFFIX: Record<string, string> = Object.fromEntries(
  Object.entries(SUFFIX_TO_ICAO).map(([suffix, icao]) => [icao, suffix])
);

/** Extract station ID from a series ticker like KXHIGHNY → KNYC */
export function extractStationFromSeries(seriesTicker: string): string | null {
  // Convention: KXHIGH + station code suffix
  // KXHIGHNY → NY → KNYC, KXHIGHORD → ORD → KORD, etc.
  const match = seriesTicker.match(/^KX(?:HIGH|LOW|RAIN|SNOW)(.+?)(?:-|$)/);
  if (!match?.[1]) return null;
  return SUFFIX_TO_ICAO[match[1]] || null;
}

/**
 * Build full series tickers from prefixes × station ICAO codes.
 * e.g. ("KXHIGH", ["KNYC", "KORD"]) → ["KXHIGHNY", "KXHIGHORD"]
 */
export function buildSeriesTickers(
  prefixes: readonly string[],
  stationIcaos: string[]
): string[] {
  const tickers: string[] = [];
  for (const prefix of prefixes) {
    for (const icao of stationIcaos) {
      const suffix = ICAO_TO_SUFFIX[icao];
      if (suffix) {
        tickers.push(`${prefix}${suffix}`);
      }
    }
  }
  return tickers;
}

/** Celsius to Fahrenheit */
export function cToF(celsius: number): number {
  return celsius * 9 / 5 + 32;
}

/** Fahrenheit to Celsius */
export function fToC(fahrenheit: number): number {
  return (fahrenheit - 32) * 5 / 9;
}

/** Generate a sortable UUID v7 (monotonic, ideal for DB primary keys) */
export function uuid(): string {
  return Bun.randomUUIDv7();
}

/** ISO timestamp for now */
export function now(): string {
  return new Date().toISOString();
}
