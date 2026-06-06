import { createLogger } from "@kcb/engine";

const log = createLogger("nws");

/**
 * IANA timezone per enabled station, used to resolve a station's LOCAL calendar
 * day for same-day observation windowing (N3, win-rate-80-addendum-2026-06-05.md
 * Finding 5 / item N3).
 *
 * Duplicated here on purpose: this module lives in @kcb/data, while
 * reconciliation.ts (@kcb/engine) and estimator.ts (@kcb/signals) each carry
 * their own copies. Importing from either would invert the dependency direction
 * (data must not depend on engine/signals). A future shared/ extraction is
 * welcome but out of scope for N3 — keep these three maps in sync by hand.
 */
const STATION_TZ: Record<string, string> = {
  KNYC: "America/New_York",
  KMIA: "America/New_York",
  KPHL: "America/New_York",
  KATL: "America/New_York",
  KORD: "America/Chicago",
  KAUS: "America/Chicago",
  KIAH: "America/Chicago",
  KDFW: "America/Chicago",
  KDEN: "America/Denver",
  KLAX: "America/Los_Angeles",
  KSFO: "America/Los_Angeles",
};

const DEFAULT_TZ = "America/New_York";

/** Resolve a station's IANA timezone, defaulting to US Eastern. */
function stationTz(stationId: string): string {
  return STATION_TZ[stationId] ?? DEFAULT_TZ;
}

/**
 * Station → NWS issuing office (WFO) for the CLI climate product (N1 item 2,
 * win-rate-80-addendum-2026-06-05.md Finding 11). The CLI product is fetched per
 * office (`/products/types/CLI/locations/{office}`); one office serves multiple
 * sites, so {@link CLI_SITE_CODE} filters the office's product list down to the
 * station we want. Hardcoded — these mappings are stable airport→WFO routings.
 */
const STATION_OFFICE: Record<string, string> = {
  KNYC: "OKX", // New York (Upton)
  KMIA: "MFL", // Miami
  KORD: "LOT", // Chicago
  KAUS: "EWX", // Austin/San Antonio (Austin)
  KDEN: "BOU", // Denver/Boulder
  KLAX: "LOX", // Los Angeles/Oxnard
  KPHL: "PHI", // Philadelphia/Mount Holly
  KATL: "FFC", // Atlanta/Peachtree City
  KSFO: "MTR", // San Francisco/Monterey
  KDFW: "FWD", // Dallas/Fort Worth
  KIAH: "HGX", // Houston/Galveston
};

/**
 * Station → 3-letter CLI site code embedded in the product text's `CLI<SITE>`
 * header line (e.g. `CLINYC`). An office's CLI product list contains reports for
 * several sites; we filter by this code before date-matching. Three letters =
 * the station id minus its leading `K`.
 */
const CLI_SITE_CODE: Record<string, string> = {
  KNYC: "NYC",
  KMIA: "MIA",
  KORD: "ORD",
  KAUS: "AUS",
  KDEN: "DEN",
  KLAX: "LAX",
  KPHL: "PHL",
  KATL: "ATL",
  KSFO: "SFO",
  KDFW: "DFW",
  KIAH: "IAH",
};

/** Month name → 1-based index, for parsing the CLI summary line's date. */
const MONTHS: Record<string, number> = {
  JANUARY: 1,
  FEBRUARY: 2,
  MARCH: 3,
  APRIL: 4,
  MAY: 5,
  JUNE: 6,
  JULY: 7,
  AUGUST: 8,
  SEPTEMBER: 9,
  OCTOBER: 10,
  NOVEMBER: 11,
  DECEMBER: 12,
};

/**
 * Official NWS CLI (Climate Report) values for one climate day — the LITERAL
 * source Kalshi settles temperature markets on (win-rate-80-addendum-2026-06-05.md
 * N1 item 2). Preferred over the settlement-interval midpoint (±1°F uniform
 * noise after the Finding-11 geometry fix) because it carries the exact value.
 */
export interface CliReport {
  /** Official maximum temperature (°F) for the climate day, or null if not in the product. */
  maxTempF: number | null;
  /** Official minimum temperature (°F). */
  minTempF: number | null;
  /** The local calendar date the report covers (YYYY-MM-DD). */
  reportDate: string;
  /** Product issuance timestamp (ISO). */
  issuedAt: string;
}

