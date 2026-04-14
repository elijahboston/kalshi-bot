import { EventEmitter } from "node:events";

/**
 * All events the bot engine can emit.
 * The CLI subscribes to these for real-time UI updates.
 */
export type BotEvents = {
  "bot:status": {
    running: boolean;
    dryRun: boolean;
    lastTick: string;
    tickCount: number;
    uptime: number;
  };
  "bot:error": {
    module: string;
    message: string;
    error?: unknown;
  };
  "signal:new": {
    id: string;
    ticker: string;
    side: "yes" | "no";
    edge: number;
    confidence: number;
    recommendation: "buy_yes" | "buy_no" | "skip";
    estimatedProb: number;
    marketPrice: number;
    forecastHorizonHours?: number;
    sigmaSource?: "empirical" | "ensemble";
    sigmaUsed?: number;
    hrrrActive?: boolean;
    observationTemp?: number;
  };
  "signal:scout": {
    id: string;
    ticker: string;
    side: "yes" | "no";
    edge: number;
    confidence: number;
    estimatedProb: number;
    marketPrice: number;
    forecastHorizonHours: number;
    sigmaSource?: "empirical" | "ensemble";
  };
  "forecast:fetched": {
    stationId: string;
    sources: {
      openMeteo: number;
      hrrr: number;
      tomorrowIo: number;
    };
    hrrrValue?: number;
    horizonBucket: string;
    hrrrWeight: number;
  };
  "order:placed": {
    orderId: string;
    ticker: string;
    action: "buy" | "sell";
    side: "yes" | "no";
    price: number;
    quantity: number;
    dryRun: boolean;
  };
  "order:update": {
    orderId: string;
    status: string;
    filledQuantity: number;
    ticker: string;
  };
  "position:update": {
    ticker: string;
    side: string;
    quantity: number;
    unrealizedPnl: number;
    avgEntryPrice: number;
  };
  "balance:update": {
    cash: number;
    portfolio: number;
  };
  "market:discovered": {
    ticker: string;
    eventTicker: string;
    title: string;
    category: string;
  };
  "market:priceUpdate": {
    ticker: string;
    yesPrice: number;
    noPrice: number;
    volume: number;
    openInterest: number;
    ts: number;
  };
  "market:resolved": {
    ticker: string;
    result: "yes" | "no";
    predictedProb?: number;
    realizedPnl?: number;
  };
  "calibration:updated": {
    ticker: string;
    predictedProb: number;
    actualOutcome: number;
    calibrationError: number;
    brierScore: number;
  };
  "log": {
    level: "debug" | "info" | "warn" | "error";
    module: string;
    message: string;
    data?: unknown;
    timestamp: string;
  };
};

/**
 * Type-safe event emitter for the bot engine.
 *
 * Usage:
 *   bus.emit("signal:new", { ticker: "...", ... })
 *   const unsub = bus.on("signal:new", (data) => { ... })
 *   unsub() // cleanup
 */
class TypedEmitter {
  private ee = new EventEmitter();

  constructor() {
    // Increase limit for many UI subscriptions
    this.ee.setMaxListeners(50);
  }

  emit<K extends keyof BotEvents>(event: K, data: BotEvents[K]): void {
    this.ee.emit(event, data);
  }

  on<K extends keyof BotEvents>(
    event: K,
    handler: (data: BotEvents[K]) => void
  ): () => void {
    this.ee.on(event, handler);
    return () => {
      this.ee.off(event, handler);
    };
  }

  once<K extends keyof BotEvents>(
    event: K,
    handler: (data: BotEvents[K]) => void
  ): void {
    this.ee.once(event, handler);
  }

  /** Get the underlying emitter for advanced use (pipe to log file, etc.) */
  raw(): EventEmitter {
    return this.ee;
  }
}

/** Singleton event bus — shared between engine and CLI */
export const bus = new TypedEmitter();

/**
 * Convenience logger that emits to the bus.
 * All engine modules should use this instead of console.log.
 */
export function createLogger(module: string) {
  const log = (level: BotEvents["log"]["level"], message: string, data?: unknown) => {
    const entry: BotEvents["log"] = {
      level,
      module,
      message,
      data: data instanceof Error
        ? { message: data.message, stack: data.stack, name: data.name }
        : data,
      timestamp: new Date().toISOString(),
    };
    bus.emit("log", entry);

    // Also write to stderr for debugging outside the TUI
    if (level === "error") {
      console.error(`[${module}] ${message}`, data || "");
    }
  };

  return {
    debug: (msg: string, data?: unknown) => log("debug", msg, data),
    info: (msg: string, data?: unknown) => log("info", msg, data),
    warn: (msg: string, data?: unknown) => log("warn", msg, data),
    error: (msg: string, data?: unknown) => log("error", msg, data),
  };
}
