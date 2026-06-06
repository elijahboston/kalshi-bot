import { test, expect, describe } from "bun:test";
import { ultraSniperThreshold } from "./orchestrator";

/**
 * Unit tests for the win-rate-80-plan #8 ultra-sniper threshold discount. Pure
 * function, no DB — covers ONLY the gating conditions, the discounted value,
 * and the 0.05 floor. The ladder integration (skip-reason annotation, persisted
 * edgeThreshold) is exercised indirectly by the orchestrator at runtime.
 */

// Defaults mirror packages/config: discount 0.10. Horizon is supplied per test
// (the shipped default is 0 = disabled; tests that exercise the "applied" path
// pass a positive horizon to simulate the runtime-enabled state).
const DISCOUNT = 0.1;

function call(
  overrides: Partial<Parameters<typeof ultraSniperThreshold>[0]> = {}
) {
  return ultraSniperThreshold({
    baseThreshold: 0.2,
    forecastHorizonHours: 2,
    config: { ultraSniperHorizonHours: 4, ultraSniperEdgeDiscount: DISCOUNT },
    hrrrMembers: 50,
    obsAnchorActive: true,
    ...overrides,
  });
}

describe("ultraSniperThreshold", () => {
  test("applies inside the window with HRRR + obs anchor", () => {
    const r = call();
    expect(r.applied).toBe(true);
    expect(r.threshold).toBeCloseTo(0.1, 10); // 0.20 − 0.10
  });

  test("does NOT apply when dark (horizon 0)", () => {
    const r = call({
      config: { ultraSniperHorizonHours: 0, ultraSniperEdgeDiscount: DISCOUNT },
    });
    expect(r.applied).toBe(false);
    expect(r.threshold).toBe(0.2); // unchanged base
  });

  test("does NOT apply outside the horizon (horizon < forecast)", () => {
    const r = call({ forecastHorizonHours: 5 }); // 5h > 4h window
    expect(r.applied).toBe(false);
    expect(r.threshold).toBe(0.2);
  });

  test("does NOT apply when forecast horizon is unknown", () => {
    // A null horizon must NOT be treated as "inside the window" — without a
    // close time we can't assert we're near close, so the discount is unsafe.
    const r = call({ forecastHorizonHours: undefined });
    expect(r.applied).toBe(false);
    expect(r.threshold).toBe(0.2);
  });

  test("does NOT apply without HRRR in the pool (hrrrMembers 0)", () => {
    const r = call({ hrrrMembers: 0 });
    expect(r.applied).toBe(false);
    expect(r.threshold).toBe(0.2);
  });

  test("does NOT apply without the obs anchor active", () => {
    const r = call({ obsAnchorActive: false });
    expect(r.applied).toBe(false);
    expect(r.threshold).toBe(0.2);
  });

  test("floors the discounted threshold at 0.05 (never sub-5¢)", () => {
    // base 0.12 − 0.10 = 0.02 → floored to 0.05.
    const r = call({ baseThreshold: 0.12 });
    expect(r.applied).toBe(true);
    expect(r.threshold).toBe(0.05);
  });

  test("floor binds exactly at base − discount == 0.05", () => {
    // base 0.15 − 0.10 = 0.05 → exactly the floor, still applied.
    const r = call({ baseThreshold: 0.15 });
    expect(r.applied).toBe(true);
    expect(r.threshold).toBeCloseTo(0.05, 10);
  });

  test("exact discounted value at the adaptive top (0.18 base)", () => {
    const r = call({ baseThreshold: 0.18 });
    expect(r.applied).toBe(true);
    expect(r.threshold).toBeCloseTo(0.08, 10); // 0.18 − 0.10
  });

  test("applies at the horizon boundary (forecast == horizon)", () => {
    const r = call({ forecastHorizonHours: 4 }); // 4h <= 4h window
    expect(r.applied).toBe(true);
    expect(r.threshold).toBeCloseTo(0.1, 10);
  });

  test("respects a custom discount value", () => {
    const r = call({
      baseThreshold: 0.2,
      config: { ultraSniperHorizonHours: 4, ultraSniperEdgeDiscount: 0.05 },
    });
    expect(r.applied).toBe(true);
    expect(r.threshold).toBeCloseTo(0.15, 10); // 0.20 − 0.05
  });
});
