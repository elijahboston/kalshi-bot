import { useState, useEffect, useRef, useCallback } from "react"
import { API_BASE, WS_URL } from "./config"
import type {
  BotStatus,
  BotConfig,
  Balance,
  BalancePoint,
  Position,
  Market,
  Signal,
  Order,
  Performance,
  WinRateWindow,
  DailyPnl,
  DailyWinRate,
  CalibrationBucket,
  Resolution,
  LogEntry,
  WsSnapshot,
  WsMessage,
} from "./types"

export type EquitySpan = "7d" | "30d" | "all"

export interface ApiState {
  /** Connection & loading state */
  connected: boolean
  loading: boolean

  /** Core state */
  status: BotStatus | null
  config: BotConfig | null
  balance: Balance | null
  positions: Position[]
  markets: Market[]
  signals: Signal[]
  orders: Order[]
  equityHistory: BalancePoint[]
  equitySpan: EquitySpan

  /** Performance */
  performance: Performance | null
  winRates: WinRateWindow[]
  dailyPnl: DailyPnl[]
  dailyWinRates: DailyWinRate[]
  calibration: CalibrationBucket[]
  resolutions: Resolution[]

  /** Real-time */
  logs: LogEntry[]
  events: WsMessage[]
}

export interface ApiContextValue extends ApiState {
  setEquitySpan: (span: EquitySpan) => void
}

