import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/**
 * Cached weather forecasts from NWS and other APIs.
 * Stored for backtesting and bias calculation after resolution.
 */
export const weatherForecasts = sqliteTable("weather_forecasts", {
  /** UUID */
  id: text("id").primaryKey(),
  /** NWS station ID */
  stationId: text("station_id").notNull(),
  /** Target date (YYYY-MM-DD) */
  targetDate: text("target_date").notNull(),
  /** Data source: "nws", "gfs_ensemble", "ecmwf", "openweather", etc. */
  source: text("source").notNull(),
  /** Forecast type: "high_temp", "low_temp", "precip", "snowfall" */
  forecastType: text("forecast_type").notNull(),
  /** Forecast horizon in days when this data was fetched */
  forecastHorizon: integer("forecast_horizon").notNull(),
  /** Point forecast value (e.g., 37°F) */
  pointForecast: real("point_forecast"),
  /** JSON: full ensemble member values if available */
  ensembleValues: text("ensemble_values"),
  /** Number of ensemble members */
  ensembleSize: integer("ensemble_size"),
  /** Ensemble mean */
  ensembleMean: real("ensemble_mean"),
  /** Ensemble std dev */
  ensembleStd: real("ensemble_std"),
  /** Actual observed value (filled after resolution) */
  actualValue: real("actual_value"),
  /** When this forecast was fetched */
  fetchedAt: text("fetched_at").notNull(),
});

/**
 * Balance and equity history for tracking performance over time.
 */
export const balanceHistory = sqliteTable("balance_history", {
  /** UUID */
  id: text("id").primaryKey(),
  /** Cash balance in cents */
  balance: integer("balance").notNull(),
  /** Total equity (cash + position value) in cents */
  totalEquity: integer("total_equity").notNull(),
  /** Number of open positions */
  openPositions: integer("open_positions").notNull().default(0),
  /** Cumulative realized PnL in cents */
  realizedPnl: integer("realized_pnl").notNull().default(0),
  /** Snapshot time */
  recordedAt: text("recorded_at").notNull(),
  /** True when this snapshot was taken while bot was in dry-run/paper mode. */
  dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(false),
});

/**
 * Key-value runtime config stored in DB for persistence across restarts.
 */
export const runtimeConfig = sqliteTable("runtime_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type WeatherForecast = typeof weatherForecasts.$inferSelect;
export type NewWeatherForecast = typeof weatherForecasts.$inferInsert;
export type BalanceRecord = typeof balanceHistory.$inferSelect;
export type RuntimeConfigRow = typeof runtimeConfig.$inferSelect;
