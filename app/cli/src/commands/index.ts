import React from "react";
import { botCommands } from "./bot";
import { marketsCommands } from "./markets";
import { positionsCommands } from "./positions";
import { configCommands } from "./config";
import { calibrationCommands } from "./calibration";
import { explainCommands } from "./explain";
import { backtestCommands } from "./backtest";
import { winsCommands } from "./wins";

export type CommandResult = string | React.ReactElement;

export interface CommandDef {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  handler: (args: string[]) => Promise<CommandResult>;
}

const commandGroups: Record<string, CommandDef[]> = {
  bot: botCommands,
  markets: marketsCommands,
  positions: positionsCommands,
  config: configCommands,
  calibration: calibrationCommands,
  explain: explainCommands,
  backtest: backtestCommands,
  wins: winsCommands,
};

/** Flat lookup of all commands by name and alias */
const registry = new Map<string, CommandDef>();

for (const group of Object.values(commandGroups)) {
  for (const cmd of group) {
    registry.set(cmd.name, cmd);
    for (const alias of cmd.aliases || []) {
      registry.set(alias, cmd);
    }
  }
}

export function parseCommand(input: string): { command: string; args: string[] } {
  const parts = input.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase() || "";
  const args = parts.slice(1);
  return { command, args };
}

export async function executeCommand(command: string, args: string[]): Promise<CommandResult> {
  if (command === "help") {
    return formatHelp();
  }

  const cmd = registry.get(command);
  if (!cmd) {
    return `Unknown command: "${command}". Type "help" for available commands.`;
  }

  return cmd.handler(args);
}

function formatHelp(): string {
  const lines: string[] = ["Available commands:", ""];

  for (const [groupName, cmds] of Object.entries(commandGroups)) {
    lines.push(`  ${groupName.toUpperCase()}`);
    for (const cmd of cmds) {
      const aliases = cmd.aliases?.length
        ? ` (${cmd.aliases.join(", ")})`
        : "";
      const usage = cmd.usage ? `  ${cmd.usage}` : "";
      lines.push(
        `    ${cmd.name.padEnd(16)}${cmd.description}${aliases}${usage}`
      );
    }
    lines.push("");
  }

  lines.push("  help              Show this help message");
  lines.push("  exit / quit       Return to dashboard");
  return lines.join("\n");
}
