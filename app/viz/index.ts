#!/usr/bin/env bun
import { getConfig } from "@kcb/config";
import { runMigrations } from "@kcb/db";
import { orchestrator, startLogWriter } from "@kcb/engine";
import { startVizServer } from "./src/server";

async function main() {
  const config = getConfig();

  // Ensure DB exists and is migrated
  runMigrations(config.db.path);

  // Initialize the engine
  await orchestrator.initOrchestrator();

  // Start log writer
  const stopLogWriter = startLogWriter();

  // Start the bot loop
  orchestrator.start();

  // Start the viz server
  const port = Number(process.env.VIZ_PORT) || 3456;
  const { stop: stopViz } = startVizServer(port);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    stopViz();
    stopLogWriter();
    orchestrator.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
