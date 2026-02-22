/**
 * @kcb/data — Weather data ingestion
 *
 * Responsible for:
 * - Fetching NWS point forecasts
 * - Fetching GFS/GEFS ensemble data
 * - Fetching ECMWF data (if available via paid API)
 * - Caching forecasts in SQLite for backtesting
 * - Recording actual observations after the fact
 *
 * Data sources (free):
 * - NWS API: https://api.weather.gov
 *   - Point forecasts, grid data, observations
 *   - No auth required, rate limited
 *
 * Data sources (paid, optional):
 * - Open-Meteo: https://open-meteo.com — ensemble model access
 * - Tomorrow.io: https://www.tomorrow.io — high-res forecasts
 * - OpenWeather: https://openweathermap.org — historical + forecast
 */

export { NwsService } from "./services/nws";
export { EnsembleService } from "./services/ensemble";
