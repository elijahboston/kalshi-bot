import { getDb, weatherForecasts, eq, and } from "@kcb/db";
import { getConfig } from "@kcb/config";
import { createLogger } from "@kcb/engine";
import { cToF, uuid, now } from "@kcb/shared";
import type { MarketCategory } from "@kcb/shared";

const log = createLogger("ensemble");

/** Station coordinates (duplicated from NWS for independence) */
const STATION_COORDS: Record<string, { lat: number; lon: number }> = {
  KNYC: { lat: 40.7789, lon: -73.9692 },
  KORD: { lat: 41.9742, lon: -87.9073 },
  KLAX: { lat: 33.9425, lon: -118.4081 },
  KDFW: { lat: 32.8998, lon: -97.0403 },
  KIAH: { lat: 29.9844, lon: -95.3414 },
  KDEN: { lat: 39.8561, lon: -104.6737 },
  KPHL: { lat: 39.8719, lon: -75.2411 },
  KATL: { lat: 33.6407, lon: -84.4277 },
  KSFO: { lat: 37.6213, lon: -122.379 },
  KMIA: { lat: 25.7959, lon: -80.287 },
  KAUS: { lat: 30.1945, lon: -97.6699 },
};

/** Map market category to Open-Meteo daily variable name */
const CATEGORY_TO_VARIABLE: Record<string, string> = {
  high_temp: "temperature_2m_max",
  low_temp: "temperature_2m_min",
  precip: "precipitation_sum",
  snowfall: "snowfall_sum",
};

