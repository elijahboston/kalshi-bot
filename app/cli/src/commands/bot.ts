import { orchestrator } from "@kcb/engine";
import { getConfig } from "@kcb/config";
import type { CommandDef } from "./index";

export const botCommands: CommandDef[] = [
  {
    name: "start",
    description: "Start the bot loop",
    handler: async () => {
      const config = getConfig();
      orchestrator.start();
      return `Bot started (dryRun: ${config.bot.dryRun}, interval: ${config.bot.tickIntervalSec}s)`;
    },
  },
  {
    name: "stop",
    description: "Stop the bot loop",
    handler: async () => {
      orchestrator.stop();
      return "Bot stopped";
    },
  },
  {
    name: "status",
    description: "Show current bot status",
    handler: async () => {
      const state = orchestrator.getState();
      const config = getConfig();

      if (!state.running) {
        return "Bot is stopped. Use `start` to begin.";
      }

      const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
      const mins = Math.floor(uptime / 60);
      const secs = uptime % 60;

      return [
        `Status: RUNNING`,
        `Dry run: ${config.bot.dryRun}`,
        `Ticks: ${state.tickCount}`,
        `Uptime: ${mins}m ${secs}s`,
        `Last tick: ${state.lastTickAt || "never"}`,
        `Edge threshold: ${config.bot.edgeThreshold}`,
        `Max positions: ${config.bot.maxOpenPositions}`,
      ].join("\n");
    },
  },
  {
    name: "restart",
    description: "Restart the bot loop",
    handler: async () => {
      orchestrator.stop();
      await Bun.sleep(500);
      orchestrator.start();
      return "Bot restarted";
    },
  },
];
