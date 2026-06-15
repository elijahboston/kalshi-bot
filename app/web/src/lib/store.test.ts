import { test, expect, describe, beforeEach } from "bun:test"
import { useApiStore, reduceWsMessage, type ApiState } from "./store"
import type { LogEntry, Signal, Order, WsMessage } from "./types"

function baseState(overrides: Partial<ApiState> = {}): ApiState {
  return { ...useApiStore.getState(), ...overrides }
}

function logMsg(message: string): WsMessage {
  return {
    type: "log",
    data: { level: "info", module: "test", message, timestamp: "t" } satisfies LogEntry,
  }
}

describe("reduceWsMessage — caps", () => {
  test("logs are capped at 500 (oldest dropped)", () => {
    const logs: LogEntry[] = Array.from({ length: 500 }, (_, i) => ({
      level: "info",
      module: "m",
      message: `old-${i}`,
      timestamp: "t",
    }))
    const { patch } = reduceWsMessage(baseState({ logs }), logMsg("new"))
    expect(patch.logs).toHaveLength(500)
    expect(patch.logs!.at(-1)!.message).toBe("new")
    expect(patch.logs!.at(0)!.message).toBe("old-1") // old-0 dropped
  })

  test("signals are capped at 50 (newest first)", () => {
    const signals = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}` })) as unknown as Signal[]
    const { patch } = reduceWsMessage(
      baseState({ signals }),
      { type: "signal:new", data: { id: "fresh" } },
    )
    expect(patch.signals).toHaveLength(50)
    expect(patch.signals![0].id).toBe("fresh")
  })

  test("orders are capped at 100 (newest first)", () => {
    const orders = Array.from({ length: 100 }, (_, i) => ({ orderId: `o${i}` })) as unknown as Order[]
    const { patch } = reduceWsMessage(
      baseState({ orders }),
      { type: "order:placed", data: { orderId: "fresh" } },
    )
    expect(patch.orders).toHaveLength(100)
    expect(patch.orders![0].orderId).toBe("fresh")
  })

  test("raw events feed is capped at 50", () => {
    const events = Array.from({ length: 50 }, (_, i) => ({ type: "x", data: i })) as WsMessage[]
    const { patch } = reduceWsMessage(baseState({ events }), logMsg("new"))
    expect(patch.events).toHaveLength(50)
    expect(patch.events!.at(-1)!.type).toBe("log")
  })
})

describe("reduceWsMessage — effects", () => {
  test("balance:update triggers a perf refetch", () => {
    const { effects } = reduceWsMessage(baseState(), { type: "balance:update", data: {} })
    expect(effects).toEqual(["perf"])
  })

  test("market:priceUpdate triggers a (debounced) markets refetch, not perf", () => {
    const { effects } = reduceWsMessage(baseState(), { type: "market:priceUpdate", data: {} })
    expect(effects).toEqual(["markets"])
  })

  test("log produces no follow-up effect", () => {
    const { effects } = reduceWsMessage(baseState(), logMsg("hi"))
    expect(effects).toEqual([])
  })
})

describe("reduceWsMessage — order:update maps in place", () => {
  test("updates status and filledQuantity of the matching order", () => {
    const orders = [
      { orderId: "a", status: "open", filledQuantity: 0 },
      { orderId: "b", status: "open", filledQuantity: 0 },
    ] as unknown as Order[]
    const { patch } = reduceWsMessage(baseState({ orders }), {
      type: "order:update",
      data: { orderId: "b", status: "filled", filledQuantity: 5 },
    })
    expect(patch.orders![0]).toMatchObject({ orderId: "a", status: "open" })
    expect(patch.orders![1]).toMatchObject({ orderId: "b", status: "filled", filledQuantity: 5 })
  })
})

describe("store selector isolation", () => {
  beforeEach(() => {
    useApiStore.setState({ logs: [], equityHistory: [] })
  })

  test("a log update re-renders log subscribers but not equity subscribers", () => {
    let logCalls = 0
    let equityCalls = 0
    const unsubLog = useApiStore.subscribe((s) => s.logs, () => { logCalls++ })
    const unsubEquity = useApiStore.subscribe((s) => s.equityHistory, () => { equityCalls++ })

    // Apply a "log" message the same way the WS runtime does.
    useApiStore.setState((s) => reduceWsMessage(s, logMsg("hello")).patch)

    expect(logCalls).toBe(1)
    expect(equityCalls).toBe(0) // equityHistory ref unchanged → no re-render

    unsubLog()
    unsubEquity()
  })
})