/**
 * Parse a fixed-width NWS CLI climate product into its report date + official
 * max/min temperatures. Pure + exported so it's testable on fixtures.
 *
 * The product opens with a `CLIMATE SUMMARY FOR <MONTH> <D> <YYYY>` line (the
 * climate day this report covers) and, under a `TEMPERATURE (F)` header, rows
 * like `MAXIMUM   87   3:24 PM ...` / `MINIMUM   66   5:51 AM ...`. We take the
 * FIRST integer token after `MAXIMUM` / `MINIMUM`. A value of `M` or `MM`
 * (missing) yields null for that field. `reportDate` is whatever the product
 * covers (null if the summary line is absent); the CALLER decides whether that
 * matches the target date — this function never rejects on date.
 */
export function parseCliProduct(text: string): {
  reportDate: string | null;
  maxTempF: number | null;
  minTempF: number | null;
} {
  const lines = text.split(/\r?\n/);

  // Report date from the "CLIMATE SUMMARY FOR <MONTH> <D> <YYYY>" line.
  let reportDate: string | null = null;
  const summaryRe = /CLIMATE\s+SUMMARY\s+FOR\s+([A-Z]+)\s+(\d{1,2})\s+(\d{4})/i;
  for (const line of lines) {
    const m = line.match(summaryRe);
    if (m) {
      const month = MONTHS[m[1]!.toUpperCase()];
      if (month) {
        const day = Number(m[2]);
        const year = Number(m[3]);
        reportDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
      break;
    }
  }

  // First integer (or M/MM missing token) after the MAXIMUM / MINIMUM label.
  // `M`/`MM` (missing data) and a bare label with no numeric → null.
  const tempAfter = (label: "MAXIMUM" | "MINIMUM"): number | null => {
    const re = new RegExp(`^\\s*${label}\\b(.*)$`, "i");
    for (const line of lines) {
      const m = line.match(re);
      if (!m) continue;
      const rest = m[1]!;
      // Missing-data sentinel before any digit ⇒ null.
      if (/^\s+MM?\b/.test(rest)) return null;
      const num = rest.match(/-?\d+/);
      return num ? Number(num[0]) : null;
    }
    return null;
  };

  return {
    reportDate,
    maxTempF: tempAfter("MAXIMUM"),
    minTempF: tempAfter("MINIMUM"),
  };
}

/** Celsius → Fahrenheit (matches the existing `* 9 / 5 + 32` convention in this file). */
function cToF(c: number): number {
  return c * 9 / 5 + 32;
}

/**
 * The UTC instant of the start (local midnight) of the calendar day that the
 * instant `dateNow` falls into, in IANA timezone `tz`.
 *
 * DST-correct: derives the local wall-clock day and offset from
 * `Intl.DateTimeFormat` parts rather than assuming a fixed UTC offset, so it
 * stays right across spring-forward / fall-back and for any station tz. Used to
 * build the `start` bound of the same-day observations query (N3) — for a US
 * Eastern station this lands on 04:00Z (EDT) or 05:00Z (EST); Pacific lands on
 * 07:00Z (PDT) / 08:00Z (PST).
 *
 * Exported so the windowing math is unit-testable in isolation.
 */
export function localDayStartUtc(dateNow: Date, tz: string): Date {
  // UTC offset (minutes) that `tz` applies to the instant `atUtcMs`. Positive
  // means local is BEHIND UTC (e.g. New_York = +240 EDT / +300 EST). Derived by
  // formatting the instant in `tz` and diffing the reported wall-clock from UTC.
  const offsetMinutes = (atUtcMs: number): number => {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(new Date(atUtcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    return (asUtc - atUtcMs) / 60000;
  };

  // The local calendar Y/M/D that `dateNow` falls into.
  const dayParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  }).formatToParts(dateNow);
  const dGet = (t: string) => Number(dayParts.find((p) => p.type === t)?.value);
  const y = dGet("year");
  const m = dGet("month");
  const d = dGet("day");

  // Resolve the UTC instant of that local midnight. Start from the naive UTC
  // guess, correct by the offset that applies at the guess; one pass is exact
  // except across the ~2 DST transitions/year, a second pass converges those.
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    const off = offsetMinutes(guess);
    const corrected = Date.UTC(y, m - 1, d, 0, 0, 0) - off * 60000;
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess);
}

