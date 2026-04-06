import { test, expect, describe, beforeEach, mock } from "bun:test";

mock.module("@kcb/config", () => ({
  getConfig: () => ({
    bot: {
      dryRun: true,
      tickIntervalSec: 0.05, // 50ms interval for fast testing
    },
  }),
}));

import { registerTick, startLoop, _resetForTesting } from "./loop";

beforeEach(() => {
  _resetForTesting();
});

describe("loop re-entrancy guard", () => {
  test("prevents concurrent tick execution", async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    registerTick(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate a slow tick that takes longer than the interval
      await new Promise((resolve) => setTimeout(resolve, 150));
      concurrentCount--;
    });

    startLoop();

    // Wait long enough for the interval to fire multiple times
    // while the first tick (150ms) is still running
    await new Promise((resolve) => setTimeout(resolve, 300));
    _resetForTesting();

    // Without the guard, concurrent ticks would pile up
    expect(maxConcurrent).toBe(1);
  });

  test("allows next tick after slow tick completes", async () => {
    let tickCount = 0;

    registerTick(async () => {
      tickCount++;
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    startLoop();

    // Wait for first tick (10ms) + interval (50ms) + second tick (10ms) + buffer
    await new Promise((resolve) => setTimeout(resolve, 200));
    _resetForTesting();

    // Should have completed multiple ticks sequentially
    expect(tickCount).toBeGreaterThanOrEqual(2);
  });
});
