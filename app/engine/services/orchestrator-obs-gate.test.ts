import { test, expect, describe } from "bun:test";
import { obsGate } from "./orchestrator";
import type { ObservationAdjustment } from "@kcb/signals";

/**
 * Unit tests for the addendum-N3 obs data-quality gate. Pure function — the
 * orchestrator ladder applies it to contrarian same-day high_temp entries inside
 * the sniper window (confirmations are exempt). These cover the exact skip-reason
 * strings and the missing/stale/fresh decision; the 90m default is passed in.
 */

const MAX_AGE = 90; // bot.obsMaxAgeMinutes default

function obs(overrides: Partial<ObservationAdjustment> = {}): ObservationAdjustment {
  return {
    observedTemp: 86,
    observedAt: "2026-06-05T21:30:00Z",
    runningMax: 87.5,
    latestAgeMinutes: 10,
    obsCount: 8,
    ...overrides,
  };
}

describe("obsGate (N3)", () => {
  test("fresh obs → no gate (null)", () => {
    expect(obsGate(obs({ latestAgeMinutes: 10 }), MAX_AGE)).toBeNull();
  });

  test("obs exactly at the max age → fresh (boundary is inclusive)", () => {
    // Gate fires only when age > maxAge; age == maxAge is allowed.
    expect(obsGate(obs({ latestAgeMinutes: 90 }), MAX_AGE)).toBeNull();
  });

  test("stale obs → exact skip-reason string with rounded age", () => {
    expect(obsGate(obs({ latestAgeMinutes: 120.7 }), MAX_AGE)).toBe(
      "obs stale (121m > 90m) in sniper window"
    );
  });

  test("just over the threshold → stale", () => {
    expect(obsGate(obs({ latestAgeMinutes: 91 }), MAX_AGE)).toBe(
      "obs stale (91m > 90m) in sniper window"
    );
  });

  test("missing obs (null) → 'no same-day obs' skip reason", () => {
    expect(obsGate(null, MAX_AGE)).toBe("no same-day obs in sniper window");
  });

  test("missing obs (undefined, e.g. NWS fetch returned nothing) → same reason", () => {
    expect(obsGate(undefined, MAX_AGE)).toBe("no same-day obs in sniper window");
  });

  test("obs present but no latestAgeMinutes → treated as fresh (no gate)", () => {
    const { latestAgeMinutes, ...rest } = obs();
    expect(obsGate(rest as ObservationAdjustment, MAX_AGE)).toBeNull();
  });

  test("threshold is configurable (passed through, not hardcoded)", () => {
    expect(obsGate(obs({ latestAgeMinutes: 45 }), 30)).toBe(
      "obs stale (45m > 30m) in sniper window"
    );
    expect(obsGate(obs({ latestAgeMinutes: 45 }), 60)).toBeNull();
  });
});
