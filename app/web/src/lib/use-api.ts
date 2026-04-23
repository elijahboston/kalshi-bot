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
export function useApi(): ApiState {
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

  // ── REST initial load ──────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true

    Promise.allSettled([
      fetchJson<BotStatus>("/api/status"),
      fetchJson<BotConfig>("/api/config"),
      fetchJson<Balance>("/api/balance"),
      fetchJson<BalancePoint[]>("/api/balance/history?limit=200"),
      fetchJson<Position[]>("/api/positions"),
      fetchJson<Market[]>("/api/markets?status=open&limit=50"),
      fetchJson<Signal[]>("/api/signals?limit=30"),
      fetchJson<Order[]>("/api/orders?limit=50"),
      fetchJson<Performance>("/api/performance"),
      fetchJson<WinRateWindow[]>("/api/performance/win-rates"),
      fetchJson<DailyPnl[]>("/api/performance/daily-pnl?days=14"),
      fetchJson<DailyWinRate[]>("/api/performance/daily-win-rates?days=84"),
      fetchJson<CalibrationBucket[]>("/api/performance/calibration"),
      fetchJson<Resolution[]>("/api/performance/resolutions?limit=10"),
      fetchJson<LogEntry[]>("/api/logs?limit=100"),
    ]).then(
      ([
        status,
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
      ]) => {
        patch({
          loading: false,
          status: status.status === "fulfilled" ? status.value : null,
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
      },
    )

    return () => {
      mountedRef.current = false
    }
  }, [patch])

  // ── WebSocket ──────────────────────────────────────────────
  useEffect(() => {
    function connect() {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        retryRef.current = 1000
        patch({ connected: true })
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
            break
          case "position:update":
            setState((s) => {
              const pos = msg.data as Position
              const idx = s.positions.findIndex((p) => p.ticker === pos.ticker)
              if (idx >= 0) {
                const next = [...s.positions]
                next[idx] = pos
                return { ...s, positions: next }
              }
              return { ...s, positions: [pos, ...s.positions] }
            })
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
            break
          case "market:discovered":
          case "market:priceUpdate":
            // Refetch markets on discovery/price change (lightweight)
            fetchJson<Market[]>("/api/markets?status=open&limit=50").then(
              (m) => patch({ markets: m }),
            )
            break
          case "market:resolved":
            // Refetch performance-related data
            Promise.all([
              fetchJson<Performance>("/api/performance"),
              fetchJson<Resolution[]>("/api/performance/resolutions?limit=10"),
              fetchJson<DailyPnl[]>("/api/performance/daily-pnl?days=14"),
              fetchJson<WinRateWindow[]>("/api/performance/win-rates"),
              fetchJson<DailyWinRate[]>("/api/performance/daily-win-rates?days=84"),
            ]).then(([perf, res, pnl, wr, dwr]) => {
              patch({
                performance: perf,
                resolutions: res,
                dailyPnl: pnl,
                winRates: wr,
                dailyWinRates: dwr,
              })
            })
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

  return state
}