/** NWS station to gridpoint mapping (cache on first lookup) */
const stationGridCache = new Map<string, { office: string; gridX: number; gridY: number }>();

/**
 * Known station coordinates for the climate markets we care about.
 * NWS uses these to route to the correct forecast office + grid.
 */
const STATION_COORDS: Record<string, { lat: number; lon: number }> = {
  KNYC: { lat: 40.7789, lon: -73.9692 },   // Central Park
  KORD: { lat: 41.9742, lon: -87.9073 },   // O'Hare
  KLAX: { lat: 33.9425, lon: -118.4081 },  // Los Angeles
  KDFW: { lat: 32.8998, lon: -97.0403 },   // Dallas-Fort Worth
  KIAH: { lat: 29.9844, lon: -95.3414 },   // Houston
  KDEN: { lat: 39.8561, lon: -104.6737 },  // Denver
  KPHL: { lat: 39.8719, lon: -75.2411 },   // Philadelphia
  KATL: { lat: 33.6407, lon: -84.4277 },   // Atlanta
  KSFO: { lat: 37.6213, lon: -122.3790 },  // San Francisco
  KMIA: { lat: 25.7959, lon: -80.2870 },   // Miami
};

/**
 * Aggregated view of a station's same-day observations for the obs running-max
 * anchor (N3). All temps are Fahrenheit.
 */
export interface TodayObservations {
  /** Max observed temp (°F) across today's local-calendar-day observations. A hard floor on the daily high. */
  runningMax: number;
  /** Latest (newest-timestamp) observation in the window. */
  latest: { tempF: number; timestamp: string };
  /** Minutes since the latest observation (computed against the `now` param for testability). */
  latestAgeMinutes: number;
  /** Number of usable (non-null temp) observations in the local-day window. */
  count: number;
}

export interface NwsForecastPeriod {
  number: number;
  name: string;
  startTime: string;
  endTime: string;
  temperature: number;
  temperatureUnit: string;
  windSpeed: string;
  shortForecast: string;
  detailedForecast: string;
}

export interface NwsGridForecast {
  temperature: { values: Array<{ validTime: string; value: number }> };
  maxTemperature: { values: Array<{ validTime: string; value: number }> };
  minTemperature: { values: Array<{ validTime: string; value: number }> };
  quantitativePrecipitation: { values: Array<{ validTime: string; value: number }> };
  snowfallAmount: { values: Array<{ validTime: string; value: number }> };
}

export class NwsService {
  private baseUrl = "https://api.weather.gov";
  private userAgent = "KalshiClimateBot/1.0 (contact@example.com)";

  /**
   * In-memory CLI cache keyed `${stationId}:${targetDate}` (value possibly null
   * = "looked up, not found"). The CLI report for a past climate day never
   * changes, so caching avoids refetching the office product list + texts on
   * every hourly resolution pass (N1 item 2). Process-lifetime; cleared on
   * restart.
   */
  private cliCache = new Map<string, CliReport | null>();

