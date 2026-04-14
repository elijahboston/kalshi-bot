import React from "react";
import { Box, Text } from "ink";

interface TableProps {
  data: Record<string, string>[];
  columns?: string[];
  cell?: (props: { children: React.ReactNode; column: string }) => React.ReactElement;
}

/**
 * Lightweight table component for Ink.
 * Renders data as aligned columns with box-drawing borders.
 */
export default function Table({ data, columns, cell }: TableProps) {
  if (data.length === 0) return null;

  // Determine columns
  const cols = columns ?? Object.keys(data[0]!);

  // Calculate column widths
  const widths: Record<string, number> = {};
  for (const col of cols) {
    widths[col] = col.length;
    for (const row of data) {
      widths[col] = Math.max(widths[col]!, String(row[col] ?? "").length);
    }
    widths[col]! += 2; // padding
  }

  const renderCell = cell ?? (({ children }) => <Text>{children}</Text>);

  // Build border
  const topBorder = "┌" + cols.map((c) => "─".repeat(widths[c]!)).join("┬") + "┐";
  const midBorder = "├" + cols.map((c) => "─".repeat(widths[c]!)).join("┼") + "┤";
  const bottomBorder = "└" + cols.map((c) => "─".repeat(widths[c]!)).join("┴") + "┘";

  return (
    <Box flexDirection="column">
      <Text>{topBorder}</Text>
      {/* Header */}
      <Box>
        <Text>│</Text>
        {cols.map((col, i) => (
          <React.Fragment key={col}>
            <Box width={widths[col]}>
              <Text bold> {col.toUpperCase().padEnd(widths[col]! - 1)}</Text>
            </Box>
            <Text>│</Text>
          </React.Fragment>
        ))}
      </Box>
      <Text>{midBorder}</Text>
      {/* Rows */}
      {data.map((row, ri) => (
        <Box key={ri}>
          <Text>│</Text>
          {cols.map((col) => {
            const val = String(row[col] ?? "");
            return (
              <React.Fragment key={col}>
                <Box width={widths[col]}>
                  <Text> </Text>
                  {renderCell({ children: val, column: col })}
                  <Text>{" ".repeat(Math.max(0, widths[col]! - val.length - 1))}</Text>
                </Box>
                <Text>│</Text>
              </React.Fragment>
            );
          })}
        </Box>
      ))}
      <Text>{bottomBorder}</Text>
    </Box>
  );
}