/** Map market category to Tomorrow.io daily field names */
const CATEGORY_TO_TOMORROW: Record<string, string> = {
  high_temp: "temperatureMax",
  low_temp: "temperatureMin",
  precip: "rainAccumulation",
  snowfall: "snowAccumulation",
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class EnsembleService {
  /**
   * Get ensemble forecast values for a station/date/category.
   * Returns values in US units (F for temp, inches for precip/snow).
   * Checks DB cache first, falls back to Open-Meteo API.
   */
  async getEnsembleValues(
    stationId: string,
    targetDate: string,
    category: MarketCategory
  ): Promise<number[]> {
    const forecastType = category;

    // Check cache
    const cached = await this.getCached(stationId, targetDate, forecastType);
    if (cached) {
      log.debug(`Cache hit for ${stationId} ${targetDate} ${forecastType}`);
      return cached;
    }

    // Fetch from Open-Meteo (primary ensemble source)
    let values: number[] = [];
    try {
      values = await this.fetchOpenMeteo(stationId, targetDate, category);
      log.info(
        `Fetched ${values.length} ensemble members from Open-Meteo for ${stationId} ${targetDate}`
      );
    } catch (err) {
      log.warn(
        `Open-Meteo failed for ${stationId}: ${err instanceof Error ? err.message : err}`
      );
    }

    // Augment with Tomorrow.io point forecast (adds independent model opinion)
    try {
      const tomorrowValues = await this.fetchTomorrowIo(stationId, targetDate, category);
      if (tomorrowValues.length > 0) {
        values.push(...tomorrowValues);
        log.info(
          `Added ${tomorrowValues.length} value(s) from Tomorrow.io for ${stationId} ${targetDate}`
        );
      }
    } catch (err) {
      log.debug(
        `Tomorrow.io unavailable for ${stationId}: ${err instanceof Error ? err.message : err}`
      );
    }

    if (values.length > 0) {
      await this.cacheValues(stationId, targetDate, forecastType, values);
      return values;
    }

    // All APIs failed — fall back to NWS synthetic
    log.warn(`All forecast APIs failed for ${stationId} ${targetDate}, falling back to NWS synthetic`);
    return this.syntheticFallback(stationId, targetDate, category);
  }

  private async getCached(
    stationId: string,
    targetDate: string,
    forecastType: string
  ): Promise<number[] | null> {
    const db = getDb();
    const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();

    const rows = await db
      .select()
      .from(weatherForecasts)
      .where(
        and(
          eq(weatherForecasts.stationId, stationId),
          eq(weatherForecasts.targetDate, targetDate),
          eq(weatherForecasts.source, "multi_ensemble"),
          eq(weatherForecasts.forecastType, forecastType)
        )
      )
      .limit(1);

    const row = rows[0];
    if (!row || !row.ensembleValues) return null;
    if (row.fetchedAt < cutoff) return null; // Stale

    try {
      return JSON.parse(row.ensembleValues) as number[];
    } catch {
      return null;
    }
  }

  private async fetchOpenMeteo(
    stationId: string,
    targetDate: string,
    category: MarketCategory
  ): Promise<number[]> {
    const coords = STATION_COORDS[stationId];
    if (!coords) throw new Error(`Unknown station: ${stationId}`);

    const variable = CATEGORY_TO_VARIABLE[category];
    if (!variable) throw new Error(`Unknown category: ${category}`);

    const url =
      `https://ensemble-api.open-meteo.com/v1/ensemble` +
      `?latitude=${coords.lat}&longitude=${coords.lon}` +
      `&daily=${variable}` +
      `&models=gfs_seamless,icon_seamless,ecmwf_ifs025` +
      `&forecast_days=7` +
      `&temperature_unit=celsius` +
      `&precipitation_unit=mm`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      daily: Record<string, (number | null)[]>;
    };

    // Find the date index
    const dates = data.daily.time as unknown as string[];
    const dateIdx = dates?.indexOf(targetDate);
    if (dateIdx === undefined || dateIdx === -1) {
      throw new Error(
        `Target date ${targetDate} not in forecast range (available: ${dates?.join(", ")})`
      );
    }

    // Collect ensemble member values: keys like temperature_2m_max_member01, ...member30
    const memberPattern = new RegExp(`^${variable}_member\\d+`);
    const values: number[] = [];

    for (const [key, arr] of Object.entries(data.daily)) {
      if (!memberPattern.test(key)) continue;
      const val = (arr as (number | null)[])[dateIdx];
      if (val == null) continue;
      values.push(this.convertUnits(val, category));
    }

    if (values.length === 0) {
      throw new Error(`No ensemble members found for ${variable} at ${targetDate}`);
    }

    return values;
  }

  /**
   * Fetch point forecast from Tomorrow.io and return as pseudo-ensemble values.
   * Tomorrow.io provides a single deterministic forecast per model run,
   * which we treat as an independent model opinion alongside Open-Meteo's
   * ensemble members. Returns a small array of values (typically 1-2 per
   * forecast day) to avoid over-weighting a single source.
   */
  async fetchTomorrowIo(
    stationId: string,
    targetDate: string,
    category: MarketCategory
  ): Promise<number[]> {
    // Read API key from config, falling back to env var directly.
    // The fallback handles the case where @kcb/config is mocked in tests.
    let apiKey: string | undefined;
    try {
      apiKey = getConfig().weather.tomorrowIoApiKey;
    } catch {
      apiKey = process.env.TOMORROW_IO_API_KEY;
    }
    if (!apiKey) return [];

    const coords = STATION_COORDS[stationId];
    if (!coords) return [];

    const field = CATEGORY_TO_TOMORROW[category];
    if (!field) return [];

    const url =
      `https://api.tomorrow.io/v4/weather/forecast` +
      `?location=${coords.lat},${coords.lon}` +
      `&timesteps=1d` +
      `&units=imperial` +
      `&apikey=${apiKey}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Tomorrow.io ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      timelines: {
        daily: Array<{
          time: string;
          values: Record<string, number | null>;
        }>;
      };
    };

    const values: number[] = [];
    for (const day of data.timelines?.daily ?? []) {
      // Match target date (Tomorrow.io returns ISO timestamps)
      if (!day.time.startsWith(targetDate)) continue;
      const val = day.values[field];
      if (val != null) values.push(val);
    }

    if (values.length > 0) {
      // Cache the Tomorrow.io point forecast separately for bias tracking
      const db = getDb();
      const horizon = Math.ceil(
        (new Date(targetDate).getTime() - Date.now()) / 86400_000
      );
      await db
        .delete(weatherForecasts)
        .where(
          and(
            eq(weatherForecasts.stationId, stationId),
            eq(weatherForecasts.targetDate, targetDate),
            eq(weatherForecasts.source, "tomorrow_io"),
            eq(weatherForecasts.forecastType, category)
          )
        );
      await db.insert(weatherForecasts).values({
        id: uuid(),
        stationId,
        targetDate,
        source: "tomorrow_io",
        forecastType: category,
        forecastHorizon: Math.max(1, horizon),
        pointForecast: values[0]!,
        ensembleValues: null,
        ensembleSize: null,
        ensembleMean: null,
        ensembleStd: null,
        fetchedAt: now(),
      });
    }

    return values;
  }

  /** Convert metric values to US customary units */
  private convertUnits(value: number, category: MarketCategory): number {
    switch (category) {
      case "high_temp":
      case "low_temp":
        return cToF(value);
      case "precip":
        return value / 25.4; // mm → inches
      case "snowfall":
        return value / 2.54; // cm → inches
      default:
        return value;
    }
  }

  private async cacheValues(
    stationId: string,
    targetDate: string,
    forecastType: string,
    values: number[]
  ): Promise<void> {
    const db = getDb();
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    const horizon = Math.ceil(
      (new Date(targetDate).getTime() - Date.now()) / 86400_000
    );

    const id = uuid();
    const timestamp = now();

    // Delete old cache entry if exists
    await db
      .delete(weatherForecasts)
      .where(
        and(
          eq(weatherForecasts.stationId, stationId),
          eq(weatherForecasts.targetDate, targetDate),
          eq(weatherForecasts.source, "multi_ensemble"),
          eq(weatherForecasts.forecastType, forecastType)
        )
      );

    await db.insert(weatherForecasts).values({
      id,
      stationId,
      targetDate,
      source: "multi_ensemble",
      forecastType,
      forecastHorizon: Math.max(1, horizon),
      pointForecast: mean,
      ensembleValues: JSON.stringify(values),
      ensembleSize: values.length,
      ensembleMean: mean,
      ensembleStd: std,
      fetchedAt: timestamp,
    });
  }

  /**
   * Fallback: fetch NWS point forecast and generate synthetic ensemble
   * using a normal distribution around the point forecast.
   */
  private async syntheticFallback(
    stationId: string,
    targetDate: string,
    category: MarketCategory
  ): Promise<number[]> {
    // Try to get NWS point forecast
    let pointForecast: number | null = null;

    try {
      const coords = STATION_COORDS[stationId];
      if (coords) {
        const pointsRes = await fetch(
          `https://api.weather.gov/points/${coords.lat},${coords.lon}`,
          { headers: { "User-Agent": "KalshiClimateBot/1.0" } }
        );
        if (pointsRes.ok) {
          const pointsData = (await pointsRes.json()) as {
            properties: { gridId: string; gridX: number; gridY: number };
          };
          const { gridId, gridX, gridY } = pointsData.properties;

          const gridRes = await fetch(
            `https://api.weather.gov/gridpoints/${gridId}/${gridX},${gridY}`,
            { headers: { "User-Agent": "KalshiClimateBot/1.0" } }
          );
          if (gridRes.ok) {
            const gridData = (await gridRes.json()) as {
              properties: Record<
                string,
                { values: Array<{ validTime: string; value: number }> }
              >;
            };
            const propKey =
              category === "high_temp"
                ? "maxTemperature"
                : category === "low_temp"
                  ? "minTemperature"
                  : category === "precip"
                    ? "quantitativePrecipitation"
                    : "snowfallAmount";

            const vals = gridData.properties[propKey]?.values;
            if (vals) {
              // Find value closest to target date
              for (const v of vals) {
                const period = v.validTime.split("/")[0]!;
                if (period.startsWith(targetDate)) {
                  // NWS grid data is in SI (Celsius, mm, etc.)
                  pointForecast = this.convertUnits(v.value, category);
                  break;
                }
              }
            }
          }
        }
      }
    } catch {
      // Ignore NWS errors in fallback path
    }

    if (pointForecast == null) {
      // Last resort: use a generic value
      pointForecast =
        category === "high_temp"
          ? 50
          : category === "low_temp"
            ? 35
            : category === "precip"
              ? 0.1
              : 0;
    }

    const isPrecip = category === "precip" || category === "snowfall";

    // Generate synthetic ensemble
    const stdDev =
      category === "high_temp" || category === "low_temp"
        ? 3 // 3 deg F
        : category === "precip"
          ? 0.15 // inches
          : 1; // snowfall inches

    const synthetic: number[] = [];
    for (let i = 0; i < 31; i++) {
      // Box-Muller transform
      const u1 = Math.random();
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      let value = pointForecast + z * stdDev;
      // Precip/snow can't be negative
      if (isPrecip) value = Math.max(0, value);
      synthetic.push(value);
    }

    log.info(
      `Synthetic fallback for ${stationId} ${targetDate}: mean=${pointForecast.toFixed(1)}, std=${stdDev}`
    );

    // Cache the synthetic values too
    await this.cacheValues(stationId, targetDate, category, synthetic);

    return synthetic;
  }
}
