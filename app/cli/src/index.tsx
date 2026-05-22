#!/usr/bin/env bun
import { render } from "ink";
import React from "react";
import { getConfig } from "@kcb/config";
import { runMigrations } from "@kcb/db";
import { orchestrator, startLogWriter } from "@kcb/engine";
import { holdTicker } from "@kcb/execution";
import { startApiServer } from "@kcb/api";
import { App } from "./app";
// Import early to start capturing logs before anything else emits
import "./log-buffer";
import { runHeadless } from "./headless";

const tuiFlag = process.argv.includes("--tui");
const vizFlag = process.argv.includes("--viz");

async function runTui() {
  const config = getConfig();

  // Ensure DB exists and is migrated
  runMigrations(config.db.path);

  // Hold damaged position until settlement — do not attempt exits
  holdTicker("KXHIGHCHI-26MAR07-B62.5");

  // Start writing logs to file
  const stopLogWriter = startLogWriter();

  // Start API server alongside the TUI so the web UI can coexist
  const port = Number(process.env.API_PORT) || 3100;
  const apiServer = startApiServer(port);

  // Start viz server if --viz flag is passed
  let stopViz: (() => void) | null = null;
  if (vizFlag) {
    const { startVizServer } = await import("@kcb/viz/src/server");
    const vizPort = Number(process.env.VIZ_PORT) || 3456;
    const viz = startVizServer(vizPort);
    stopViz = viz.stop;
  }

  // Enter alternate screen buffer for a clean fullscreen TUI
  process.stdout.write("\x1b[?1049h");

  // Render the terminal UI immediately — don't block on API calls
  const { waitUntilExit, cleanup } = render(React.createElement(App));

  // Initialize the engine in the background (syncs portfolio from Kalshi)
  orchestrator.initOrchestrator().then(() => {
    orchestrator.start();
  }).catch((err) => {
    console.error("Orchestrator init failed:", err);
  });

  // Block until the user exits (Ctrl+C or `quit` command)
  await waitUntilExit();

  // Cleanup — leave alternate screen buffer and stop engine
  cleanup();
  process.stdout.write("\x1b[?1049l");
  stopViz?.();
  apiServer.stop();
  stopLogWriter();
  orchestrator.stop();
  process.exit(0);
}

async function main() {
  if (tuiFlag) {
    await runTui();
  } else {
    await runHeadless();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
