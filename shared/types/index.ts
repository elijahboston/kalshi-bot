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
  "KXHIGH",    // Daily high temperature
  "KXLOW",     // Daily low temperature
  "KXRAIN",    // Daily precipitation / monthly rain day count
  "KXSNOW",    // Daily snowfall
] as const;

/**
 * Some Kalshi series append M to the city suffix for monthly markets.
 * e.g. rain series for Chicago = KXRAINCHIM (not KXRAINCHI).
 * This map defines which prefixes use the M-suffixed city codes.
 */
const MONTHLY_SERIES_PREFIXES = new Set(["KXRAIN"]);

/** Map series prefix to category */
export function seriesCategory(seriesTicker: string): MarketCategory {
  if (seriesTicker.startsWith("KXHIGH")) return "high_temp";
  if (seriesTicker.startsWith("KXLOW")) return "low_temp";
  if (seriesTicker.startsWith("KXRAINM")) return "precip";
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
  // Monthly rain series use city+M suffix (e.g. CHIM, LAXM)
  CHIM: "KORD",
  LAXM: "KLAX",
  MIAM: "KMIA",
  DENM: "KDEN",
  AUSM: "KAUS",
  NYM: "KNYC",
};

/** Reverse map: ICAO station code → base series suffix (excludes M variants) */
const ICAO_TO_SUFFIX: Record<string, string> = Object.fromEntries(
  Object.entries(SUFFIX_TO_ICAO)
    .filter(([suffix]) => !suffix.endsWith("M"))
    .map(([suffix, icao]) => [icao, suffix])
);

/** Extract station ID from a series ticker like KXHIGHNY → KNYC */
export function extractStationFromSeries(seriesTicker: string): string | null {
  // Convention: KX{PREFIX}{SUFFIX} where suffix maps to ICAO
  // KXHIGHNY → NY → KNYC, KXRAINCHIM → CHIM → KORD, etc.
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
        // Also emit monthly variant (e.g. KXRAINCHIM) for prefixes that use it
        if (MONTHLY_SERIES_PREFIXES.has(prefix)) {
          tickers.push(`${prefix}${suffix}M`);
        }
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

/**
 * The win-rate-80 regime boundary: the first trade after the 2026-06-05
 * strategy redirection (entry gates, confirmation mode, event-coherent
 * estimation, geometry fix, ground-truth repair). Trades and signals BEFORE
 * this instant measure the old, broken bot — rolling-window analytics that
 * feed live decisions (e.g. the station-health gate) must clamp their window
 * start to this boundary or they will act on the old regime's statistics.
 * See docs/improvements/win-rate-80-plan-2026-06-05.md.
 */
export const REGIME_BOUNDARY_ISO = "2026-06-05T20:00:00.000Z";
