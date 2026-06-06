CREATE TABLE `runtime_config_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`actor` text,
	`note` text,
	`changed_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TRIGGER `runtime_config_audit_insert` AFTER INSERT ON `runtime_config` BEGIN
	INSERT INTO `runtime_config_log` (`key`, `old_value`, `new_value`) VALUES (NEW.`key`, NULL, NEW.`value`);
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_config_audit_update` AFTER UPDATE ON `runtime_config` WHEN OLD.`value` != NEW.`value` BEGIN
	INSERT INTO `runtime_config_log` (`key`, `old_value`, `new_value`) VALUES (NEW.`key`, OLD.`value`, NEW.`value`);
END;
