import { test, expect, describe } from "bun:test"
import { buildGrid, intensityClass } from "./weekly-win-rate-heatmap"
import type { DailyWinRate } from "@/src/lib/types"

describe("buildGrid", () => {
  test("returns 12 weeks × 7 days", () => {
    const grid = buildGrid([], new Date("2026-04-23T00:00:00"))
    expect(grid).toHaveLength(12)
    for (const col of grid) expect(col).toHaveLength(7)
  })

  test("last column includes today and ends on Saturday", () => {
    // 2026-04-23 is a Thursday
    const today = new Date(2026, 3, 23) // month is 0-indexed
    const grid = buildGrid([], today)
    const lastCol = grid[11]

    // First day of last column is Sunday; day-of-week of col[0] must be 0
    expect(lastCol[0].date.getDay()).toBe(0)
    // Today (Thu = dow 4) appears at index 4
    expect(lastCol[4].key).toBe("2026-04-23")
  })

  test("first day is a Sunday", () => {
    const grid = buildGrid([], new Date(2026, 3, 23))
    expect(grid[0][0].date.getDay()).toBe(0)
  })

  test("attaches stats to matching dates", () => {
    const stats: DailyWinRate[] = [
      { date: "2026-04-20", total: 2, wins: 1, winRate: 0.5 },
      { date: "2026-04-22", total: 3, wins: 3, winRate: 1 },
    ]
    const grid = buildGrid(stats, new Date(2026, 3, 23))
    const flat = grid.flat()
    const apr20 = flat.find((c) => c.key === "2026-04-20")!
    const apr22 = flat.find((c) => c.key === "2026-04-22")!
    const apr21 = flat.find((c) => c.key === "2026-04-21")!
    expect(apr20.stat).toEqual(stats[0])
    expect(apr22.stat).toEqual(stats[1])
    expect(apr21.stat).toBeNull()
  })

  test("future dates in last column get null stat", () => {
    const today = new Date(2026, 3, 23) // Thursday
    const stats: DailyWinRate[] = [
      // A "future" row that shouldn't happen in prod, but test the mask
      { date: "2026-04-25", total: 1, wins: 1, winRate: 1 },
    ]
    const grid = buildGrid(stats, today)
    const flat = grid.flat()
    const apr25 = flat.find((c) => c.key === "2026-04-25")!
    expect(apr25.stat).toBeNull()
  })
})

describe("intensityClass", () => {
  test("null or zero-total → muted", () => {
    expect(intensityClass(null)).toBe("bg-muted")
    expect(intensityClass({ date: "x", total: 0, wins: 0, winRate: 0 })).toBe("bg-muted")
  })

  test("win rate maps to five buckets", () => {
    const stat = (r: number): DailyWinRate => ({ date: "x", total: 1, wins: 0, winRate: r })
    expect(intensityClass(stat(0))).toBe("bg-[hsl(152_60%_42%/0.15)]")
    expect(intensityClass(stat(0.2))).toBe("bg-[hsl(152_60%_42%/0.15)]")
    expect(intensityClass(stat(0.3))).toBe("bg-[hsl(152_60%_42%/0.35)]")
    expect(intensityClass(stat(0.6))).toBe("bg-[hsl(152_60%_42%/0.6)]")
    expect(intensityClass(stat(0.85))).toBe("bg-[hsl(152_60%_42%/0.85)]")
    expect(intensityClass(stat(1))).toBe("bg-[hsl(152_60%_42%)]")
  })
})
