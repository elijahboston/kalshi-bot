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
  market_exposure: number;
  rest_of_market_exposure: number;
  fees_paid: number;
  total_traded: number;
  realized_pnl: number;
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
