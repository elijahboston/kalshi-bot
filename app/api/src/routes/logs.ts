import Elysia, { t } from "elysia";
import { bus, type BotEvents } from "@kcb/engine";

type LogEntry = BotEvents["log"];

const MAX_BUFFER = 500;
const logBuffer: LogEntry[] = [];

/** Start capturing logs from the bus into the ring buffer */
export function startLogCapture(): () => void {
  return bus.on("log", (entry) => {
    logBuffer.push(entry);
    if (logBuffer.length > MAX_BUFFER) {
      logBuffer.shift();
    }
  });
}

/** Get the current log buffer (for testing) */
export function getLogBuffer(): readonly LogEntry[] {
  return logBuffer;
}

export const logRoutes = new Elysia({ prefix: "/api" }).get(
  "/logs",
  ({ query }) => {
    const limit = Math.min(query.limit ?? 100, MAX_BUFFER);
    let filtered = logBuffer;

    if (query.level) {
      filtered = filtered.filter((l) => l.level === query.level);
    }
    if (query.module) {
      filtered = filtered.filter((l) => l.module === query.module);
    }

    // Return most recent entries
    return filtered.slice(-limit);
  },
  {
    query: t.Object({
      limit: t.Optional(t.Numeric()),
      level: t.Optional(t.String()),
      module: t.Optional(t.String()),
    }),
  },
);
