import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { bus } from "@kcb/engine";
import { logBuffer } from "../log-buffer";

const LEVEL_COLORS: Record<string, string> = {
  debug: "gray",
  info: "white",
  warn: "yellow",
  error: "red",
};

export function LogsView() {
  const [, forceUpdate] = useState(0);
  const [filter, setFilter] = useState<string | null>(null);

  useEffect(() => {
    // Re-render when new logs arrive
    const unsub = bus.on("log", () => {
      forceUpdate((n) => n + 1);
    });
    return unsub;
  }, []);

  const filtered = filter
    ? logBuffer.filter(
        (l) =>
          l.module.includes(filter) ||
          l.message.includes(filter) ||
          l.level === filter
      )
    : logBuffer;

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text bold color="cyan">
          Logs
        </Text>
        <Text color="gray">
          {filter ? `(filtered: "${filter}")` : "(showing all)"}
        </Text>
        <Text color="gray">{logBuffer.length} entries</Text>
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
              <Text wrap="truncate">{entry.message}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
