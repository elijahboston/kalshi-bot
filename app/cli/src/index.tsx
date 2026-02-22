#!/usr/bin/env bun
import { render } from "ink";
import React from "react";
import { getConfig } from "@kcb/config";
import { getDb, runMigrations } from "@kcb/db";
import { orchestrator } from "@kcb/engine";
import { App } from "./app";
// Import early to start capturing logs before anything else emits
import "./log-buffer";

async function main() {
  const config = getConfig();

  // Ensure DB exists and is migrated
  runMigrations(config.db.path);

  // Initialize the engine (registers tick function, doesn't start yet)
  await orchestrator.initOrchestrator();

  // Auto-start the bot loop
  orchestrator.start();

  // Enter alternate screen buffer for a clean fullscreen TUI
  process.stdout.write("\x1b[?1049h");

  // Render the terminal UI
  const { waitUntilExit, cleanup } = render(React.createElement(App));

  // Block until the user exits (Ctrl+C or `quit` command)
  await waitUntilExit();

  // Cleanup — leave alternate screen buffer and stop engine
  cleanup();
  process.stdout.write("\x1b[?1049l");
  orchestrator.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
