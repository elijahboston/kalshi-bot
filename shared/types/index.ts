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

/** Extract station ID from a series ticker like KXHIGHNY → KNYC */
export function extractStationFromSeries(seriesTicker: string): string | null {
  // Convention: KXHIGH + station code suffix
  // KXHIGHNY → NY → KNYC, KXHIGHORD → ORD → KORD, etc.
  const match = seriesTicker.match(/^KX(?:HIGH|LOW|RAIN|SNOW)(.+?)(?:-|$)/);
  if (!match?.[1]) return null;

  // Map 2-3 letter suffixes to ICAO codes
  const SUFFIX_MAP: Record<string, string> = {
    NY: "KNYC",
    ORD: "KORD",
    LAX: "KLAX",
    DFW: "KDFW",
    IAH: "KIAH",
    DEN: "KDEN",
    PHL: "KPHL",
    ATL: "KATL",
    SFO: "KSFO",
    MIA: "KMIA",
  };

  return SUFFIX_MAP[match[1]] || null;
}

/** Celsius to Fahrenheit */
export function cToF(celsius: number): number {
  return celsius * 9 / 5 + 32;
}

/** Fahrenheit to Celsius */
export function fToC(fahrenheit: number): number {
  return (fahrenheit - 32) * 5 / 9;
}

/** Generate a UUID (uses crypto.randomUUID in Bun) */
export function uuid(): string {
  return crypto.randomUUID();
}

/** ISO timestamp for now */
export function now(): string {
  return new Date().toISOString();
}
