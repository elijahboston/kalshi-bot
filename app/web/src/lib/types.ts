/** Bot status from GET /api/status */
export interface BotStatus {
  running: boolean
  dryRun: boolean
  tickCount: number
  lastTickAt: string
  uptime: number
}

/** Bot config from GET /api/config */
export interface BotConfig {
  bot: {
    dryRun: boolean
    tickIntervalSec: number
    edgeThreshold: number
    minConfidence: number
    maxKellyFraction: number
    maxOpenPositions: number
    maxContractsPerOrder: number
    enabledSeries: string[]
    enabledStations: string[]
    exitEdgeThreshold: number
    stopLossPct: number
    stopLossMinEdge: number
    exitTimeDaysBeforeClose: number
    exitTimeMinEdge: number
    minContractPrice: number
    exitCooldownTicks: number
    maxExposurePerTicker: number
    minBalanceFloor: number
    seedCapital: number
    profitReservePct: number
    sniperHorizonHours: number
  }
  calibration: {
    biasWindowDays: number
    calibrationWindowDays: number
    maxCalibrationError: number
  }
  log: { level: string }
}

/** Balance from GET /api/balance */
export interface Balance {
  cash: number
  portfolio: number
}

/** Balance history point from GET /api/balance/history */
export interface BalancePoint {
  totalEquity: number
  balance: number
  openPositions: number
  recordedAt: string
  dryRun?: boolean
}

/** Position from GET /api/positions */
export interface Position {
  ticker: string
  side: string
  quantity: number
  avgEntryPrice: number
  costBasis: number
  marketValue: number | null
  unrealizedPnl: number | null
  openedAt: string
  updatedAt: string
}

/** Market from GET /api/markets */
export interface Market {
  ticker: string
  eventTicker: string
  seriesTicker: string
  title: string
  category: string
  stationId: string | null
  targetDate: string | null
  bracketLow: number | null
  bracketHigh: number | null
  marketType: string
  status: string
  closeTime: string | null
  result: string | null
  lastYesPrice: number | null
  lastNoPrice: number | null
  discoveredAt: string
  updatedAt: string
}

/** Signal from GET /api/signals */
export interface Signal {
  id: string
  ticker: string
  seriesTicker: string
  estimatedProb: number
  confidence: number
  marketPrice: number
  edge: number
  edgeThreshold: number
  recommendation: string
  side: string | null
  kellyFraction: number | null
  ensembleSize: number | null
  reasoning: string | null
  acted: boolean
  orderId: string | null
  skipReason: string | null
  createdAt: string
  dryRun: boolean
}

/** Order from GET /api/orders */
export interface Order {
  orderId: string
  ticker: string
  action: string
  side: string
  limitPrice: number
  quantity: number
  filledQuantity: number
  status: string
  signalId: string | null
  dryRun: boolean
  kellyFraction: number | null
  createdAt: string
  updatedAt: string
}

/** Performance from GET /api/performance */
export interface Performance {
  cash: number
  portfolio: number
  unrealizedPnl: number
  realizedPnl: number
  winRate: number
  brierScore: number
  orderCount: number
  positionCount: number
}

/** Win rate window from GET /api/performance/win-rates */
export interface WinRateWindow {
  label: string
  wins: number
  total: number
  rate: number
}

/** Daily PnL from GET /api/performance/daily-pnl */
export interface DailyPnl {
  date: string
  pnl: number
}

/** Daily win rate from GET /api/performance/daily-win-rates */
export interface DailyWinRate {
  date: string
  total: number
  wins: number
  winRate: number
}

/** Calibration bucket from GET /api/performance/calibration */
export interface CalibrationBucket {
  bucket: string
  total: number
  actualRate: number
  avgPredicted: number
}

/** Resolution from GET /api/performance/resolutions */
export interface Resolution {
  ticker: string
  category: string
  predictedProb: number
  actualOutcome: number
  marketPrice: number
  edge: number
  realizedPnl: number | null
  traded: boolean
  resolvedAt: string
}

/** Log entry from GET /api/logs and WS "log" event */
export interface LogEntry {
  level: string
  module: string
  message: string
  timestamp: string
  data?: unknown
}

/** WebSocket snapshot (first message) */
export interface WsSnapshot {
  status: BotStatus
  positions: Position[]
  balance: Balance
}

/** WebSocket message envelope */
export interface WsMessage {
  type: string
  data: unknown
}
