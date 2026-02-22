import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bus } from "../events";
import { startLogWriter } from "./log-writer";

const TEST_DIR = join(import.meta.dir, "__test_logs__");
const TEST_LOG = join(TEST_DIR, "bot.log");

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("startLogWriter", () => {
  test("creates log directory and writes JSON lines", () => {
    const unsub = startLogWriter(TEST_LOG);

    bus.emit("log", {
      level: "info",
      module: "test",
      message: "hello world",
      timestamp: "2026-02-22T00:00:00.000Z",
    });

    bus.emit("log", {
      level: "warn",
      module: "test",
      message: "something happened",
      timestamp: "2026-02-22T00:00:01.000Z",
    });

    unsub();

    expect(existsSync(TEST_LOG)).toBe(true);
    const content = readFileSync(TEST_LOG, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const entry1 = JSON.parse(lines[0]!);
    expect(entry1.level).toBe("info");
    expect(entry1.module).toBe("test");
    expect(entry1.message).toBe("hello world");

    const entry2 = JSON.parse(lines[1]!);
    expect(entry2.level).toBe("warn");
    expect(entry2.message).toBe("something happened");
  });

  test("unsubscribe stops writing", () => {
    const unsub = startLogWriter(TEST_LOG);

    bus.emit("log", {
      level: "info",
      module: "test",
      message: "before unsub",
      timestamp: "2026-02-22T00:00:00.000Z",
    });

    unsub();

    bus.emit("log", {
      level: "info",
      module: "test",
      message: "after unsub",
      timestamp: "2026-02-22T00:00:01.000Z",
    });

    const content = readFileSync(TEST_LOG, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).message).toBe("before unsub");
  });

  test("rotates file when exceeding 10MB", () => {
    const unsub = startLogWriter(TEST_LOG);

    // Pre-fill the log file to just under 10MB
    mkdirSync(TEST_DIR, { recursive: true });
    const padding = "x".repeat(1024);
    let written = 0;
    const target = 10 * 1024 * 1024; // 10MB
    const chunk = padding + "\n";
    const chunks: string[] = [];
    while (written < target) {
      chunks.push(chunk);
      written += chunk.length;
    }
    writeFileSync(TEST_LOG, chunks.join(""));

    // This write should trigger rotation
    bus.emit("log", {
      level: "info",
      module: "test",
      message: "after rotation",
      timestamp: "2026-02-22T00:00:00.000Z",
    });

    unsub();

    // Old file should exist as .1
    expect(existsSync(TEST_LOG + ".1")).toBe(true);
    // New file should have just the one entry
    const content = readFileSync(TEST_LOG, "utf-8").trim();
    const lines = content.split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).message).toBe("after rotation");
  });

  test("writes valid JSON on each line", () => {
    const unsub = startLogWriter(TEST_LOG);

    for (let i = 0; i < 10; i++) {
      bus.emit("log", {
        level: "debug",
        module: "test",
        message: `entry ${i}`,
        data: { index: i, nested: { value: true } },
        timestamp: new Date().toISOString(),
      });
    }

    unsub();

    const content = readFileSync(TEST_LOG, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(10);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
