import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { StatusBar } from "./components/status-bar";
import { Dashboard } from "./views/dashboard";
import { Repl } from "./views/repl";
import { MarketsView } from "./views/markets";
import { LogsView } from "./views/logs";
import { ActivityView } from "./views/activity";
import { PerformanceView } from "./views/performance";

type ViewMode = "dashboard" | "repl" | "markets" | "logs" | "activity" | "performance";

/** Tabs shown in the tab bar — REPL is excluded (opened via Ctrl+R) */
const TAB_VIEWS: { mode: ViewMode; label: string }[] = [
  { mode: "dashboard", label: "Dashboard" },
  { mode: "markets", label: "Markets" },
  { mode: "logs", label: "Logs" },
  { mode: "activity", label: "Activity" },
  { mode: "performance", label: "Performance" },
];

const VIEW_KEYS: Record<string, ViewMode> = {
  "1": "dashboard",
  "2": "markets",
  "3": "logs",
  "4": "activity",
  "5": "performance",
};

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [mode, setMode] = useState<ViewMode>("dashboard");

  useInput((input, key) => {
    // Number keys switch views (disabled while in REPL)
    if (VIEW_KEYS[input] && mode !== "repl") {
      setMode(VIEW_KEYS[input]!);
    }

    // Ctrl+C exits
    if (key.ctrl && input === "c") {
      exit();
    }

    // Ctrl+R toggles REPL
    if (key.ctrl && input === "r") {
      setMode(mode === "repl" ? "dashboard" : "repl");
    }

    // Tab cycles through tab views (skips REPL)
    if (key.tab && mode !== "repl") {
      const idx = TAB_VIEWS.findIndex((t) => t.mode === mode);
      const next = (idx + 1) % TAB_VIEWS.length;
      setMode(TAB_VIEWS[next]!.mode);
    }

    // Escape returns to dashboard from any view (including REPL)
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
      case "activity":
        return <ActivityView />;
      case "performance":
        return <PerformanceView />;
    }
  }, [mode]);

  return (
    <Box flexDirection="column" width="100%" height={stdout.rows}>
      {/* Tab bar */}
      <Box paddingX={1} gap={2}>
        {TAB_VIEWS.map(({ mode: m, label }, i) => (
          <Text
            key={m}
            bold={mode === m}
            color={mode === m ? "cyan" : "gray"}
          >
            [{i + 1}] {label}
          </Text>
        ))}
        <Text
          bold={mode === "repl"}
          color={mode === "repl" ? "cyan" : "gray"}
        >
          [^R] REPL
        </Text>
        <Text color="gray"> │ Tab: cycle │ Esc: back │ Ctrl+C: quit</Text>
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
