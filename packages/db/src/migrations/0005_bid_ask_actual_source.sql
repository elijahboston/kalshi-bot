ALTER TABLE `markets` ADD COLUMN `yes_bid` integer;
--> statement-breakpoint
ALTER TABLE `markets` ADD COLUMN `yes_ask` integer;
--> statement-breakpoint
ALTER TABLE `weather_forecasts` ADD COLUMN `actual_source` text;
