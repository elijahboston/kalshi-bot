import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/**
 * Calibration records — one per resolved market we had a signal for.
 * This is the core self-improvement data: predicted vs actual.
 */
export const calibration = sqliteTable("calibration", {
  /** UUID */
  id: text("id").primaryKey(),
  /** Market ticker */
  ticker: text("ticker").notNull(),
  /** Series ticker for grouping */
  seriesTicker: text("series_ticker").notNull(),
  /** Market category */
  category: text("category").notNull(),
  /** NWS station ID */
  stationId: text("station_id"),
  /** Our predicted probability (0-1) */
  predictedProb: real("predicted_prob").notNull(),
  /** Actual outcome: 1 = YES settled, 0 = NO settled */
  actualOutcome: integer("actual_outcome").notNull(),
  /** Market price at time of our signal */
  marketPrice: real("market_price").notNull(),
  /** Our edge at signal time */
  edge: real("edge").notNull(),
  /** Realized PnL in cents (null if we didn't trade) */
  realizedPnl: real("realized_pnl"),
  /** Did we trade this market? */
  traded: integer("traded", { mode: "boolean" }).notNull().default(false),
  /** Forecast horizon in days at signal time */
  forecastHorizon: integer("forecast_horizon"),
  /** When the market resolved */
  resolvedAt: text("resolved_at").notNull(),
});

/**
 * Station-specific forecast bias corrections.
 * Recomputed after each resolution for the relevant station/horizon combo.
 * This is the single biggest lever for accuracy improvement over time.
 */
export const stationBias = sqliteTable("station_bias", {
  /** Composite key: stationId + forecastHorizonDays */
  id: text("id").primaryKey(),
  /** NWS station ID, e.g. KNYC, KORD, KLAX */
  stationId: text("station_id").notNull(),
  /** Forecast horizon: 1, 2, 3, ... 7 days out */
  forecastHorizonDays: integer("forecast_horizon_days").notNull(),
  /** Mean bias in °F (positive = model runs warm) */
  meanBias: real("mean_bias").notNull().default(0),
  /** Std deviation of bias */
  stdBias: real("std_bias").notNull().default(1),
  /** Number of data points in the rolling window */
  sampleSize: integer("sample_size").notNull().default(0),
  /** Rolling window size in days */
  windowDays: integer("window_days").notNull().default(30),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Per-bucket adaptive thresholds.
 * Instead of one global edge threshold, each probability bucket
 * and series can have its own threshold based on recent calibration.
 */
export const adaptiveThresholds = sqliteTable("adaptive_thresholds", {
  /** Composite key: seriesTicker + bucketLabel */
  id: text("id").primaryKey(),
  /** Series ticker or "__global__" */
  seriesTicker: text("series_ticker").notNull(),
  /** Bucket label, e.g. "0.0-0.1", "0.1-0.2", etc. */
  bucketLabel: text("bucket_label").notNull(),
  /** Effective edge threshold for this bucket */
  edgeThreshold: real("edge_threshold").notNull(),
  /** Calibration error for this bucket (predicted - actual rate) */
  calibrationError: real("calibration_error"),
  /** Sample size in this bucket */
  sampleSize: integer("sample_size").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export type Calibration = typeof calibration.$inferSelect;
export type NewCalibration = typeof calibration.$inferInsert;
export type StationBias = typeof stationBias.$inferSelect;
export type NewStationBias = typeof stationBias.$inferInsert;
export type AdaptiveThreshold = typeof adaptiveThresholds.$inferSelect;
