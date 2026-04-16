import { bus } from "@kcb/engine";

const LEVEL_COLORS: Record<string, string> = {
  DEBUG: "\x1b[90m",  // gray
  INFO: "\x1b[36m",   // cyan
  WARN: "\x1b[33m",   // yellow
  ERROR: "\x1b[31m",  // red
};
const RESET = "\x1b[0m";

/**
 * Subscribe to bus log events and print formatted output to stdout.
 * Used in headless mode when the TUI is not active.
 */
export function startConsoleLogger(): () => void {
  return bus.on("log", (entry) => {
    const ts = entry.timestamp.slice(11, 19); // HH:MM:SS
    const level = entry.level.toUpperCase().padEnd(5);
    const color = LEVEL_COLORS[entry.level.toUpperCase()] ?? "";
    const msg = `${color}[${ts}] [${level}] [${entry.module}]${RESET} ${entry.message}`;

    if (entry.level === "error") {
      console.error(msg);
    } else {
      console.log(msg);
    }
  });
}
