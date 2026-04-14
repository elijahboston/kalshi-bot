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
const HRRR_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (matches HRRR run frequency)

/** Map market category to Open-Meteo hourly variable name (for HRRR) */
const CATEGORY_TO_HOURLY: Record<string, string> = {
  high_temp: "temperature_2m",
  low_temp: "temperature_2m",
  precip: "precipitation",
  snowfall: "snowfall",
};

/**
 * Model weight profiles by forecast horizon bucket.
 * Keys are model group identifiers parsed from Open-Meteo member keys.
 * Values are relative weights (will be normalized).
 */
const MODEL_WEIGHTS: Record<string, Record<string, number>> = {
  // < 6h: HRRR dominates
  "0-6": { hrrr: 70, gfs: 15, ecmwf: 15, icon: 0, gem: 0, arpege: 0, other: 0 },
  // 6-18h: HRRR still strong, ensembles gain
  "6-18": { hrrr: 40, gfs: 30, ecmwf: 30, icon: 0, gem: 0, arpege: 0, other: 0 },
  // 18h-3d: ensemble models dominate
  "18-72": { hrrr: 0, gfs: 35, ecmwf: 35, icon: 15, gem: 7, arpege: 8, other: 0 },
  // 3d+: equal weights
  "72+": { hrrr: 0, gfs: 20, ecmwf: 20, icon: 20, gem: 20, arpege: 20, other: 0 },
};

/** Classify an Open-Meteo member key to a model group */
function classifyModel(memberKey: string): string {
  const key = memberKey.toLowerCase();
  if (key.includes("gfs") || key.includes("ncep") || key.includes("gefs")) return "gfs";
  if (key.includes("ecmwf") || key.includes("ifs")) return "ecmwf";
  if (key.includes("icon")) return "icon";
  if (key.includes("gem")) return "gem";
  if (key.includes("arpege")) return "arpege";
  return "other";
}

/** Get the horizon bucket key for MODEL_WEIGHTS */
function getHorizonBucket(horizonHours: number): string {
  if (horizonHours < 6) return "0-6";
  if (horizonHours < 18) return "6-18";
  if (horizonHours < 72) return "18-72";
  return "72+";
}

