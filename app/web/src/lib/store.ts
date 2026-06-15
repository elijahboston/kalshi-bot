import { create } from "zustand"
import { subscribeWithSelector } from "zustand/middleware"
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

export interface ApiStore extends ApiState {
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

// Caps for the real-time feeds — keep these in sync with reduceWsMessage.
const SIGNAL_CAP = 50
const ORDER_CAP = 100
const LOG_CAP = 500
const EVENT_CAP = 50

/**
 * Zustand store. Components subscribe to narrow slices via selectors, so a
 * high-frequency event (e.g. a log line) only re-renders components that read
 * that slice — not the whole tree. The WebSocket + REST logic lives at module
 * scope (below) and writes here via `useApiStore.setState`, so it isn't tied to
 * any component's lifecycle.
 */
export const useApiStore = create<ApiStore>()(
  subscribeWithSelector(() => ({
    ...INITIAL_STATE,
    setEquitySpan: (span: EquitySpan) => {
      useApiStore.setState({ equitySpan: span })
      refetchHistory()
    },
  })),
)

// ── WebSocket message reducer (pure, unit-tested) ──────────────
/** Side effects a WS message may trigger after its state patch is applied. */
export type WsEffect = "perf" | "markets"

/**
 * Compute the state patch and follow-up effects for an incoming WS message.
 * Pure: takes the current state and the message, returns what to apply. The
 * runtime applies the patch via setState and then runs the effects. The raw
 * `events` feed (capped) is appended for every message.
 */
export function reduceWsMessage(
  state: ApiState,
  msg: WsMessage,
): { patch: Partial<ApiState>; effects: WsEffect[] } {
  const patch: Partial<ApiState> = {}
  const effects: WsEffect[] = []

  switch (msg.type) {
    case "snapshot": {
      const snap = msg.data as WsSnapshot
      patch.status = snap.status
      patch.positions = snap.positions
      patch.balance = snap.balance
      break
    }
    case "bot:status":
      patch.status = msg.data as BotStatus
      break
    case "balance:update":
      patch.balance = msg.data as Balance
      // Dashboard stat cards read performance.cash/portfolio/realizedPnl,
      // not balance.* — refetch performance so they stay in sync.
      effects.push("perf")
      break
    case "position:update":
      // Refetch with current mode filter rather than splicing the WS payload —
      // the event doesn't carry dry_run, so a live-mode update could otherwise
      // leak into a paper-mode dashboard.
      effects.push("perf")
      break
    case "signal:new":
    case "signal:scout":
      patch.signals = [msg.data as Signal, ...state.signals].slice(0, SIGNAL_CAP)
      break
    case "order:placed":
      patch.orders = [msg.data as Order, ...state.orders].slice(0, ORDER_CAP)
      effects.push("perf")
      break
    case "order:update": {
      const upd = msg.data as { orderId: string; status: string; filledQuantity: number }
      patch.orders = state.orders.map((o) =>
        o.orderId === upd.orderId
          ? { ...o, status: upd.status, filledQuantity: upd.filledQuantity }
          : o,
      )
      effects.push("perf")
      break
    }
    case "market:discovered":
    case "market:priceUpdate":
      // Coalesced markets refetch (debounced in the runtime) — price updates
      // arrive per-market per-tick, so refetching on each would flood requests.
      effects.push("markets")
      break
    case "market:resolved":
      // Mode-scoped via the perf refetch — was previously fetching unfiltered
      // data, which polluted paper-mode dashboards with live history.
      effects.push("perf")
      break
    case "log":
      patch.logs = [...state.logs, msg.data as LogEntry].slice(-LOG_CAP)
      break
    default:
      break
  }

  // Raw event feed (capped) — appended for every message.
  patch.events = [...state.events, msg].slice(-EVENT_CAP)

  return { patch, effects }
}

// ── Runtime: REST fetches + WebSocket ──────────────────────────
async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`)
  return res.json()
}

let perfTimer: ReturnType<typeof setTimeout> | null = null
let marketsTimer: ReturnType<typeof setTimeout> | null = null
// Sequence number for /api/balance/history. Each fetch captures the seq at
// request time; on response we only apply it if still current — prevents stale
// responses (rapid span toggles, or a WS-driven refetch racing a click) from
// overwriting fresh data.
let historySeq = 0

function modeParamOf(dryRun: boolean | null | undefined): string {
  return dryRun == null ? "all" : dryRun ? "true" : "false"
}

function refetchHistory(): void {
  const { status, equitySpan } = useApiStore.getState()
  const dryRun = status?.dryRun
  if (dryRun == null) return
  const seq = ++historySeq
  const modeParam = dryRun ? "true" : "false"
  fetchJson<BalancePoint[]>(
    `/api/balance/history?limit=200&dryRun=${modeParam}&span=${equitySpan}`,
  )
    .then((eq) => {
      // Drop stale response if a newer fetch has been queued.
      if (seq === historySeq) useApiStore.setState({ equityHistory: eq })
    })
    .catch(() => {
      // Leave previous history in place on failure.
    })
}

/**
 * Debounced performance refetch — coalesces burst events (balance + order
 * updates often arrive together) into a single round-trip, scoped to the
 * active mode.
 */
function refetchPerformance(): void {
  if (perfTimer) return
  perfTimer = setTimeout(() => {
    perfTimer = null
    const s = useApiStore.getState()
    const modeParam = modeParamOf(s.status?.dryRun)
    Promise.allSettled([
      fetchJson<Performance>(`/api/performance?dryRun=${modeParam}`),
      fetchJson<Balance>(`/api/balance?dryRun=${modeParam}`),
      fetchJson<Resolution[]>(`/api/performance/resolutions?limit=10&dryRun=${modeParam}`),
      fetchJson<DailyPnl[]>(`/api/performance/daily-pnl?days=14&dryRun=${modeParam}`),
      fetchJson<WinRateWindow[]>(`/api/performance/win-rates?dryRun=${modeParam}`),
      fetchJson<DailyWinRate[]>(`/api/performance/daily-win-rates?days=84&dryRun=${modeParam}`),
      fetchJson<Position[]>(`/api/positions?dryRun=${modeParam}`),
    ]).then(([perf, bal, res, pnl, wr, dwr, pos]) => {
      const cur = useApiStore.getState()
      useApiStore.setState({
        performance: perf.status === "fulfilled" ? perf.value : cur.performance,
        balance: bal.status === "fulfilled" ? bal.value : cur.balance,
        resolutions: res.status === "fulfilled" ? res.value : cur.resolutions,
        dailyPnl: pnl.status === "fulfilled" ? pnl.value : cur.dailyPnl,
        winRates: wr.status === "fulfilled" ? wr.value : cur.winRates,
        dailyWinRates: dwr.status === "fulfilled" ? dwr.value : cur.dailyWinRates,
        positions: pos.status === "fulfilled" ? pos.value : cur.positions,
      })
    })
    // History has its own seq-tracked lifecycle so it can't be overwritten by a
    // stale request from a previous span.
    refetchHistory()
  }, 500)
}

/**
 * Debounced markets refetch — price updates arrive per-market per-tick, so this
 * coalesces a burst into one request.
 */
function refetchMarkets(): void {
  if (marketsTimer) return
  marketsTimer = setTimeout(() => {
    marketsTimer = null
    fetchJson<Market[]>("/api/markets?status=open&limit=50")
      .then((m) => useApiStore.setState({ markets: m }))
      .catch(() => {})
  }, 500)
}

function runEffect(effect: WsEffect): void {
  if (effect === "perf") refetchPerformance()
  else if (effect === "markets") refetchMarkets()
}

function handleWsMessage(raw: string): void {
  let msg: WsMessage
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  let effects: WsEffect[] = []
  useApiStore.setState((s) => {
    const r = reduceWsMessage(s, msg)
    effects = r.effects
    return r.patch
  })
  for (const e of effects) runEffect(e)
}

// ── Initial REST load ──────────────────────────────────────────
function initialLoad(): void {
  // Three-batch progressive load:
  //   Batch 1 (critical, parallel): status + performance + balance
  //     → unlocks header cards immediately; sets loading: false
  //   Batch 2 (secondary, parallel): everything else, each patches on arrival
  //   Batch 3 (re-scope): if status reveals a dryRun mode, refetch perf+balance
  //     with the mode filter to correct any cross-mode data
  const statusP = fetchJson<BotStatus>("/api/status").catch(() => null)
  const perfP = fetchJson<Performance>("/api/performance").catch(() => null)
  const balP = fetchJson<Balance>("/api/balance").catch(() => null)

  Promise.all([statusP, perfP, balP]).then(([status, performance, balance]) => {
    const modeParam = status?.dryRun ? "true" : "false"
    useApiStore.setState({ loading: false, status, performance, balance })

    fetchJson<BotConfig>("/api/config")
      .then((config) => useApiStore.setState({ config }))
      .catch(() => {})
    fetchJson<Position[]>(`/api/positions?dryRun=${modeParam}`)
      .then((positions) => useApiStore.setState({ positions }))
      .catch(() => {})
    fetchJson<Market[]>("/api/markets?status=open&limit=50")
      .then((markets) => useApiStore.setState({ markets }))
      .catch(() => {})
    fetchJson<Signal[]>(`/api/signals?limit=30&dryRun=${modeParam}`)
      .then((signals) => useApiStore.setState({ signals }))
      .catch(() => {})
    fetchJson<Order[]>(`/api/orders?limit=50&dryRun=${modeParam}`)
      .then((orders) => useApiStore.setState({ orders }))
      .catch(() => {})
    fetchJson<WinRateWindow[]>(`/api/performance/win-rates?dryRun=${modeParam}`)
      .then((winRates) => useApiStore.setState({ winRates }))
      .catch(() => {})
    fetchJson<DailyPnl[]>(`/api/performance/daily-pnl?days=14&dryRun=${modeParam}`)
      .then((dailyPnl) => useApiStore.setState({ dailyPnl }))
      .catch(() => {})
    fetchJson<DailyWinRate[]>(`/api/performance/daily-win-rates?days=84&dryRun=${modeParam}`)
      .then((dailyWinRates) => useApiStore.setState({ dailyWinRates }))
      .catch(() => {})
    fetchJson<CalibrationBucket[]>(`/api/performance/calibration?dryRun=${modeParam}`)
      .then((calibration) => useApiStore.setState({ calibration }))
      .catch(() => {})
    fetchJson<Resolution[]>(`/api/performance/resolutions?limit=10&dryRun=${modeParam}`)
      .then((resolutions) => useApiStore.setState({ resolutions }))
      .catch(() => {})
    fetchJson<LogEntry[]>("/api/logs?limit=100")
      .then((logs) => useApiStore.setState({ logs }))
      .catch(() => {})

    if (status != null) {
      fetchJson<Performance>(`/api/performance?dryRun=${modeParam}`)
        .then((p) => useApiStore.setState({ performance: p }))
        .catch(() => {})
      fetchJson<Balance>(`/api/balance?dryRun=${modeParam}`)
        .then((b) => useApiStore.setState({ balance: b }))
        .catch(() => {})
      // Now that we know the mode, fill the equity curve.
      refetchHistory()
    }
  })
}

// ── WebSocket connection with reconnect ────────────────────────
let ws: WebSocket | null = null
let retryDelay = 1000
let stopped = false
let started = false

function connect(): void {
  const sock = new WebSocket(WS_URL)
  ws = sock

  sock.onopen = () => {
    retryDelay = 1000
    useApiStore.setState({ connected: true })
    // Page may have mounted before the bot was running — refetch performance so
    // dashboard cards aren't stuck at stale initial values.
    refetchPerformance()
  }

  sock.onclose = () => {
    useApiStore.setState({ connected: false })
    if (stopped) return
    const delay = retryDelay
    retryDelay = Math.min(delay * 2, 30_000)
    setTimeout(() => {
      if (!stopped) connect()
    }, delay)
  }

  sock.onerror = () => sock.close()
  sock.onmessage = (e) => handleWsMessage(e.data as string)
}

/**
 * Start the data layer: fire the initial REST load and open the WebSocket.
 * Idempotent — safe against React StrictMode's double-invoke. Returns a
 * teardown that stops reconnection, closes the socket, and clears timers.
 */
export function initApi(): () => void {
  if (started) return teardown
  started = true
  stopped = false
  initialLoad()
  connect()
  return teardown
}

function teardown(): void {
  stopped = true
  started = false
  ws?.close()
  ws = null
  if (perfTimer) {
    clearTimeout(perfTimer)
    perfTimer = null
  }
  if (marketsTimer) {
    clearTimeout(marketsTimer)
    marketsTimer = null
  }
}
