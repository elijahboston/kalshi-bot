#!/usr/bin/env bun
import { render } from "ink";
import React from "react";
import { getConfig } from "@kcb/config";
import { getDb, runMigrations } from "@kcb/db";
import { orchestrator } from "@kcb/engine";
import { App } from "./app";

async function main() {
  const config = getConfig();

  // Ensure DB exists and is migrated
  runMigrations(config.db.path);

  // Initialize the engine (registers tick function, doesn't start yet)
  await orchestrator.initOrchestrator();

  // Render the terminal UI
  const { waitUntilExit } = render(React.createElement(App));

  // Block until the user exits (Ctrl+C or `quit` command)
  await waitUntilExit();

  // Cleanup
  orchestrator.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