export class EnsembleService {
  /**
   * Get ensemble forecast values for a station/date/category.
   * Returns values in US units (F for temp, inches for precip/snow).
   * Checks DB cache first, falls back to Open-Meteo API.
   *
   * @param forecastHorizonHours Hours until market close. When provided,
   *   enables HRRR ingestion (<48h) and horizon-weighted model blending.
   */
  async getEnsembleValues(
    stationId: string,
    targetDate: string,
    category: MarketCategory,
    forecastHorizonHours?: number
  ): Promise<number[]> {
    const forecastType = category;
    const horizonHours = forecastHorizonHours ?? this.estimateHorizonHours(targetDate);

    // Check ensemble cache
    const cached = await this.getCached(stationId, targetDate, forecastType);
    if (cached) {
      log.debug(`Cache hit for ${stationId} ${targetDate} ${forecastType}`);
      // Even with cached ensemble, still fetch fresh HRRR if within range
      if (horizonHours <= 48) {
        const hrrrCached = await this.getCached(stationId, targetDate, `${forecastType}_hrrr`, HRRR_CACHE_TTL_MS);
        if (!hrrrCached) {
          const blended = await this.blendWithHrrr(cached, stationId, targetDate, category, horizonHours);
          return blended;
        }
        // HRRR also cached — blend cached values
        return this.applyBlending(cached, "ensemble", hrrrCached, horizonHours);
      }
      return cached;
    }

    // Fetch from Open-Meteo (primary ensemble source) with model tagging
    let taggedMembers: Array<{ value: number; model: string }> = [];
    try {
      taggedMembers = await this.fetchOpenMeteoTagged(stationId, targetDate, category);
      log.info(
        `Fetched ${taggedMembers.length} ensemble members from Open-Meteo for ${stationId} ${targetDate}`
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
        for (const v of tomorrowValues) {
          taggedMembers.push({ value: v, model: "other" });
        }
        log.info(
          `Added ${tomorrowValues.length} value(s) from Tomorrow.io for ${stationId} ${targetDate}`
        );
      }
    } catch (err) {
      log.debug(
        `Tomorrow.io unavailable for ${stationId}: ${err instanceof Error ? err.message : err}`
      );
    }

    // Fetch HRRR if within range
    let hrrrValues: number[] = [];
    if (horizonHours <= 48) {
      try {
        hrrrValues = await this.fetchHrrr(stationId, targetDate, category);
        if (hrrrValues.length > 0) {
          log.info(
            `Fetched ${hrrrValues.length} HRRR value(s) for ${stationId} ${targetDate} (horizon=${horizonHours.toFixed(0)}h)`
          );
          // Cache HRRR separately with shorter TTL
          await this.cacheValues(stationId, targetDate, `${forecastType}_hrrr`, hrrrValues, HRRR_CACHE_TTL_MS);
        }
      } catch (err) {
        log.debug(
          `HRRR unavailable for ${stationId}: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    if (taggedMembers.length > 0 || hrrrValues.length > 0) {
      // Apply horizon-weighted blending
      const blended = this.blendMembers(taggedMembers, hrrrValues, horizonHours);
      await this.cacheValues(stationId, targetDate, forecastType, blended);
      return blended;
    }

    // All APIs failed — fall back to NWS synthetic
    log.warn(`All forecast APIs failed for ${stationId} ${targetDate}, falling back to NWS synthetic`);
    return this.syntheticFallback(stationId, targetDate, category);
  }

  private async getCached(
    stationId: string,
    targetDate: string,
    forecastType: string,
    ttlMs: number = CACHE_TTL_MS
  ): Promise<number[] | null> {
    const db = getDb();
    const cutoff = new Date(Date.now() - ttlMs).toISOString();

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

  /** Estimate horizon in hours from target date (fallback when not provided) */
  private estimateHorizonHours(targetDate: string): number {
    const target = new Date(targetDate + "T23:59:00Z"); // close-of-day as proxy
    return Math.max(0, (target.getTime() - Date.now()) / (1000 * 60 * 60));
  }

  /**
   * Fetch HRRR deterministic forecast from Open-Meteo.
   * HRRR covers 0-48h at 3km resolution, updated hourly.
   * Returns 1-2 values (one per forecast day within range).
   */
  async fetchHrrr(
    stationId: string,
    targetDate: string,
    category: MarketCategory
  ): Promise<number[]> {
    const coords = STATION_COORDS[stationId];
    if (!coords) return [];

    const hourlyVar = CATEGORY_TO_HOURLY[category];
    if (!hourlyVar) return [];

    // HRRR via Open-Meteo regular forecast API (deterministic model)
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${coords.lat}&longitude=${coords.lon}` +
      `&hourly=${hourlyVar}` +
      `&models=hrrr_conus` +
      `&forecast_days=2` +
      `&temperature_unit=celsius` +
      `&precipitation_unit=mm`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HRRR Open-Meteo ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      hourly: { time: string[]; [key: string]: (number | null)[] | string[] };
    };

    const times = data.hourly?.time as string[] | undefined;
    const vals = data.hourly?.[hourlyVar] as (number | null)[] | undefined;
    if (!times || !vals) return [];

    // Filter to hours matching the target date
    const dayValues: number[] = [];
    for (let i = 0; i < times.length; i++) {
      if (times[i].startsWith(targetDate) && vals[i] != null) {
        dayValues.push(vals[i]!);
      }
    }

    if (dayValues.length === 0) return [];

    // Aggregate to daily value matching the category
    let result: number;
    switch (category) {
      case "high_temp":
        result = this.convertUnits(Math.max(...dayValues), category);
        break;
      case "low_temp":
        result = this.convertUnits(Math.min(...dayValues), category);
        break;
      case "precip":
      case "snowfall":
        // Sum hourly accumulation for the day
        result = this.convertUnits(
          dayValues.reduce((a, b) => a + b, 0),
          category
        );
        break;
      default:
        result = this.convertUnits(dayValues[0], category);
    }

    return [result];
  }

  /**
   * Fetch Open-Meteo ensemble members with model source tagging.
   * Same as fetchOpenMeteo but returns tagged values for blending.
   */
  private async fetchOpenMeteoTagged(
    stationId: string,
    targetDate: string,
    category: MarketCategory
  ): Promise<Array<{ value: number; model: string }>> {
    const coords = STATION_COORDS[stationId];
    if (!coords) throw new Error(`Unknown station: ${stationId}`);

    const variable = CATEGORY_TO_VARIABLE[category];
    if (!variable) throw new Error(`Unknown category: ${category}`);

    const url =
      `https://ensemble-api.open-meteo.com/v1/ensemble` +
      `?latitude=${coords.lat}&longitude=${coords.lon}` +
      `&daily=${variable}` +
      `&models=gfs_seamless,icon_seamless,ecmwf_ifs025,arpege_seamless,gem_seamless` +
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

    const dates = data.daily.time as unknown as string[];
    const dateIdx = dates?.indexOf(targetDate);
    if (dateIdx === undefined || dateIdx === -1) {
      throw new Error(
        `Target date ${targetDate} not in forecast range (available: ${dates?.join(", ")})`
      );
    }

    const memberPattern = new RegExp(`^${variable}_member\\d+`);
    const tagged: Array<{ value: number; model: string }> = [];

    for (const [key, arr] of Object.entries(data.daily)) {
      if (!memberPattern.test(key)) continue;
      const val = (arr as (number | null)[])[dateIdx];
      if (val == null) continue;
      tagged.push({
        value: this.convertUnits(val, category),
        model: classifyModel(key),
      });
    }

    if (tagged.length === 0) {
      throw new Error(`No ensemble members found for ${variable} at ${targetDate}`);
    }

    return tagged;
  }

  /**
   * Apply horizon-weighted blending to tagged ensemble members + HRRR values.
   * Duplicates members proportionally based on model weights for the given horizon.
   */
  blendMembers(
    taggedMembers: Array<{ value: number; model: string }>,
    hrrrValues: number[],
    horizonHours: number
  ): number[] {
    const bucket = getHorizonBucket(horizonHours);
    const weights = MODEL_WEIGHTS[bucket];

    // Count members per model group
    const modelCounts = new Map<string, number>();
    for (const m of taggedMembers) {
      modelCounts.set(m.model, (modelCounts.get(m.model) || 0) + 1);
    }

    // Compute total weight of models that actually have members
    let totalWeight = 0;
    for (const [model, count] of modelCounts) {
      if (count > 0) totalWeight += (weights[model] ?? weights.other ?? 0);
    }
    if (hrrrValues.length > 0) totalWeight += weights.hrrr;

    if (totalWeight === 0) {
      // No weighting info — return raw values
      return [...taggedMembers.map((m) => m.value), ...hrrrValues];
    }

    const result: number[] = [];

    // Add ensemble members weighted by model
    for (const m of taggedMembers) {
      const modelWeight = weights[m.model] ?? weights.other ?? 0;
      const count = modelCounts.get(m.model) || 1;
      // Each member contributes: (modelWeight / totalWeight) * targetPoolSize / count
      // Simplified: just include each member once (blending preserves distribution)
      // The weighting happens via duplication
      const targetMembers = Math.max(1, Math.round((modelWeight / totalWeight) * 100));
      const duplication = Math.max(1, Math.round(targetMembers / count));
      for (let i = 0; i < duplication; i++) {
        result.push(m.value);
      }
    }

    // Add HRRR values with appropriate weighting
    if (hrrrValues.length > 0 && weights.hrrr > 0) {
      const hrrrTarget = Math.max(1, Math.round((weights.hrrr / totalWeight) * 100));
      const hrrrDup = Math.max(1, Math.round(hrrrTarget / hrrrValues.length));
      for (const v of hrrrValues) {
        for (let i = 0; i < hrrrDup; i++) {
          result.push(v);
        }
      }
    }

    return result;
  }

  /**
   * Blend existing cached ensemble values with freshly-fetched HRRR.
   */
  private async blendWithHrrr(
    cachedEnsemble: number[],
    stationId: string,
    targetDate: string,
    category: MarketCategory,
    horizonHours: number
  ): Promise<number[]> {
    let hrrrValues: number[] = [];
    try {
      hrrrValues = await this.fetchHrrr(stationId, targetDate, category);
      if (hrrrValues.length > 0) {
        await this.cacheValues(stationId, targetDate, `${category}_hrrr`, hrrrValues, HRRR_CACHE_TTL_MS);
      }
    } catch (err) {
      log.debug(`HRRR fetch failed during blend: ${err instanceof Error ? err.message : err}`);
    }
    return this.applyBlending(cachedEnsemble, "ensemble", hrrrValues, horizonHours);
  }

  /**
   * Apply blending between ensemble values and HRRR values based on horizon.
   */
  applyBlending(
    ensembleValues: number[],
    _source: string,
    hrrrValues: number[],
    horizonHours: number
  ): number[] {
    if (hrrrValues.length === 0) return ensembleValues;

    const bucket = getHorizonBucket(horizonHours);
    const weights = MODEL_WEIGHTS[bucket];
    const hrrrWeight = weights.hrrr;
    const ensembleWeight = 100 - hrrrWeight;

    if (hrrrWeight === 0) return ensembleValues;

    const result = [...ensembleValues];

    // Duplicate HRRR values to achieve target weight ratio
    const hrrrTarget = Math.max(
      1,
      Math.round((hrrrWeight / ensembleWeight) * ensembleValues.length)
    );
    const hrrrDup = Math.max(1, Math.round(hrrrTarget / hrrrValues.length));
    for (const v of hrrrValues) {
      for (let i = 0; i < hrrrDup; i++) {
        result.push(v);
      }
    }

    return result;
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
      `&models=gfs_seamless,icon_seamless,ecmwf_ifs025,arpege_seamless,gem_seamless` +
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
    values: number[],
    _ttlMs: number = CACHE_TTL_MS
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
