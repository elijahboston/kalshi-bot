CREATE TABLE `markets` (
	`ticker` text PRIMARY KEY NOT NULL,
	`event_ticker` text NOT NULL,
	`series_ticker` text NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`station_id` text,
	`target_date` text,
	`bracket_low` real,
	`bracket_high` real,
	`status` text DEFAULT 'open' NOT NULL,
	`close_time` text,
	`result` text,
	`last_yes_price` integer,
	`last_no_price` integer,
	`discovered_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`order_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`action` text NOT NULL,
	`side` text NOT NULL,
	`limit_price` integer NOT NULL,
	`quantity` integer NOT NULL,
	`filled_quantity` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`signal_id` text,
	`dry_run` integer DEFAULT false NOT NULL,
	`kelly_fraction` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`ticker` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`quantity` integer NOT NULL,
	`avg_entry_price` real NOT NULL,
	`cost_basis` real NOT NULL,
	`market_value` real,
	`unrealized_pnl` real,
	`opened_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`ticker` text NOT NULL,
	`side` text NOT NULL,
	`price` integer NOT NULL,
	`quantity` integer NOT NULL,
	`action` text NOT NULL,
	`filled_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`series_ticker` text NOT NULL,
	`estimated_prob` real NOT NULL,
	`confidence` real NOT NULL,
	`market_price` real NOT NULL,
	`edge` real NOT NULL,
	`edge_threshold` real NOT NULL,
	`recommendation` text NOT NULL,
	`side` text,
	`kelly_fraction` real,
	`ensemble_size` integer,
	`reasoning` text,
	`acted` integer DEFAULT false NOT NULL,
	`order_id` text,
	`skip_reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `adaptive_thresholds` (
	`id` text PRIMARY KEY NOT NULL,
	`series_ticker` text NOT NULL,
	`bucket_label` text NOT NULL,
	`edge_threshold` real NOT NULL,
	`calibration_error` real,
	`sample_size` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `calibration` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`series_ticker` text NOT NULL,
	`category` text NOT NULL,
	`station_id` text,
	`predicted_prob` real NOT NULL,
	`actual_outcome` integer NOT NULL,
	`market_price` real NOT NULL,
	`edge` real NOT NULL,
	`realized_pnl` real,
	`traded` integer DEFAULT false NOT NULL,
	`forecast_horizon` integer,
	`resolved_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `station_bias` (
	`id` text PRIMARY KEY NOT NULL,
	`station_id` text NOT NULL,
	`forecast_horizon_days` integer NOT NULL,
	`mean_bias` real DEFAULT 0 NOT NULL,
	`std_bias` real DEFAULT 1 NOT NULL,
	`sample_size` integer DEFAULT 0 NOT NULL,
	`window_days` integer DEFAULT 30 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `balance_history` (
	`id` text PRIMARY KEY NOT NULL,
	`balance` integer NOT NULL,
	`total_equity` integer NOT NULL,
	`open_positions` integer DEFAULT 0 NOT NULL,
	`realized_pnl` integer DEFAULT 0 NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runtime_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `weather_forecasts` (
	`id` text PRIMARY KEY NOT NULL,
	`station_id` text NOT NULL,
	`target_date` text NOT NULL,
	`source` text NOT NULL,
	`forecast_type` text NOT NULL,
	`forecast_horizon` integer NOT NULL,
	`point_forecast` real,
	`ensemble_values` text,
	`ensemble_size` integer,
	`ensemble_mean` real,
	`ensemble_std` real,
	`actual_value` real,
	`fetched_at` text NOT NULL
);