  private async fetch<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: "application/geo+json",
      },
    });

    if (!res.ok) {
      throw new Error(`NWS API error: ${res.status} ${await res.text()}`);
    }

    return res.json() as T;
  }

  /** Get the NWS grid point for a station ID */
  async getGridPoint(stationId: string) {
    const cached = stationGridCache.get(stationId);
    if (cached) return cached;

    const coords = STATION_COORDS[stationId];
    if (!coords) throw new Error(`Unknown station: ${stationId}`);

    const data = await this.fetch<{
      properties: { gridId: string; gridX: number; gridY: number };
    }>(`${this.baseUrl}/points/${coords.lat},${coords.lon}`);

    const result = {
      office: data.properties.gridId,
      gridX: data.properties.gridX,
      gridY: data.properties.gridY,
    };

    stationGridCache.set(stationId, result);
    log.info(`Resolved ${stationId} → ${result.office} (${result.gridX},${result.gridY})`);
    return result;
  }

  /** Get the 7-day forecast for a station */
  async getForecast(stationId: string): Promise<NwsForecastPeriod[]> {
    const grid = await this.getGridPoint(stationId);
    const data = await this.fetch<{
      properties: { periods: NwsForecastPeriod[] };
    }>(`${this.baseUrl}/gridpoints/${grid.office}/${grid.gridX},${grid.gridY}/forecast`);
    return data.properties.periods;
  }

  /** Get raw gridded forecast data (higher resolution, hourly values) */
  async getGridData(stationId: string): Promise<NwsGridForecast> {
    const grid = await this.getGridPoint(stationId);
    const data = await this.fetch<{
      properties: NwsGridForecast;
    }>(`${this.baseUrl}/gridpoints/${grid.office}/${grid.gridX},${grid.gridY}`);
    return data.properties;
  }

  /** Get recent observations from a station */
  async getObservations(stationId: string, limit = 24) {
    const data = await this.fetch<{
      features: Array<{
        properties: {
          timestamp: string;
          temperature: { value: number | null; unitCode: string };
          maxTemperatureLast24Hours: { value: number | null };
          minTemperatureLast24Hours: { value: number | null };
          precipitationLastHour: { value: number | null };
        };
      }>;
    }>(`${this.baseUrl}/stations/${stationId}/observations?limit=${limit}`);

    return data.features.map((f) => f.properties);
  }

  /**
   * Get the latest temperature observation for a station.
   * Returns the most recent non-null temperature reading in Fahrenheit,
   * or null if no recent observation is available.
   */
  async getLatestObservation(
    stationId: string
  ): Promise<{ tempF: number; timestamp: string } | null> {
    try {
      const observations = await this.getObservations(stationId, 6);

      for (const obs of observations) {
        if (obs.temperature?.value != null) {
          // NWS returns Celsius — convert to Fahrenheit
          const tempF = obs.temperature.value * 9 / 5 + 32;
          return { tempF, timestamp: obs.timestamp };
        }
      }

      return null;
    } catch (err) {
      log.debug(
        `Failed to get latest observation for ${stationId}: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }

  /**
   * Fetch ALL of today's observations over the station's LOCAL calendar day and
   * aggregate them for the obs running-max anchor (N3,
   * win-rate-80-addendum-2026-06-05.md Finding 5 / item N3).
   *
   * Unlike {@link getLatestObservation} (a single latest reading, no staleness
   * check), this returns:
   * - `runningMax` — the max observed temp so far today, a HARD FLOOR on the
   *   daily high (the estimator may truncate its distribution below it);
   * - `latest` + `latestAgeMinutes` — for the staleness guard (reject obs older
   *   than the configured max age);
   * - `count` — how many usable observations back the window.
   *
   * The window is `[localDayStart, now]`: local midnight (DST-correct via
   * {@link localDayStartUtc}) up to the `now` instant — never the prior local
   * evening (the UTC-day windowing bug that contaminated ground truth in N1).
   *
   * @param now Injectable clock (defaults to `new Date()`); also bounds the
   *   query's `end` and anchors `latestAgeMinutes` for deterministic tests.
   * @returns Aggregated observations, or `null` when zero usable observations.
   */
  async getTodayObservations(
    stationId: string,
    now: Date = new Date(),
  ): Promise<TodayObservations | null> {
    try {
      const tz = stationTz(stationId);
      const startUtc = localDayStartUtc(now, tz);

      const data = await this.fetch<{
        features: Array<{
          properties: {
            timestamp: string;
            temperature: { value: number | null; unitCode?: string };
          };
        }>;
      }>(
        `${this.baseUrl}/stations/${stationId}/observations` +
          `?start=${startUtc.toISOString()}&end=${now.toISOString()}&limit=100`,
      );

      const features = data.features ?? [];
      if (features.length === 0) return null;

      let runningMax = -Infinity;
      let latest: { tempF: number; timestamp: string } | null = null;
      let latestMs = -Infinity;
      let count = 0;

      for (const f of features) {
        const p = f.properties;
        const c = p.temperature?.value;
        if (c == null) continue;

        // NWS returns Celsius — convert to Fahrenheit.
        const tempF = cToF(c);
        count++;
        if (tempF > runningMax) runningMax = tempF;

        // Newest by timestamp (the feed is usually newest-first, but don't rely
        // on ordering — pick the max timestamp explicitly).
        const ts = Date.parse(p.timestamp);
        if (Number.isFinite(ts) && ts > latestMs) {
          latestMs = ts;
          latest = { tempF, timestamp: p.timestamp };
        }
      }

      if (count === 0 || latest == null) return null;

      const latestAgeMinutes = (now.getTime() - latestMs) / 60000;

      return { runningMax, latest, latestAgeMinutes, count };
    } catch (err) {
      log.debug(
        `Failed to get today's observations for ${stationId}: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }

  /**
   * Fetch + parse the official NWS CLI climate report for a station's climate
   * day (win-rate-80-addendum-2026-06-05.md N1 item 2). The CLI product is the
   * LITERAL source Kalshi settles temperature markets on, so its `MAXIMUM` /
   * `MINIMUM` are EXACT values — preferred over the settlement-interval midpoint
   * (±1°F uniform noise) and the obs-max fallback.
   *
   * Pipeline: station → issuing office ({@link STATION_OFFICE}); GET the office's
   * recent CLI list (`/products/types/CLI/locations/{office}`, newest first);
   * fetch the most recent few product texts (`/products/{id}`, field
   * `productText`); keep only products whose `CLI<SITE>` header matches the
   * station's {@link CLI_SITE_CODE}; pick the one whose parsed `reportDate`
   * equals `targetDate`. Result (including a not-found null) is memoized per
   * (station, date).
   *
   * Errors / unknown station / missing product → null, logged at debug. Never
   * throws.
   *
   * @param targetDate The climate day to resolve (YYYY-MM-DD).
   */
  async getCliReport(
    stationId: string,
    targetDate: string,
  ): Promise<CliReport | null> {
    const cacheKey = `${stationId}:${targetDate}`;
    const cached = this.cliCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const office = STATION_OFFICE[stationId];
    const siteCode = CLI_SITE_CODE[stationId];
    if (!office || !siteCode) {
      log.debug(`No CLI office/site mapping for ${stationId}`);
      this.cliCache.set(cacheKey, null);
      return null;
    }

    try {
      // Recent CLI products for the office, newest first.
      const list = await this.fetch<{
        "@graph"?: Array<{ id: string; issuanceTime: string }>;
      }>(`${this.baseUrl}/products/types/CLI/locations/${office}`);

      const entries = list["@graph"] ?? [];
      if (entries.length === 0) {
        this.cliCache.set(cacheKey, null);
        return null;
      }

      // Inspect the most recent few texts (one office issues daily CLIs for
      // several sites; the target day's report is near the top of the list).
      const LIMIT = 8;
      for (const entry of entries.slice(0, LIMIT)) {
        let product: { productText?: string; issuanceTime?: string };
        try {
          product = await this.fetch<{
            productText?: string;
            issuanceTime?: string;
          }>(`${this.baseUrl}/products/${entry.id}`);
        } catch (err) {
          log.debug(
            `Failed to fetch CLI product ${entry.id}: ${err instanceof Error ? err.message : err}`
          );
          continue;
        }

        const text = product.productText;
        if (!text) continue;

        // Filter to the station's CLI site (e.g. `CLINYC`) before date-matching.
        const siteRe = new RegExp(`\\bCLI${siteCode}\\b`);
        if (!siteRe.test(text)) continue;

        const parsed = parseCliProduct(text);
        if (parsed.reportDate !== targetDate) continue;

        const report: CliReport = {
          maxTempF: parsed.maxTempF,
          minTempF: parsed.minTempF,
          reportDate: parsed.reportDate,
          issuedAt: product.issuanceTime ?? entry.issuanceTime,
        };
        this.cliCache.set(cacheKey, report);
        return report;
      }

      this.cliCache.set(cacheKey, null);
      return null;
    } catch (err) {
      log.debug(
        `Failed to get CLI report for ${stationId} ${targetDate}: ${err instanceof Error ? err.message : err}`
      );
      // Do NOT cache a transient fetch failure — a later pass should retry.
      return null;
    }
  }
}
