ALTER TABLE `markets` ADD COLUMN `market_type` text NOT NULL DEFAULT 'bracket';
--> statement-breakpoint
UPDATE `markets` SET `market_type` = 'upper_tail' WHERE `title` LIKE '%>%' AND `ticker` LIKE '%-T%';
--> statement-breakpoint
UPDATE `markets` SET `market_type` = 'lower_tail' WHERE `title` LIKE '%<%' AND `ticker` LIKE '%-T%';
--> statement-breakpoint
UPDATE `markets` SET `bracket_high` = NULL WHERE `market_type` IN ('upper_tail', 'lower_tail');
