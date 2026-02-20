import { getConfig } from "@kcb/config";
import type {
  KalshiMarket,
  KalshiEvent,
  KalshiOrder,
  KalshiBalance,
  KalshiPosition,
  CreateOrderParams,
  GetMarketsParams,
  PaginatedResponse,
} from "./types";

export class KalshiClient {
  private baseUrl: string;
  private apiKey: string;
  private apiSecret: string;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(opts?: { apiKey?: string; apiSecret?: string; baseUrl?: string }) {
    const config = getConfig();
    this.apiKey = opts?.apiKey || config.kalshi.apiKey;
    this.apiSecret = opts?.apiSecret || config.kalshi.apiSecret;
    this.baseUrl = opts?.baseUrl || config.kalshi.baseUrl;
  }

  // ── Auth ──────────────────────────────────────────────────

  private async ensureAuth(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.token;
    }
    const res = await fetch(`${this.baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: this.apiKey,
        password: this.apiSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`Kalshi auth failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { token: string; member_id: string };
    this.token = data.token;
    // Tokens typically last 24h, refresh well before
    this.tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
    return this.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string | number | undefined>
  ): Promise<T> {
    const token = await this.ensureAuth();
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kalshi ${method} ${path}: ${res.status} ${text}`);
    }

    return res.json() as T;
  }

  // ── Markets ───────────────────────────────────────────────

  async getMarkets(params?: GetMarketsParams): Promise<PaginatedResponse<KalshiMarket>> {
    return this.request("GET", "/markets", undefined, params as Record<string, string>);
  }

  /** Fetch all pages for a given filter */
  async getAllMarkets(params?: Omit<GetMarketsParams, "cursor">): Promise<KalshiMarket[]> {
    const all: KalshiMarket[] = [];
    let cursor: string | undefined;

    do {
      const res = await this.getMarkets({ ...params, cursor, limit: 200 });
      all.push(...(res.markets || []));
      cursor = res.cursor || undefined;
    } while (cursor);

    return all;
  }

  async getMarket(ticker: string): Promise<{ market: KalshiMarket }> {
    return this.request("GET", `/markets/${ticker}`);
  }

  async getEvent(eventTicker: string): Promise<{ event: KalshiEvent }> {
    return this.request("GET", `/events/${eventTicker}`);
  }

  // ── Trading ───────────────────────────────────────────────

  async createOrder(params: CreateOrderParams): Promise<{ order: KalshiOrder }> {
    return this.request("POST", "/portfolio/orders", params);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request("DELETE", `/portfolio/orders/${orderId}`);
  }

  async getOrders(params?: { ticker?: string; status?: string }): Promise<PaginatedResponse<KalshiOrder>> {
    return this.request("GET", "/portfolio/orders", undefined, params);
  }

  // ── Portfolio ─────────────────────────────────────────────

  async getBalance(): Promise<KalshiBalance> {
    return this.request("GET", "/portfolio/balance");
  }

  async getPositions(): Promise<{ market_positions: KalshiPosition[] }> {
    return this.request("GET", "/portfolio/positions");
  }
}
