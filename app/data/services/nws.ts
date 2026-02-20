import { createLogger } from "@kcb/engine";

const log = createLogger("nws");

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
}
