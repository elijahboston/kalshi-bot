/** WebSocket message types mirroring BotEvents */

export type WsMessage =
  | { type: "snapshot"; data: SnapshotData }
  | { type: "signal:new"; data: SignalData }
  | { type: "order:placed"; data: OrderData }
  | { type: "order:update"; data: OrderUpdateData }
  | { type: "position:update"; data: PositionData }
  | { type: "balance:update"; data: BalanceData }
  | { type: "market:discovered"; data: MarketDiscoveredData }
  | { type: "market:resolved"; data: MarketResolvedData }
  | { type: "bot:status"; data: BotStatusData }
  | { type: "log"; data: LogData };

export type SnapshotData = {
  positions: PositionRow[];
  balance: BalanceData | null;
  stations: StationInfo[];
  recentOrders: RecentOrder[];
};

export type SignalData = {
  id: string;
  ticker: string;
  side: "yes" | "no";
  edge: number;
  confidence: number;
  recommendation: "buy_yes" | "buy_no" | "skip";
  estimatedProb: number;
  marketPrice: number;
};

export type OrderData = {
  orderId: string;
  ticker: string;
  action: "buy" | "sell";
  side: "yes" | "no";
  price: number;
  quantity: number;
  dryRun: boolean;
};

export type OrderUpdateData = {
  orderId: string;
  status: string;
  filledQuantity: number;
  ticker: string;
};

export type PositionData = {
  ticker: string;
  side: string;
  quantity: number;
  unrealizedPnl: number;
  avgEntryPrice: number;
};

export type BalanceData = {
  cash: number;
  portfolio: number;
};

export type MarketDiscoveredData = {
  ticker: string;
  eventTicker: string;
  title: string;
  category: string;
};

export type MarketResolvedData = {
  ticker: string;
  result: "yes" | "no";
  predictedProb?: number;
  realizedPnl?: number;
};

export type BotStatusData = {
  running: boolean;
  dryRun: boolean;
  lastTick: string;
  tickCount: number;
  uptime: number;
};

export type LogData = {
  level: "debug" | "info" | "warn" | "error";
  module: string;
  message: string;
  data?: unknown;
  timestamp: string;
};

export type PositionRow = {
  ticker: string;
  side: string;
  quantity: number;
  avgEntryPrice: number;
  unrealizedPnl: number | null;
};

export type StationInfo = {
  id: string;
  lat: number;
  lon: number;
  activeMarkets: number;
};

export type RecentOrder = {
  orderId: string;
  ticker: string;
  action: string;
  side: string;
  limitPrice: number;
  filledQuantity: number;
  status: string;
  createdAt: string;
};
