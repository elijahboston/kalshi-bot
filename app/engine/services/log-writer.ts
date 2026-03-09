import { bus } from "../events";
import {
  mkdirSync,
  renameSync,
  statSync,
  appendFileSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file
const MAX_BACKUPS = 3; // Keep .1, .2, .3 → 20MB total max
const DEFAULT_LOG_PATH = "logs/bot.log";

export type LogWriterOptions = {
  logPath?: string;
  /** Minimum level to write. Default: "info" (skips debug) */
  minLevel?: "debug" | "info" | "warn" | "error";
};

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const;

/**
 * Start writing log events to a JSON-lines file with rotation.
 *
 * - Skips debug-level entries by default (configurable via minLevel)
 * - Rotates at 5MB, keeping up to 3 backups (~20MB total max)
 * - Tracks file size in memory to avoid stat() on every write
 *
 * @returns Unsubscribe function to stop writing.
 */
export function startLogWriter(opts: LogWriterOptions = {}): () => void {
  const logPath = opts.logPath ?? DEFAULT_LOG_PATH;
  const minLevel = opts.minLevel ?? "info";
  const minOrd = LEVEL_ORDER[minLevel];

  mkdirSync(dirname(logPath), { recursive: true });

  // Seed tracked size from existing file
  let trackedSize = 0;
  try {
    trackedSize = statSync(logPath).size;
  } catch {
    // File doesn't exist yet
  }

  const unsub = bus.on("log", (entry) => {
    try {
      if (LEVEL_ORDER[entry.level] < minOrd) return;

      // Rotate if needed
      if (trackedSize >= MAX_FILE_SIZE) {
        rotate(logPath);
        trackedSize = 0;
      }

      const line = JSON.stringify(entry) + "\n";
      appendFileSync(logPath, line, "utf-8");
      trackedSize += Buffer.byteLength(line, "utf-8");
    } catch {
      // Don't crash the bot if logging fails
    }
  });

  return unsub;
}

/** Shift bot.log → .1 → .2 → .3, dropping the oldest */
function rotate(logPath: string): void {
  // Remove the oldest backup
  try {
    unlinkSync(`${logPath}.${MAX_BACKUPS}`);
  } catch {
    // Doesn't exist yet
  }

  // Shift existing backups up: .2→.3, .1→.2
  for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
    try {
      renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`);
    } catch {
      // Doesn't exist yet
    }
  }

  // Current → .1
  renameSync(logPath, `${logPath}.1`);
}
