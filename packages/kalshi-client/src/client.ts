import { getConfig } from "@kcb/config";
import { getAuthHeaders } from "./auth";
import type {
  KalshiMarket,
  KalshiEvent,
  KalshiOrder,
  KalshiBalance,
  KalshiPosition,
  KalshiSettlement,
  CreateOrderParams,
  GetMarketsParams,
  PaginatedResponse,
} from "./types";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const FETCH_TIMEOUT_MS = 30_000;

export class KalshiClient {
  private baseUrl: string;
  private apiKey: string;
  private apiSecret: string;

  constructor(opts?: { apiKey?: string; apiSecret?: string; baseUrl?: string }) {
    const config = getConfig();
    this.apiKey = opts?.apiKey || config.kalshi.apiKey;
    this.apiSecret = opts?.apiSecret || config.kalshi.apiSecret;
    this.baseUrl = opts?.baseUrl || config.kalshi.baseUrl;
  }

  // ── Auth ──────────────────────────────────────────────────

  private buildAuthHeaders(method: string, path: string): Record<string, string> {
    return getAuthHeaders(this.apiKey, this.apiSecret, method, path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string | number | undefined>
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    // Auth headers sign against the path portion (no query string)
    const fullPath = new URL(this.baseUrl).pathname + path;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const authHeaders = this.buildAuthHeaders(method, fullPath);

      let res: Response;
      try {
        res = await fetch(url.toString(), {
          method,
          headers: {
            ...authHeaders,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        // Network errors (timeout, connection refused, DNS failure)
        if (attempt < MAX_RETRIES) {
          await Bun.sleep(BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw err;
      }

      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch {
          if (attempt < MAX_RETRIES) {
            await Bun.sleep(BASE_DELAY_MS * 2 ** attempt);
            continue;
          }
          throw new Error(`Failed to parse JSON`);
        }
      }

      // Retry transient timestamp-expired auth errors (clock skew)
      if (res.status === 401 && attempt < MAX_RETRIES) {
        const text = await res.text();
        if (text.includes("header_timestamp_expired")) {
          const delay = BASE_DELAY_MS * 2 ** attempt;
          await Bun.sleep(delay);
          continue;
        }
        throw new Error(`Kalshi ${method} ${path}: ${res.status} ${text}`);
      }

      if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < MAX_RETRIES) {
        const retryAfter = res.headers.get("Retry-After");
        const delay = retryAfter
          ? Number(retryAfter) * 1000
          : BASE_DELAY_MS * 2 ** attempt;
        await Bun.sleep(delay);
        continue;
      }

      const text = await res.text();
      if (res.status === 429 || res.status === 503 || res.status === 504) {
        throw new Error(
          `Kalshi ${method} ${path}: ${res.status} after ${MAX_RETRIES} retries: ${text}`
        );
      }
      throw new Error(`Kalshi ${method} ${path}: ${res.status} ${text}`);
    }

    // Unreachable, but TypeScript needs it
    throw new Error(`Kalshi ${method} ${path}: unexpected retry loop exit`);
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

  async getOrders(params?: { ticker?: string; status?: string; cursor?: string; limit?: number }): Promise<PaginatedResponse<KalshiOrder>> {
    return this.request("GET", "/portfolio/orders", undefined, params);
  }

  // ── Portfolio ─────────────────────────────────────────────

  async getBalance(): Promise<KalshiBalance> {
    return this.request("GET", "/portfolio/balance");
  }

  async getPositions(): Promise<{ market_positions: KalshiPosition[] }> {
    return this.request("GET", "/portfolio/positions");
  }

  // ── Settlements ─────────────────────────────────────────

  async getSettlements(params?: {
    cursor?: string;
    limit?: number;
    ticker?: string;
  }): Promise<{ cursor: string; settlements: KalshiSettlement[] }> {
    return this.request("GET", "/portfolio/settlements", undefined, params);
  }

  /** Fetch all settlement pages */
  async getAllSettlements(): Promise<KalshiSettlement[]> {
    const all: KalshiSettlement[] = [];
    let cursor: string | undefined;

    do {
      const res = await this.getSettlements({ cursor, limit: 200 });
      all.push(...(res.settlements || []));
      cursor = res.cursor || undefined;
    } while (cursor);

    return all;
  }

  /** Fetch all order pages */
  async getAllOrders(params?: { status?: string }): Promise<KalshiOrder[]> {
    const all: KalshiOrder[] = [];
    let cursor: string | undefined;

    do {
      const res = await this.getOrders({ ...params, cursor } as Record<string, string>);
      all.push(...(res.orders || []));
      cursor = res.cursor || undefined;
    } while (cursor);

    return all;
  }
}
