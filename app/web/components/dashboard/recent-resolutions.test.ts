import { test, expect, describe } from "bun:test"
import { resolutionSummary } from "./recent-resolutions"
import type { Resolution } from "@/src/lib/types"

function makeResolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    ticker: "KXHIGHNY-26JUN06-B72.5",
    category: "climate",
    predictedProb: 0.6,
    actualOutcome: 1,
    marketPrice: 0.55,
    edge: 0.05,
    realizedPnl: null,
    traded: false,
    resolvedAt: "2026-06-06T00:00:00Z",
    ...overrides,
  }
}

describe("resolutionSummary", () => {
  test("empty input → zeros", () => {
    expect(resolutionSummary([])).toEqual({ wins: 0, losses: 0, netPnl: 0 })
  })

  test("counts wins and losses by realized P&L sign", () => {
    const summary = resolutionSummary([
      makeResolution({ realizedPnl: 1.5, traded: true }),
      makeResolution({ realizedPnl: -0.75, traded: true }),
      makeResolution({ realizedPnl: 2.0, traded: true }),
    ])
    expect(summary.wins).toBe(2)
    expect(summary.losses).toBe(1)
    expect(summary.netPnl).toBeCloseTo(2.75)
  })

  test("ignores untraded resolutions with null P&L", () => {
    const summary = resolutionSummary([
      makeResolution({ realizedPnl: null }),
      makeResolution({ realizedPnl: 1.0, traded: true }),
    ])
    expect(summary).toEqual({ wins: 1, losses: 0, netPnl: 1.0 })
  })

  test("zero P&L counts as neither win nor loss", () => {
    const summary = resolutionSummary([
      makeResolution({ realizedPnl: 0, traded: true }),
    ])
    expect(summary).toEqual({ wins: 0, losses: 0, netPnl: 0 })
  })
})
