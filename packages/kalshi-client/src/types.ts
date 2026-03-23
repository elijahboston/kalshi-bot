/** Kalshi API response types (subset relevant to climate markets) */

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  series_ticker: string;
  title: string;
  subtitle: string;
  status: "open" | "closed" | "settled" | "active";
  close_time: string;
  result: "yes" | "no" | "all_yes" | "all_no" | null | "";
  /** @deprecated — Kalshi v3 API uses *_dollars string fields now */
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  volume?: number;
  open_interest?: number;
  /** Kalshi v3 API dollar-string fields */
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  volume_fp?: string;
  open_interest_fp?: string;
  volume_24h_fp?: string;
  floor_strike?: number;
  cap_strike?: number;
}

/**
 * Parse a Kalshi market's price fields, handling both legacy (number)
 * and v3 (dollar string) formats. Returns cents (integer).
 */
export function parseMarketPrices(km: KalshiMarket): {
  lastPrice: number | null;
  yesBid: number | null;
  yesAsk: number | null;
} {
  const toCents = (v: string | number | undefined | null): number | null => {
    if (v == null) return null;
    if (typeof v === "number") return v > 0 ? v : null;
    const n = parseFloat(v);
    if (isNaN(n) || n <= 0) return null;
    return Math.round(n * 100);
  };

  return {
    lastPrice: toCents(km.last_price_dollars) ?? toCents(km.last_price),
    yesBid: toCents(km.yes_bid_dollars) ?? toCents(km.yes_bid),
    yesAsk: toCents(km.yes_ask_dollars) ?? toCents(km.yes_ask),
  };
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
  /** @deprecated — v3 uses yes_price_dollars */
  yes_price?: number;
  no_price?: number;
  /** @deprecated — v3 uses initial_count_fp */
  count?: number;
  initial_count?: number;
  fill_count?: number;
  remaining_count?: number;
  /** Kalshi v3 fields */
  yes_price_dollars?: string;
  no_price_dollars?: string;
  initial_count_fp?: string;
  fill_count_fp?: string;
  remaining_count_fp?: string;
  status: "resting" | "canceled" | "executed" | "pending";
  created_time: string;
  taker_fees?: number;
  maker_fees?: number;
  taker_fees_dollars?: string;
  maker_fees_dollars?: string;
}

/**
 * Parse a Kalshi order's quantity and price fields, handling both
 * legacy (number) and v3 (fp string / dollar string) formats.
 */
export function parseOrderFields(ko: KalshiOrder): {
  initialCount: number;
  fillCount: number;
  remainingCount: number;
  yesPrice: number;
  noPrice: number;
} {
  const toNum = (v: string | number | undefined | null): number => {
    if (v == null) return 0;
    if (typeof v === "number") return v;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  };
  const toCents = (v: string | number | undefined | null): number => {
    if (v == null) return 0;
    if (typeof v === "number") return v;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : Math.round(n * 100);
  };

  return {
    initialCount: Math.round(toNum(ko.initial_count_fp) || toNum(ko.initial_count) || toNum(ko.count)),
    fillCount: Math.round(toNum(ko.fill_count_fp) || toNum(ko.fill_count)),
    remainingCount: Math.round(toNum(ko.remaining_count_fp) || toNum(ko.remaining_count)),
    yesPrice: toCents(ko.yes_price_dollars) || ko.yes_price || 0,
    noPrice: toCents(ko.no_price_dollars) || ko.no_price || 0,
  };
}

export interface KalshiPosition {
  ticker: string;
  /** @deprecated — v3 uses position_fp */
  position?: number;
  market_exposure?: number;
  rest_of_market_exposure?: number;
  /** Kalshi v3 fields */
  position_fp?: string;
  market_exposure_dollars?: string;
  total_traded_dollars?: string;
  realized_pnl_dollars?: string;
  fees_paid_dollars?: string;
  resting_orders_count?: number;
  /** Additional fields the API may return */
  [key: string]: unknown;
}

/**
 * Parse a Kalshi position's fields, handling both legacy and v3 formats.
 */
export function parsePositionFields(kp: KalshiPosition): {
  quantity: number;
  exposure: number;
} {
  const toNum = (v: string | number | undefined | null): number => {
    if (v == null) return 0;
    if (typeof v === "number") return v;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  };
  const toCents = (v: string | number | undefined | null): number => {
    if (v == null) return 0;
    if (typeof v === "number") return v;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : Math.round(n * 100);
  };

  return {
    quantity: Math.round(Math.abs(toNum(kp.position_fp) || toNum(kp.position))),
    exposure: toCents(kp.market_exposure_dollars) || Number(kp.market_exposure) || 0,
  };
}

export interface KalshiSettlement {
  ticker: string;
  event_ticker?: string;
  market_result: "yes" | "no" | "all_yes" | "all_no";
  yes_count: number;
  yes_total_cost: number;
  no_count: number;
  no_total_cost: number;
  revenue: number;
  /** Settlement value per contract in cents (usually 100) */
  value?: number;
  fee_cost?: string;
  settled_time: string;
  [key: string]: unknown;
}

export interface KalshiBalance {
  balance: number;
  payout?: number;
  /** Kalshi v3: value of open positions in cents */
  portfolio_value?: number;
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
