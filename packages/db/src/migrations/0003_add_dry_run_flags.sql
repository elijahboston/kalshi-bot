ALTER TABLE `balance_history` ADD COLUMN `dry_run` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `signals` ADD COLUMN `dry_run` integer DEFAULT false NOT NULL;
