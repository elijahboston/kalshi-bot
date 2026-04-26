import { getConfig } from "@kcb/config";
import { getAuthHeaders } from "./auth";
import type {
  WsChannel,
  WsCommand,
  WsMessage,
  WsResponse,
  WsTickerMsg,
  WsLifecycleMsg,
} from "./types";

export interface KalshiFeedOptions {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  /** Max reconnect delay in ms (default 30000) */
  maxReconnectDelay?: number;
}

export interface SequenceGap {
  sid: number;
  expected: number;
  got: number;
  /** Number of messages missed (got - expected). Positive for forward gaps. */
  missed: number;
}

export interface KalshiFeedEvents {
  onTicker?: (msg: WsTickerMsg) => void;
  onLifecycle?: (msg: WsLifecycleMsg) => void;
  onResponse?: (msg: WsResponse) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (err: Error) => void;
  /**
   * Called when a sequence gap is detected on a subscription. Gaps are
   * informational — the feed continues delivering messages. Reported
   * separately from `onError` so transport failures (which require action)
   * are not drowned out by routine packet loss.
   */
  onSequenceGap?: (gap: SequenceGap) => void;
}

/**
 * Persistent WebSocket connection to the Kalshi trade feed.
 *
 * Uses Bun's built-in WebSocket client. Handles authentication,
 * subscriptions, heartbeats, and auto-reconnection with exponential backoff.
 */
export class KalshiFeed {
  private apiKey: string;
  private apiSecret: string;
  private wsUrl: string;
  private maxReconnectDelay: number;

  private ws: WebSocket | null = null;
  private nextId = 1;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  /** Track subscription IDs returned by the server */
  private subscriptionIds: Map<WsChannel, number> = new Map();
  /** Track sequence numbers per subscription for gap detection */
  private seqNumbers: Map<number, number> = new Map();

  /** Event callbacks */
  private events: KalshiFeedEvents = {};

  constructor(opts?: KalshiFeedOptions) {
    const config = getConfig();
    this.apiKey = opts?.apiKey || config.kalshi.apiKey;
    this.apiSecret = opts?.apiSecret || config.kalshi.apiSecret;
    this.maxReconnectDelay = opts?.maxReconnectDelay ?? 30_000;

    // Derive WebSocket URL from REST baseUrl:
    //   https://api.elections.kalshi.com/trade-api/v2
    //   → wss://api.elections.kalshi.com/trade-api/ws/v2
    const base = opts?.baseUrl || config.kalshi.baseUrl;
    this.wsUrl = base
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:")
      .replace(/\/trade-api\/v2$/, "/trade-api/ws/v2");
  }

  // ── Public API ─────────────────────────────────────────────

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Register event callbacks */
  on(events: KalshiFeedEvents): void {
    Object.assign(this.events, events);
  }

  /** Open the WebSocket connection with auth */
  connect(): void {
    if (this.ws) return;
    this.intentionalClose = false;

    // Build auth headers for the WebSocket handshake path
    const wsPath = new URL(this.wsUrl).pathname;
    const authHeaders = getAuthHeaders(this.apiKey, this.apiSecret, "GET", wsPath);

    this.ws = new WebSocket(this.wsUrl, {
      headers: authHeaders,
    } as any);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.events.onConnected?.();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data as string);
    };

    this.ws.onerror = (event) => {
      const err = new Error(`WebSocket error: ${(event as ErrorEvent).message || "unknown"}`);
      this.events.onError?.(err);
    };

    this.ws.onclose = () => {
      this.ws = null;
      // Clear tracking state — subscription IDs and sequence numbers are
      // server-side state that resets on a new connection. Without this,
      // the first message after reconnect triggers a false sequence-gap
      // warning (seq resets to 1 while the client still expects old+1).
      this.subscriptionIds.clear();
      this.seqNumbers.clear();
      this.events.onDisconnected?.();

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };
  }

  /** Gracefully close the connection */
  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscriptionIds.clear();
    this.seqNumbers.clear();
  }

  /**
   * Subscribe to one or more channels, optionally filtered to specific market tickers.
   * Returns the command id for response correlation.
   */
  subscribe(channels: WsChannel[], marketTickers?: string[]): number {
    const id = this.nextId++;
    const cmd: WsCommand = {
      id,
      cmd: "subscribe",
      params: {
        channels,
        ...(marketTickers?.length ? { market_tickers: marketTickers } : {}),
      },
    };
    this.send(cmd);
    return id;
  }

  /** Unsubscribe from subscriptions by their server-assigned SIDs */
  unsubscribe(sids: number[]): number {
    const id = this.nextId++;
    const cmd: WsCommand = {
      id,
      cmd: "unsubscribe",
      params: { sids },
    };
    this.send(cmd);
    return id;
  }

  /** Add or remove market tickers from an existing subscription */
  updateSubscription(
    sids: number[],
    marketTickers: string[],
    action: "add_markets" | "remove_markets"
  ): number {
    const id = this.nextId++;
    const cmd: WsCommand = {
      id,
      cmd: "update_subscription",
      params: { sids, market_tickers: marketTickers, action },
    };
    this.send(cmd);
    return id;
  }

  /** Get the subscription ID for a channel (if subscribed) */
  getSubscriptionId(channel: WsChannel): number | undefined {
    return this.subscriptionIds.get(channel);
  }

  // ── Internals ──────────────────────────────────────────────

  private send(data: WsCommand): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.events.onError?.(new Error("WebSocket not connected, cannot send"));
      return;
    }
    this.ws.send(JSON.stringify(data));
  }

  private handleMessage(raw: string): void {
    let parsed: WsMessage;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.events.onError?.(new Error(`Failed to parse WS message: ${raw.slice(0, 200)}`));
      return;
    }

    // Handle response to our commands (subscribe/unsubscribe)
    if (parsed.type === "response") {
      const resp = parsed as WsResponse;
      if (resp.msg.error) {
        this.events.onError?.(new Error(`WS command ${resp.id} failed: ${resp.msg.error}`));
      }
      // Track subscription IDs from subscribe responses
      if (resp.msg.sids) {
        this.events.onResponse?.(resp);
      }
      return;
    }

    // Track sequence numbers for any message that carries sid/seq, even
    // unrecognized types. The server may send message types we don't handle
    // (e.g. market_lifecycle v1); skipping trackSeq for those causes false
    // off-by-one gap warnings on the next recognized message.
    const anyMsg = parsed as Record<string, unknown>;
    if (typeof anyMsg.sid === "number" && typeof anyMsg.seq === "number") {
      this.trackSeq(anyMsg.sid, anyMsg.seq);
    }

    // Handle ticker updates
    if (parsed.type === "ticker") {
      this.events.onTicker?.(parsed as WsTickerMsg);
      return;
    }

    // Handle market lifecycle events
    if (parsed.type === "market_lifecycle_v2") {
      this.events.onLifecycle?.(parsed as WsLifecycleMsg);
      return;
    }
  }

  private trackSeq(sid: number, seq: number): void {
    const prev = this.seqNumbers.get(sid);
    if (prev !== undefined && seq !== prev + 1) {
      const expected = prev + 1;
      this.events.onSequenceGap?.({
        sid,
        expected,
        got: seq,
        missed: seq - expected,
      });
    }
    this.seqNumbers.set(sid, seq);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}