const INITIAL_STATE: ApiState = {
  connected: false,
  loading: true,
  status: null,
  config: null,
  balance: null,
  positions: [],
  markets: [],
  signals: [],
  orders: [],
  equityHistory: [],
  equitySpan: "30d",
  performance: null,
  winRates: [],
  dailyPnl: [],
  dailyWinRates: [],
  calibration: [],
  resolutions: [],
  logs: [],
  events: [],
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`)
  return res.json()
}

/**
 * Main data hook. Fires parallel REST fetches on mount,
 * opens a WebSocket, and routes incoming events to state.
 */
export function useApi(): ApiContextValue {
  const [state, setState] = useState<ApiState>(INITIAL_STATE)
  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef(1000) // backoff start
  const mountedRef = useRef(true)

  const patch = useCallback(
    (p: Partial<ApiState>) => {
      if (mountedRef.current) setState((s) => ({ ...s, ...p }))
    },
    [],
  )

  const setEquitySpan = useCallback(
    (span: EquitySpan) => patch({ equitySpan: span }),
    [patch],
  )

  // ── REST initial load ──────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true

    // Three-batch progressive load:
    //   Batch 1 (critical, parallel): status + performance + balance
    //     → unlocks header cards immediately; sets loading: false
    //   Batch 2 (secondary, parallel): everything else, each patches on arrival
    //     → fills positions, markets, signals etc. as they complete
    //   Batch 3 (re-scope): if status reveals a specific dryRun mode, refetch
    //     perf+balance with the mode filter to correct any cross-mode data
    const statusP = fetchJson<BotStatus>("/api/status").catch(() => null)
    const perfP = fetchJson<Performance>("/api/performance").catch(() => null)
    const balP = fetchJson<Balance>("/api/balance").catch(() => null)

    Promise.all([statusP, perfP, balP]).then(([status, performance, balance]) => {
      if (!mountedRef.current) return
      const modeParam = status?.dryRun ? "true" : "false"
      patch({ loading: false, status, performance, balance })

      // Secondary fetches — each patches state as it arrives
      fetchJson<BotConfig>("/api/config")
        .then((config) => { if (mountedRef.current) patch({ config }) })
        .catch(() => {})
      fetchJson<Position[]>(`/api/positions?dryRun=${modeParam}`)
        .then((positions) => { if (mountedRef.current) patch({ positions }) })
        .catch(() => {})
      fetchJson<Market[]>("/api/markets?status=open&limit=50")
        .then((markets) => { if (mountedRef.current) patch({ markets }) })
        .catch(() => {})
      fetchJson<Signal[]>(`/api/signals?limit=30&dryRun=${modeParam}`)
        .then((signals) => { if (mountedRef.current) patch({ signals }) })
        .catch(() => {})
      fetchJson<Order[]>(`/api/orders?limit=50&dryRun=${modeParam}`)
        .then((orders) => { if (mountedRef.current) patch({ orders }) })
        .catch(() => {})
      fetchJson<WinRateWindow[]>(`/api/performance/win-rates?dryRun=${modeParam}`)
        .then((winRates) => { if (mountedRef.current) patch({ winRates }) })
        .catch(() => {})
      fetchJson<DailyPnl[]>(`/api/performance/daily-pnl?days=14&dryRun=${modeParam}`)
        .then((dailyPnl) => { if (mountedRef.current) patch({ dailyPnl }) })
        .catch(() => {})
      fetchJson<DailyWinRate[]>(`/api/performance/daily-win-rates?days=84&dryRun=${modeParam}`)
        .then((dailyWinRates) => { if (mountedRef.current) patch({ dailyWinRates }) })
        .catch(() => {})
      fetchJson<CalibrationBucket[]>(`/api/performance/calibration?dryRun=${modeParam}`)
        .then((calibration) => { if (mountedRef.current) patch({ calibration }) })
        .catch(() => {})
      fetchJson<Resolution[]>(`/api/performance/resolutions?limit=10&dryRun=${modeParam}`)
        .then((resolutions) => { if (mountedRef.current) patch({ resolutions }) })
        .catch(() => {})
      fetchJson<LogEntry[]>("/api/logs?limit=100")
        .then((logs) => { if (mountedRef.current) patch({ logs }) })
        .catch(() => {})

      // Re-fetch perf+balance with mode scope if the initial fetch was unfiltered
      if (status != null) {
        fetchJson<Performance>(`/api/performance?dryRun=${modeParam}`)
          .then((p) => { if (mountedRef.current) patch({ performance: p }) })
          .catch(() => {})
        fetchJson<Balance>(`/api/balance?dryRun=${modeParam}`)
          .then((b) => { if (mountedRef.current) patch({ balance: b }) })
          .catch(() => {})
      }
    })

    return () => {
      mountedRef.current = false
    }
  }, [patch])

  // ── WebSocket ──────────────────────────────────────────────
  // Debounced performance refetch — coalesces burst events (balance + order
  // updates often arrive together) into a single round-trip. Reads current
  // status from state to scope the fetches to the active mode.
  const perfRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stateRef = useRef<ApiState>(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // Sequence number for /api/balance/history requests. Every fetch captures
  // the seq at request time; on response, we only apply it if the seq is
  // still current. This prevents stale responses (from toggling spans rapidly
  // or from a WS-driven refetch racing a user click) from overwriting fresh
  // data.
  const historySeqRef = useRef(0)

  const refetchHistory = useCallback(() => {
    const dryRun = stateRef.current.status?.dryRun
    if (dryRun == null) return
    const span = stateRef.current.equitySpan
    const seq = ++historySeqRef.current
    const modeParam = dryRun ? "true" : "false"
    fetchJson<BalancePoint[]>(
      `/api/balance/history?limit=200&dryRun=${modeParam}&span=${span}`,
    )
      .then((eq) => {
        if (!mountedRef.current) return
        // Drop stale response if a newer fetch has been queued.
        if (seq !== historySeqRef.current) return
        patch({ equityHistory: eq })
      })
      .catch(() => {
        // Leave previous history in place on failure.
      })
  }, [patch])

  const refetchPerformance = useCallback(() => {
    if (perfRefetchTimer.current) return
    perfRefetchTimer.current = setTimeout(() => {
      perfRefetchTimer.current = null
      const dryRun = stateRef.current.status?.dryRun
      const modeParam = dryRun == null ? "all" : dryRun ? "true" : "false"
      Promise.allSettled([
        fetchJson<Performance>(`/api/performance?dryRun=${modeParam}`),
        fetchJson<Balance>(`/api/balance?dryRun=${modeParam}`),
        fetchJson<Resolution[]>(`/api/performance/resolutions?limit=10&dryRun=${modeParam}`),
        fetchJson<DailyPnl[]>(`/api/performance/daily-pnl?days=14&dryRun=${modeParam}`),
        fetchJson<WinRateWindow[]>(`/api/performance/win-rates?dryRun=${modeParam}`),
        fetchJson<DailyWinRate[]>(`/api/performance/daily-win-rates?days=84&dryRun=${modeParam}`),
        fetchJson<Position[]>(`/api/positions?dryRun=${modeParam}`),
      ]).then(([perf, bal, res, pnl, wr, dwr, pos]) => {
        if (!mountedRef.current) return
        patch({
          performance: perf.status === "fulfilled" ? perf.value : stateRef.current.performance,
          balance: bal.status === "fulfilled" ? bal.value : stateRef.current.balance,
          resolutions: res.status === "fulfilled" ? res.value : stateRef.current.resolutions,
          dailyPnl: pnl.status === "fulfilled" ? pnl.value : stateRef.current.dailyPnl,
          winRates: wr.status === "fulfilled" ? wr.value : stateRef.current.winRates,
          dailyWinRates: dwr.status === "fulfilled" ? dwr.value : stateRef.current.dailyWinRates,
          positions: pos.status === "fulfilled" ? pos.value : stateRef.current.positions,
        })
      })
      // History is fetched separately so it has its own seq-tracked lifecycle
      // and can't be overwritten by a stale request from a previous span.
      refetchHistory()
    }, 500)
  }, [patch, refetchHistory])

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        retryRef.current = 1000
        patch({ connected: true })
        // Page may have been mounted before the bot was running — refetch
        // performance so dashboard cards aren't stuck at stale initial values.
        refetchPerformance()
      }

      ws.onclose = () => {
        patch({ connected: false })
        // Reconnect with backoff
        const delay = retryRef.current
        retryRef.current = Math.min(delay * 2, 30_000)
        setTimeout(() => {
          if (mountedRef.current) connect()
        }, delay)
      }

      ws.onerror = () => ws.close()

      ws.onmessage = (e) => {
        let msg: WsMessage
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }

        // Route by event type
        switch (msg.type) {
          case "snapshot": {
            const snap = msg.data as WsSnapshot
            patch({
              status: snap.status,
              positions: snap.positions,
              balance: snap.balance,
            })
            break
          }
          case "bot:status":
            patch({ status: msg.data as BotStatus })
            break
          case "balance:update":
            patch({ balance: msg.data as Balance })
            // Dashboard stat cards read performance.cash/portfolio/realizedPnl,
            // not balance.* — refetch performance so they stay in sync.
            refetchPerformance()
            break
          case "position:update":
            // Refetch with current mode filter rather than splicing the WS
            // payload — the event doesn't carry dry_run, so a live-mode
            // update could otherwise leak into a paper-mode dashboard.
            refetchPerformance()
            break
          case "signal:new":
          case "signal:scout":
            setState((s) => ({
              ...s,
              signals: [msg.data as Signal, ...s.signals].slice(0, 50),
            }))
            break
          case "order:placed":
            setState((s) => ({
              ...s,
              orders: [msg.data as Order, ...s.orders].slice(0, 100),
            }))
            refetchPerformance()
            break
          case "order:update":
            setState((s) => {
              const upd = msg.data as { orderId: string; status: string; filledQuantity: number }
              return {
                ...s,
                orders: s.orders.map((o) =>
                  o.orderId === upd.orderId
                    ? { ...o, status: upd.status, filledQuantity: upd.filledQuantity }
                    : o,
                ),
              }
            })
            refetchPerformance()
            break
          case "market:discovered":
          case "market:priceUpdate":
            // Refetch markets on discovery/price change (lightweight)
            fetchJson<Market[]>("/api/markets?status=open&limit=50").then(
              (m) => patch({ markets: m }),
            )
            break
          case "market:resolved":
            // Mode-scoped via refetchPerformance — was previously fetching
            // unfiltered data, which polluted paper-mode dashboards with live
            // history.
            refetchPerformance()
            break
          case "log":
            setState((s) => ({
              ...s,
              logs: [...s.logs, msg.data as LogEntry].slice(-500),
            }))
            break
          default:
            break
        }

        // Also keep a raw event feed (last 50)
        setState((s) => ({
          ...s,
          events: [...s.events, msg].slice(-50),
        }))
      }
    }

    connect()
    return () => {
      mountedRef.current = false
      wsRef.current?.close()
    }
  }, [patch])

  // ── Equity history refetch ─────────────────────────────────
  // Fire on any change to span or mode after initial load completes. The
  // seq-tracking inside refetchHistory ensures stale responses (from an
  // older span or a concurrent WS-driven refetch) don't overwrite fresh
  // ones.
  useEffect(() => {
    if (state.loading) return
    if (state.status?.dryRun == null) return
    refetchHistory()
  }, [state.equitySpan, state.status?.dryRun, state.loading, refetchHistory])

  return { ...state, setEquitySpan }
}
