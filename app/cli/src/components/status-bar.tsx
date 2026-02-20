import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { bus, type BotEvents } from "@kcb/engine";
import { getConfig } from "@kcb/config";

export function StatusBar() {
  const config = getConfig();
  const [status, setStatus] = useState<BotEvents["bot:status"] | null>(null);
  const [balance, setBalance] = useState<BotEvents["balance:update"] | null>(null);

  useEffect(() => {
    const unsubs = [
      bus.on("bot:status", setStatus),
      bus.on("balance:update", setBalance),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const running = status?.running ?? false;
  const dryRun = config.bot.dryRun;
  const bal = balance ? `$${(balance.balance / 100).toFixed(2)}` : "—";
  const equity = balance ? `$${(balance.totalEquity / 100).toFixed(2)}` : "—";
  const ticks = status?.tickCount ?? 0;
  const now = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  return (
    <Box paddingX={1} gap={1}>
      <Text color="gray">{"─".repeat(80)}</Text>
      <Box gap={2}>
        <Text>
          <Text color={running ? "green" : "red"} bold>
            {running ? "● RUNNING" : "○ STOPPED"}
          </Text>
        </Text>

        {dryRun && (
          <Text color="yellow" bold>
            DRY-RUN
          </Text>
        )}

        <Text color="gray">│</Text>
        <Text>
          Balance: <Text bold>{bal}</Text>
        </Text>
        <Text>
          Equity: <Text bold>{equity}</Text>
        </Text>
        <Text color="gray">│</Text>
        <Text>
          Ticks: <Text bold>{ticks}</Text>
        </Text>
        <Text color="gray">│</Text>
        <Text color="gray">{now}</Text>
      </Box>
    </Box>
  );
}
