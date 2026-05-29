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

    // Two-phase load: status first to determine paper/live mode, then the rest
    // with mode-scoped filters so charts/stats aren't mingled.
    fetchJson<BotStatus>("/api/status")
      .then((status) => {
        if (!mountedRef.current) return
        const modeParam = status.dryRun ? "true" : "false"
        patch({ status })

        return Promise.allSettled([
          fetchJson<BotConfig>("/api/config"),
          fetchJson<Balance>(`/api/balance?dryRun=${modeParam}`),
          fetchJson<BalancePoint[]>(`/api/balance/history?limit=200&dryRun=${modeParam}&span=30d`),
          fetchJson<Position[]>(`/api/positions?dryRun=${modeParam}`),
          fetchJson<Market[]>("/api/markets?status=open&limit=50"),
          fetchJson<Signal[]>(`/api/signals?limit=30&dryRun=${modeParam}`),
          fetchJson<Order[]>(`/api/orders?limit=50&dryRun=${modeParam}`),
          fetchJson<Performance>(`/api/performance?dryRun=${modeParam}`),
          fetchJson<WinRateWindow[]>(`/api/performance/win-rates?dryRun=${modeParam}`),
          fetchJson<DailyPnl[]>(`/api/performance/daily-pnl?days=14&dryRun=${modeParam}`),
          fetchJson<DailyWinRate[]>(`/api/performance/daily-win-rates?days=84&dryRun=${modeParam}`),
          fetchJson<CalibrationBucket[]>(`/api/performance/calibration?dryRun=${modeParam}`),
          fetchJson<Resolution[]>(`/api/performance/resolutions?limit=10&dryRun=${modeParam}`),
          fetchJson<LogEntry[]>("/api/logs?limit=100"),
        ])
      })
      .then((results) => {
        if (!results || !mountedRef.current) return
        const [
          config,
          balance,
          equityHistory,
          positions,
          markets,
          signals,
          orders,
          performance,
          winRates,
          dailyPnl,
          dailyWinRates,
          calibration,
          resolutions,
          logs,
        ] = results

        patch({
          loading: false,
          config: config.status === "fulfilled" ? config.value : null,
          balance: balance.status === "fulfilled" ? balance.value : null,
          equityHistory:
            equityHistory.status === "fulfilled" ? equityHistory.value : [],
          positions:
            positions.status === "fulfilled" ? positions.value : [],
          markets: markets.status === "fulfilled" ? markets.value : [],
          signals: signals.status === "fulfilled" ? signals.value : [],
          orders: orders.status === "fulfilled" ? orders.value : [],
          performance:
            performance.status === "fulfilled" ? performance.value : null,
          winRates:
            winRates.status === "fulfilled" ? winRates.value : [],
          dailyPnl:
            dailyPnl.status === "fulfilled" ? dailyPnl.value : [],
          dailyWinRates:
            dailyWinRates.status === "fulfilled" ? dailyWinRates.value : [],
          calibration:
            calibration.status === "fulfilled" ? calibration.value : [],
          resolutions:
            resolutions.status === "fulfilled" ? resolutions.value : [],
          logs: logs.status === "fulfilled" ? logs.value : [],
        })
      })
      .catch(() => {
        // Status fetch failed — leave loading true so the UI shows its
        // disconnected state via the WS onopen/onclose handlers.
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

  const refetchPerformance = useCallback(() => {
    if (perfRefetchTimer.current) return
    perfRefetchTimer.current = setTimeout(() => {
      perfRefetchTimer.current = null
      const dryRun = stateRef.current.status?.dryRun
      const modeParam = dryRun == null ? "all" : dryRun ? "true" : "false"
      const span = stateRef.current.equitySpan
      Promise.allSettled([
        fetchJson<Performance>(`/api/performance?dryRun=${modeParam}`),
        fetchJson<Balance>(`/api/balance?dryRun=${modeParam}`),
        fetchJson<Resolution[]>(`/api/performance/resolutions?limit=10&dryRun=${modeParam}`),
        fetchJson<DailyPnl[]>(`/api/performance/daily-pnl?days=14&dryRun=${modeParam}`),
        fetchJson<WinRateWindow[]>(`/api/performance/win-rates?dryRun=${modeParam}`),
        fetchJson<DailyWinRate[]>(`/api/performance/daily-win-rates?days=84&dryRun=${modeParam}`),
        fetchJson<BalancePoint[]>(`/api/balance/history?limit=200&dryRun=${modeParam}&span=${span}`),
        fetchJson<Position[]>(`/api/positions?dryRun=${modeParam}`),
      ]).then(([perf, bal, res, pnl, wr, dwr, eq, pos]) => {
        if (!mountedRef.current) return
        patch({
          performance: perf.status === "fulfilled" ? perf.value : stateRef.current.performance,
          balance: bal.status === "fulfilled" ? bal.value : stateRef.current.balance,
          resolutions: res.status === "fulfilled" ? res.value : stateRef.current.resolutions,
          dailyPnl: pnl.status === "fulfilled" ? pnl.value : stateRef.current.dailyPnl,
          winRates: wr.status === "fulfilled" ? wr.value : stateRef.current.winRates,
          dailyWinRates: dwr.status === "fulfilled" ? dwr.value : stateRef.current.dailyWinRates,
          equityHistory: eq.status === "fulfilled" ? eq.value : stateRef.current.equityHistory,
          positions: pos.status === "fulfilled" ? pos.value : stateRef.current.positions,
        })
      })
    }, 500)
  }, [patch])

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

  // ── Equity span refetch ────────────────────────────────────
  // Refetch /api/balance/history when span or mode changes. Initialized to
  // match the initial fetch (span=30d + current dryRun) so the first run
  // after the initial load doesn't fire a duplicate request.
  const lastHistoryFetchRef = useRef<{ span: EquitySpan; dryRun: boolean | null }>({
    span: "30d",
    dryRun: null,
  })
  useEffect(() => {
    if (state.loading) return
    const dryRun = state.status?.dryRun ?? null
    const last = lastHistoryFetchRef.current
    if (last.dryRun === null) {
      // First post-load invocation: initial fetch already supplied this combo.
      lastHistoryFetchRef.current = { span: state.equitySpan, dryRun }
      return
    }
    if (last.span === state.equitySpan && last.dryRun === dryRun) return
    lastHistoryFetchRef.current = { span: state.equitySpan, dryRun }
    const modeParam = dryRun == null ? "all" : dryRun ? "true" : "false"
    fetchJson<BalancePoint[]>(
      `/api/balance/history?limit=200&dryRun=${modeParam}&span=${state.equitySpan}`,
    )
      .then((eq) => {
        if (mountedRef.current) patch({ equityHistory: eq })
      })
      .catch(() => {
        // Leave previous history in place on failure.
      })
  }, [state.equitySpan, state.status?.dryRun, state.loading, patch])

  return { ...state, setEquitySpan }
}
