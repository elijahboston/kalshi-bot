import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { executeCommand, parseCommand, type CommandResult } from "../commands";

interface OutputLine {
  id: number;
  type: "input" | "output" | "error";
  text: string;
  jsx?: React.ReactElement;
}

let lineId = 0;

export function Repl({ onExit }: { onExit: () => void }) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<OutputLine[]>([]);
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [isProcessing, setIsProcessing] = useState(false);

  const addOutput = useCallback(
    (result: CommandResult, type: "output" | "error" = "output") => {
      if (typeof result === "string") {
        setHistory((prev) =>
          [...prev, { id: ++lineId, type, text: result }].slice(-100)
        );
      } else {
        setHistory((prev) =>
          [...prev, { id: ++lineId, type, text: "", jsx: result }].slice(-100)
        );
      }
    },
    []
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      // Add to visual and command history
      setHistory((prev) => [
        ...prev,
        { id: ++lineId, type: "input", text: `> ${trimmed}` },
      ]);
      setCmdHistory((prev) => [...prev, trimmed]);
      setHistoryIdx(-1);
      setInput("");

      if (trimmed === "quit" || trimmed === "exit") {
        onExit();
        return;
      }

      setIsProcessing(true);
      try {
        const { command, args } = parseCommand(trimmed);
        const result = await executeCommand(command, args);
        if (result) {
          addOutput(result);
        }
      } catch (err) {
        addOutput(
          err instanceof Error ? err.message : String(err),
          "error"
        );
      } finally {
        setIsProcessing(false);
      }
    },
    [addOutput, onExit]
  );

  useInput((input, key) => {
    // Up/Down for command history
    if (key.upArrow && cmdHistory.length > 0) {
      const newIdx =
        historyIdx < cmdHistory.length - 1 ? historyIdx + 1 : historyIdx;
      setHistoryIdx(newIdx);
      setInput(cmdHistory[cmdHistory.length - 1 - newIdx] || "");
    }
    if (key.downArrow) {
      const newIdx = historyIdx > 0 ? historyIdx - 1 : -1;
      setHistoryIdx(newIdx);
      setInput(
        newIdx >= 0 ? cmdHistory[cmdHistory.length - 1 - newIdx] || "" : ""
      );
    }
  });

  return (
    <Box flexDirection="column" gap={0}>
      <Text bold color="cyan">
        REPL — type "help" for commands, "exit" to return to dashboard
      </Text>
      <Text color="gray">{"─".repeat(60)}</Text>

      {/* Scrollable output */}
      <Box flexDirection="column" flexGrow={1}>
        {history.slice(-20).map((line) =>
          line.jsx ? (
            <Box key={line.id}>{line.jsx}</Box>
          ) : (
            <Text
              key={line.id}
              color={
                line.type === "error"
                  ? "red"
                  : line.type === "input"
                    ? "cyan"
                    : undefined
              }
            >
              {line.text}
            </Text>
          )
        )}
      </Box>

      {/* Input prompt */}
      <Box>
        <Text color={isProcessing ? "yellow" : "green"}>
          {isProcessing ? "⏳ " : "> "}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="Type a command..."
        />
      </Box>
    </Box>
  );
}
