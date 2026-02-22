import { bus, type BotEvents } from "@kcb/engine";

const MAX_ENTRIES = 200;

/** Shared log buffer — initialized once at import time, persists across view switches */
export const logBuffer: BotEvents["log"][] = [];

// Start collecting immediately on import
bus.on("log", (entry) => {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_ENTRIES) {
    logBuffer.splice(0, logBuffer.length - MAX_ENTRIES);
  }
});
