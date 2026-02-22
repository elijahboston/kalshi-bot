/** Kalshi API response types (subset relevant to climate markets) */

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  series_ticker: string;
  title: string;
  subtitle: string;
  status: "open" | "closed" | "settled";
  close_time: string;
  result: "yes" | "no" | "all_yes" | "all_no" | null;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  open_interest: number;
  floor_strike?: number;
  cap_strike?: number;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  category: string;
  markets: KalshiMarket[];
}

export interface KalshiOrder {
  order_id: string;
  ticker: string;
  action: "buy" | "sell";
  side: "yes" | "no";
  type: "limit" | "market";
  yes_price: number;
  no_price: number;
  count: number;
  remaining_count: number;
  status: "resting" | "canceled" | "executed" | "pending";
  created_time: string;
}

export interface KalshiPosition {
  ticker: string;
  /** Net contract count (positive = long, may indicate side) */
  position?: number;
  market_exposure?: number;
  rest_of_market_exposure?: number;
  fees_paid?: number;
  total_traded?: number;
  realized_pnl?: number;
  /** Additional fields the API may return */
  [key: string]: unknown;
}

export interface KalshiSettlement {
  ticker: string;
  market_result: "yes" | "no" | "all_yes" | "all_no";
  yes_count: number;
  yes_total_cost: number;
  no_count: number;
  no_total_cost: number;
  revenue: number;
  realized_pnl: number;
  settled_time: string;
  [key: string]: unknown;
}

export interface KalshiBalance {
  balance: number;
  payout: number;
}

export interface CreateOrderParams {
  ticker: string;
  action: "buy" | "sell";
  side: "yes" | "no";
  type: "limit" | "market";
  count: number;
  yes_price?: number;
  no_price?: number;
}

export interface GetMarketsParams {
  cursor?: string;
  limit?: number;
  status?: "open" | "closed" | "settled";
  series_ticker?: string;
  event_ticker?: string;
  tickers?: string;
}

export interface PaginatedResponse<T> {
  cursor: string;
  markets?: T[];
  events?: T[];
  orders?: T[];
}

// ── WebSocket types ──────────────────────────────────────────

export type WsChannel = "ticker" | "market_lifecycle_v2";

export interface WsSubscribeCmd {
  id: number;
  cmd: "subscribe";
  params: {
    channels: WsChannel[];
    market_tickers?: string[];
  };
}

export interface WsUnsubscribeCmd {
  id: number;
  cmd: "unsubscribe";
  params: {
    sids: number[];
  };
}

export interface WsUpdateSubscriptionCmd {
  id: number;
  cmd: "update_subscription";
  params: {
    sids: number[];
    market_tickers: string[];
    action: "add_markets" | "remove_markets";
  };
}

export type WsCommand = WsSubscribeCmd | WsUnsubscribeCmd | WsUpdateSubscriptionCmd;

export interface WsResponse {
  id: number;
  type: "response";
  msg: {
    /** Subscription IDs created (one per channel) */
    sids?: number[];
    error?: string;
  };
}

export interface WsTickerMsg {
  type: "ticker";
  sid: number;
  seq: number;
  msg: {
    market_ticker: string;
    price: number;
    yes_bid: number;
    yes_ask: number;
    no_bid: number;
    no_ask: number;
    volume: number;
    open_interest: number;
    ts: number;
  };
}

export interface WsLifecycleMsg {
  type: "market_lifecycle_v2";
  sid: number;
  seq: number;
  msg: {
    market_ticker: string;
    event_type: "new_market" | "settled" | "closed" | "close_time_update";
    status?: "open" | "closed" | "settled";
    result?: "yes" | "no" | "all_yes" | "all_no" | null;
    title?: string;
    close_time?: string;
    series_ticker?: string;
    event_ticker?: string;
  };
}

export type WsMessage = WsResponse | WsTickerMsg | WsLifecycleMsg;
