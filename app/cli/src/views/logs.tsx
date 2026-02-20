import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { bus, type BotEvents } from "@kcb/engine";

const LEVEL_COLORS: Record<string, string> = {
  debug: "gray",
  info: "white",
  warn: "yellow",
  error: "red",
};

export function LogsView() {
  const [logs, setLogs] = useState<BotEvents["log"][]>([]);
  const [filter, setFilter] = useState<string | null>(null);

  useEffect(() => {
    const unsub = bus.on("log", (entry) => {
      setLogs((prev) => [...prev, entry].slice(-50));
    });
    return unsub;
  }, []);

  const filtered = filter
    ? logs.filter(
        (l) =>
          l.module.includes(filter) ||
          l.message.includes(filter) ||
          l.level === filter
      )
    : logs;

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text bold color="cyan">
          Logs
        </Text>
        <Text color="gray">
          {filter ? `(filtered: "${filter}")` : "(showing all)"}
        </Text>
        <Text color="gray">Tail last 50 entries</Text>
      </Box>

      <Text color="gray">{"─".repeat(80)}</Text>

      {filtered.length === 0 ? (
        <Text color="gray">No log entries yet.</Text>
      ) : (
        filtered.slice(-30).map((entry, i) => {
          const time = entry.timestamp.slice(11, 19);
          return (
            <Box key={`${entry.timestamp}-${i}`} gap={1}>
              <Text color="gray">{time}</Text>
              <Text color={LEVEL_COLORS[entry.level] || "white"}>
                {entry.level.toUpperCase().padEnd(5)}
              </Text>
              <Text color="blue">[{entry.module}]</Text>
              <Text>{entry.message}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
