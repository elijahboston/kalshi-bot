import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bus } from "../events";
import { startLogWriter } from "./log-writer";

const TEST_DIR = join(import.meta.dir, "__test_logs__");
const TEST_LOG = join(TEST_DIR, "bot.log");

function emit(level: "debug" | "info" | "warn" | "error", message: string) {
  bus.emit("log", {
    level,
    module: "test",
    message,
    timestamp: "2026-02-22T00:00:00.000Z",
  });
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("startLogWriter", () => {
  test("creates log directory and writes JSON lines", () => {
    const unsub = startLogWriter({ logPath: TEST_LOG });

    emit("info", "hello world");
    emit("warn", "something happened");

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
    const unsub = startLogWriter({ logPath: TEST_LOG });

    emit("info", "before unsub");
    unsub();
    emit("info", "after unsub");

    const content = readFileSync(TEST_LOG, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).message).toBe("before unsub");
  });

  test("skips debug entries by default", () => {
    const unsub = startLogWriter({ logPath: TEST_LOG });

    emit("debug", "noisy debug");
    emit("info", "useful info");
    emit("debug", "more debug");
    emit("error", "something broke");

    unsub();

    const content = readFileSync(TEST_LOG, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).message).toBe("useful info");
    expect(JSON.parse(lines[1]!).message).toBe("something broke");
  });

  test("minLevel=debug writes everything", () => {
    const unsub = startLogWriter({ logPath: TEST_LOG, minLevel: "debug" });

    emit("debug", "included");
    emit("info", "also included");

    unsub();

    const content = readFileSync(TEST_LOG, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
  });

  test("minLevel=error only writes errors", () => {
    const unsub = startLogWriter({ logPath: TEST_LOG, minLevel: "error" });

    emit("info", "skipped");
    emit("warn", "also skipped");
    emit("error", "included");

    unsub();

    const content = readFileSync(TEST_LOG, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).message).toBe("included");
  });

  test("rotates file at 5MB with multiple backups", () => {
    // Pre-fill the log file to just over 5MB before starting the writer
    mkdirSync(TEST_DIR, { recursive: true });
    const padding = "x".repeat(1024);
    let written = 0;
    const target = 5 * 1024 * 1024;
    const chunks: string[] = [];
    while (written < target) {
      const chunk = padding + "\n";
      chunks.push(chunk);
      written += chunk.length;
    }
    writeFileSync(TEST_LOG, chunks.join(""));

    const unsub = startLogWriter({ logPath: TEST_LOG });

    // This write should trigger rotation
    emit("info", "after rotation");

    unsub();

    // Old file should exist as .1
    expect(existsSync(TEST_LOG + ".1")).toBe(true);
    // New file should have just the one entry
    const content = readFileSync(TEST_LOG, "utf-8").trim();
    const lines = content.split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).message).toBe("after rotation");
  });

  test("shifts backups on subsequent rotations", () => {
    mkdirSync(TEST_DIR, { recursive: true });

    // Create fake pre-existing backups
    writeFileSync(TEST_LOG + ".1", "old-backup-1\n");
    writeFileSync(TEST_LOG + ".2", "old-backup-2\n");

    // Pre-fill current log to trigger rotation
    const padding = "x".repeat(5 * 1024 * 1024 + 1);
    writeFileSync(TEST_LOG, padding);

    const unsub = startLogWriter({ logPath: TEST_LOG });
    emit("info", "new entry");
    unsub();

    // .1 should be the rotated current file (the padding)
    expect(existsSync(TEST_LOG + ".1")).toBe(true);
    // .2 should be old .1
    expect(readFileSync(TEST_LOG + ".2", "utf-8")).toBe("old-backup-1\n");
    // .3 should be old .2
    expect(readFileSync(TEST_LOG + ".3", "utf-8")).toBe("old-backup-2\n");
    // Current log has the new entry
    expect(JSON.parse(readFileSync(TEST_LOG, "utf-8").trim()).message).toBe("new entry");
  });

  test("drops oldest backup beyond MAX_BACKUPS", () => {
    mkdirSync(TEST_DIR, { recursive: true });

    // Create 3 existing backups (the max)
    writeFileSync(TEST_LOG + ".1", "backup-1\n");
    writeFileSync(TEST_LOG + ".2", "backup-2\n");
    writeFileSync(TEST_LOG + ".3", "backup-3\n");

    // Pre-fill current log to trigger rotation
    const padding = "x".repeat(5 * 1024 * 1024 + 1);
    writeFileSync(TEST_LOG, padding);

    const unsub = startLogWriter({ logPath: TEST_LOG });
    emit("info", "newest");
    unsub();

    // .3 should now be old .2 (old .3 was dropped)
    expect(readFileSync(TEST_LOG + ".3", "utf-8")).toBe("backup-2\n");
    // No .4 should exist
    expect(existsSync(TEST_LOG + ".4")).toBe(false);
  });

  test("writes valid JSON on each line", () => {
    const unsub = startLogWriter({ logPath: TEST_LOG });

    for (let i = 0; i < 10; i++) {
      bus.emit("log", {
        level: "info",
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
