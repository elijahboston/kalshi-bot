import { bus } from "../events";
import { mkdirSync, renameSync, statSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_LOG_PATH = "logs/bot.log";

/**
 * Start writing log events to a JSON-lines file with rotation at 10MB.
 *
 * Subscribes to the bus "log" event and appends each entry as a JSON line.
 * When the file exceeds 10MB, renames it to `bot.log.1` and starts fresh.
 *
 * @returns Unsubscribe function to stop writing.
 */
export function startLogWriter(logPath: string = DEFAULT_LOG_PATH): () => void {
  mkdirSync(dirname(logPath), { recursive: true });

  const unsub = bus.on("log", (entry) => {
    try {
      // Check file size for rotation
      try {
        const stat = statSync(logPath);
        if (stat.size >= MAX_FILE_SIZE) {
          renameSync(logPath, logPath + ".1");
        }
      } catch {
        // File doesn't exist yet — that's fine
      }

      const line = JSON.stringify(entry) + "\n";
      appendFileSync(logPath, line, "utf-8");
    } catch {
      // Don't crash the bot if logging fails
    }
  });

  return unsub;
}
