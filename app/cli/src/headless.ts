#!/usr/bin/env bun
import { getConfig } from "@kcb/config";
import { runMigrations } from "@kcb/db";
import { orchestrator, startLogWriter } from "@kcb/engine";
import { holdTicker } from "@kcb/execution";
import { startApiServer, startConsoleLogger } from "@kcb/api";

/**
 * Headless entry point — runs the bot without the TUI.
 * Starts the engine loop, an Elysia REST + WebSocket API server,
 * and streams logs to stdout.
 *
 * Environment variables:
 *   API_PORT — port for the API server (default: 3100)
 */
export async function runHeadless(): Promise<void> {
  const config = getConfig();
  const port = Number(process.env.API_PORT) || 3100;

  // Ensure DB exists and is migrated
  runMigrations(config.db.path);

  // Hold damaged position until settlement (matches existing behavior)
  holdTicker("KXHIGHCHI-26MAR07-B62.5");

  // Stream bus logs to stdout (replaces the TUI's log view)
  const stopConsoleLogger = startConsoleLogger();

  // Persist logs to file
  const stopLogWriter = startLogWriter();

  // Start REST + WebSocket API server
  const apiServer = startApiServer(port);

  // Initialize the engine (syncs portfolio from Kalshi) and start the loop
  try {
    await orchestrator.initOrchestrator();
    orchestrator.start();
  } catch (err) {
    console.error("Orchestrator init failed:", err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    orchestrator.stop();
    apiServer.stop();
    stopLogWriter();
    stopConsoleLogger();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run if invoked directly
if (import.meta.main) {
  runHeadless().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
