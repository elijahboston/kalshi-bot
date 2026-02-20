import { getConfig, updateConfig, type BotConfig } from "@kcb/config";
import { getDb, runtimeConfig, eq, sql } from "@kcb/db";
import type { CommandDef } from "./index";

/** Flat dot-notation paths to mutable config values */
const MUTABLE_KEYS: Record<string, { path: string[]; type: "number" | "boolean" | "string" }> = {
  "dry_run":              { path: ["bot", "dryRun"], type: "boolean" },
  "edge_threshold":       { path: ["bot", "edgeThreshold"], type: "number" },
  "min_confidence":       { path: ["bot", "minConfidence"], type: "number" },
  "max_kelly":            { path: ["bot", "maxKellyFraction"], type: "number" },
  "max_positions":        { path: ["bot", "maxOpenPositions"], type: "number" },
  "max_contracts":        { path: ["bot", "maxContractsPerOrder"], type: "number" },
  "tick_interval":        { path: ["bot", "tickIntervalSec"], type: "number" },
  "bias_window_days":     { path: ["calibration", "biasWindowDays"], type: "number" },
  "max_calibration_error":{ path: ["calibration", "maxCalibrationError"], type: "number" },
  "log_level":            { path: ["log", "level"], type: "string" },
};

function getNestedValue(obj: unknown, path: string[]): unknown {
  let current = obj as Record<string, unknown>;
  for (const key of path) {
    current = current[key] as Record<string, unknown>;
    if (current === undefined) return undefined;
  }
  return current;
}

export const configCommands: CommandDef[] = [
  {
    name: "config",
    aliases: ["cfg"],
    description: "Get or set config values",
    usage: "config [get <key> | set <key> <value> | list]",
    handler: async (args) => {
      const subcommand = args[0]?.toLowerCase();

      if (!subcommand || subcommand === "list") {
        const config = getConfig();
        const lines = Object.entries(MUTABLE_KEYS).map(([key, { path }]) => {
          const val = getNestedValue(config, path);
          return `  ${key.padEnd(25)} ${String(val)}`;
        });
        return ["Mutable config keys:", "", ...lines].join("\n");
      }

      if (subcommand === "get") {
        const key = args[1];
        if (!key) return "Usage: config get <key>";

        const meta = MUTABLE_KEYS[key];
        if (!meta) return `Unknown config key: ${key}\nUse "config list" to see available keys.`;

        const val = getNestedValue(getConfig(), meta.path);
        return `${key} = ${String(val)}`;
      }

      if (subcommand === "set") {
        const key = args[1];
        const rawValue = args[2];
        if (!key || rawValue === undefined) return "Usage: config set <key> <value>";

        const meta = MUTABLE_KEYS[key];
        if (!meta) return `Unknown config key: ${key}\nUse "config list" to see available keys.`;

        // Parse value
        let parsedValue: unknown;
        if (meta.type === "number") {
          parsedValue = Number(rawValue);
          if (Number.isNaN(parsedValue as number)) return `Invalid number: ${rawValue}`;
        } else if (meta.type === "boolean") {
          parsedValue = rawValue === "true" || rawValue === "1";
        } else {
          parsedValue = rawValue;
        }

        // Update in-memory config
        const config = getConfig() as Record<string, unknown>;
        let target = config;
        for (let i = 0; i < meta.path.length - 1; i++) {
          target = target[meta.path[i]!] as Record<string, unknown>;
        }
        const oldValue = target[meta.path[meta.path.length - 1]!];
        target[meta.path[meta.path.length - 1]!] = parsedValue;

        // Persist to DB
        const db = getDb();
        await db.insert(runtimeConfig)
          .values({
            key,
            value: String(parsedValue),
            updatedAt: new Date().toISOString(),
          })
          .onConflictDoUpdate({
            target: runtimeConfig.key,
            set: {
              value: String(parsedValue),
              updatedAt: new Date().toISOString(),
            },
          });

        return `Updated ${key}: ${String(oldValue)} → ${String(parsedValue)}`;
      }

      return 'Usage: config [list | get <key> | set <key> <value>]';
    },
  },
];
