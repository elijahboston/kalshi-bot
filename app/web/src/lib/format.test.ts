import { test, expect, describe } from "bun:test"
import { fmtPrice, fmtMoney, fmtEdge } from "./format"

describe("fmtPrice", () => {
  test("formats 0-1 contract price as whole cents", () => {
    expect(fmtPrice(0.21)).toBe("21¢")
    expect(fmtPrice(0.51)).toBe("51¢")
    expect(fmtPrice(1)).toBe("100¢")
    expect(fmtPrice(0.01)).toBe("1¢")
    expect(fmtPrice(0)).toBe("0¢")
  })

  test("rounds to nearest cent", () => {
    expect(fmtPrice(0.305)).toBe("31¢")
    expect(fmtPrice(0.304)).toBe("30¢")
  })

  test("regression: sub-50¢ prices are not rendered as zero (unlike fmtMoney)", () => {
    // marketPrice is stored 0-1; fmtMoney expects integer cents and
    // rendered 0.21 as "$0.00" — the bug fmtPrice fixes.
    expect(fmtMoney(0.21)).toBe("$0.00")
    expect(fmtPrice(0.21)).toBe("21¢")
  })
})

describe("fmtEdge", () => {
  test("signs and formats edge in cents", () => {
    expect(fmtEdge(0.12)).toBe("+12.0¢")
    expect(fmtEdge(-0.05)).toBe("-5.0¢")
    expect(fmtEdge(0)).toBe("+0.0¢")
  })
})
