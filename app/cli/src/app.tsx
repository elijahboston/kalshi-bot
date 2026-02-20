import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { StatusBar } from "./components/status-bar";
import { Dashboard } from "./views/dashboard";
import { Repl } from "./views/repl";
import { MarketsView } from "./views/markets";
import { LogsView } from "./views/logs";

type ViewMode = "dashboard" | "repl" | "markets" | "logs";

const VIEW_LABELS: Record<ViewMode, string> = {
  dashboard: "Dashboard",
  repl: "REPL",
  markets: "Markets",
  logs: "Logs",
};

const VIEW_KEYS: Record<string, ViewMode> = {
  "1": "dashboard",
  "2": "repl",
  "3": "markets",
  "4": "logs",
};

export function App() {
  const { exit } = useApp();
  const [mode, setMode] = useState<ViewMode>("dashboard");

  useInput((input, key) => {
    // Number keys switch views
    if (VIEW_KEYS[input] && mode !== "repl") {
      setMode(VIEW_KEYS[input]!);
    }

    // Ctrl+C exits
    if (key.ctrl && input === "c") {
      exit();
    }

    // Tab cycles through views
    if (key.tab && mode !== "repl") {
      const views: ViewMode[] = ["dashboard", "repl", "markets", "logs"];
      const idx = views.indexOf(mode);
      setMode(views[(idx + 1) % views.length]!);
    }

    // Escape returns to dashboard from any view
    if (key.escape) {
      setMode("dashboard");
    }
  });

  const renderView = useCallback(() => {
    switch (mode) {
      case "dashboard":
        return <Dashboard />;
      case "repl":
        return <Repl onExit={() => setMode("dashboard")} />;
      case "markets":
        return <MarketsView />;
      case "logs":
        return <LogsView />;
    }
  }, [mode]);

  return (
    <Box flexDirection="column" width="100%">
      {/* Tab bar */}
      <Box paddingX={1} gap={2}>
        {(Object.entries(VIEW_LABELS) as [ViewMode, string][]).map(
          ([key, label], i) => (
            <Text
              key={key}
              bold={mode === key}
              color={mode === key ? "cyan" : "gray"}
            >
              [{i + 1}] {label}
            </Text>
          )
        )}
        <Text color="gray"> │ Tab: cycle │ Esc: dashboard │ Ctrl+C: quit</Text>
      </Box>

      {/* Separator */}
      <Box paddingX={1}>
        <Text color="gray">{"─".repeat(80)}</Text>
      </Box>

      {/* Active view */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {renderView()}
      </Box>

      {/* Status bar */}
      <StatusBar />
    </Box>
  );
}
