export interface BotConfig {
  /** Kalshi API credentials */
  kalshi: {
    apiKey: string;
    apiSecret: string;
    baseUrl: string;
  };

  /** Weather data sources */
  weather: {
    openweatherApiKey?: string;
    tomorrowIoApiKey?: string;
  };

  /** Core bot parameters */
  bot: {
    /** Don't place real orders */
    dryRun: boolean;
    /** Main loop interval in seconds */
    tickIntervalSec: number;
    /** Minimum edge to trade (0-1) */
    edgeThreshold: number;
    /** Minimum confidence to trade (0-1) */
    minConfidence: number;
    /** Maximum fraction of bankroll per trade (Kelly cap) */
    maxKellyFraction: number;
    /** Maximum number of concurrent open positions */
    maxOpenPositions: number;
    /** Maximum contracts per order */
    maxContractsPerOrder: number;
    /** Series tickers to trade, empty = all climate */
    enabledSeries: string[];
    /** Stations to track */
    enabledStations: string[];
    /** Exit when held-side edge drops below this (0-1) */
    exitEdgeThreshold: number;
    /** Exit when unrealized loss exceeds this fraction of cost basis */
    stopLossPct: number;
    /** Stop-loss only fires when held-side edge has also compressed below this (0-1) */
    stopLossMinEdge: number;
    /** Start exit evaluation this many days before market close */
    exitTimeDaysBeforeClose: number;
    /** When inside exit time window, only keep positions with edge above this */
    exitTimeMinEdge: number;
    /** Minimum contract price in cents to avoid buying lottery tickets */
    minContractPrice: number;
    /** Number of ticks to wait before re-entering a ticker after exit */
    exitCooldownTicks: number;
    /** Maximum total buy cost per ticker in cents (e.g. 500 = $5) */
    maxExposurePerTicker: number;
    /** Minimum balance floor in cents — bot won't trade below this */
    minBalanceFloor: number;
    /** Total deposited capital in cents — used to compute profits */
    seedCapital: number;
    /** Fraction of profits to reserve (0-1). e.g. 0.5 = keep 50% of winnings */
    profitReservePct: number;
    /** Hours before market close when sniper mode activates (0 = disabled) */
    sniperHorizonHours: number;
    /** Minimum bet size in cents — skip signals whose Kelly-sized bet falls below this (0 = disabled) */
    minBetSizeCents: number;
    /** Flat bet size in cents — when > 0, overrides Kelly-based dollar sizing; Kelly still gates EV sign (0 = disabled) */
    flatBetSizeCents: number;
    /** Confidence threshold (0-1) above which signals scale up to highConfidenceBetSizeCents. 0 = disabled (always use flatBetSizeCents) */
    highConfidenceThreshold: number;
    /** Bet size in cents applied when signal.confidence >= highConfidenceThreshold */
    highConfidenceBetSizeCents: number;
    /** Weight (0-1) for blending historicalHitRate into the estimator's final probability (0 = disabled) */
    historicalPriorWeight: number;
    /** Weight (0-1) for blending market price into the estimator's final probability (0 = disabled). The market is empirically better-calibrated than the model — see improvements/market-prior-2026-05-29.md. */
    marketPriorWeight: number;
    /** Max contract entry price (0-1) for tail markets (upper_tail/lower_tail). 0 = gate disabled. Tails historically bled — see improvements/tail-gate-2026-05-29.md. */
    tailMaxEntryPrice: number;
  };

  /** Calibration parameters */
  calibration: {
    /** Rolling window for bias calculation (days) */
    biasWindowDays: number;
    /** Rolling window for calibration scoring (days) */
    calibrationWindowDays: number;
    /** Max calibration error before adjusting threshold */
    maxCalibrationError: number;
  };

  /** Storage */
  db: {
    path: string;
  };

  /** Logging */
  log: {
    level: "debug" | "info" | "warn" | "error";
  };

  /** Optional AI integration */
  ai?: {
    anthropicApiKey?: string;
  };
}

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

function env(key: string, fallback = ""): string {
  return process.env[key] || fallback;
}

/** Read a secret from a file path specified by an env var */
function envFile(key: string, fallback = ""): string {
  const filePath = process.env[key];
  if (!filePath) return fallback;
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) return fallback;
  return readFileSync(resolved, "utf-8").trim();
}

function envBool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v === "true" || v === "1";
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

/** Map runtime_config DB keys to config paths */
const RUNTIME_CONFIG_MAP: Record<string, (config: BotConfig, value: string) => void> = {
  dry_run: (c, v) => { c.bot.dryRun = v === "true" || v === "1"; },
  edge_threshold: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.edgeThreshold = n; },
  min_confidence: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.minConfidence = n; },
  max_kelly_fraction: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.maxKellyFraction = n; },
  max_open_positions: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.maxOpenPositions = n; },
  max_contracts_per_order: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.maxContractsPerOrder = n; },
  tick_interval_sec: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.tickIntervalSec = n; },
  bias_window_days: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.calibration.biasWindowDays = n; },
  calibration_window_days: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.calibration.calibrationWindowDays = n; },
  max_calibration_error: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.calibration.maxCalibrationError = n; },
  log_level: (c, v) => { if (["debug","info","warn","error"].includes(v)) c.log.level = v as BotConfig["log"]["level"]; },
  exit_edge_threshold: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.exitEdgeThreshold = n; },
  stop_loss_pct: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.stopLossPct = n; },
  stop_loss_min_edge: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.stopLossMinEdge = n; },
  exit_time_days_before_close: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.exitTimeDaysBeforeClose = n; },
  exit_time_min_edge: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.exitTimeMinEdge = n; },
  min_contract_price: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.minContractPrice = n; },
  exit_cooldown_ticks: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.exitCooldownTicks = n; },
  max_exposure_per_ticker: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.maxExposurePerTicker = n; },
  min_balance_floor: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.minBalanceFloor = n; },
  seed_capital: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.seedCapital = n; },
  profit_reserve_pct: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.profitReservePct = n; },
  enabled_stations: (c, v) => { c.bot.enabledStations = v.split(",").map(s => s.trim()).filter(Boolean); },
  sniper_horizon_hours: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.sniperHorizonHours = n; },
  min_bet_size_cents: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.minBetSizeCents = n; },
  flat_bet_size_cents: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.flatBetSizeCents = n; },
  high_confidence_threshold: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.highConfidenceThreshold = n; },
  high_confidence_bet_size_cents: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.highConfidenceBetSizeCents = n; },
  historical_prior_weight: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.historicalPriorWeight = n; },
  market_prior_weight: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.marketPriorWeight = n; },
  tail_max_entry_price: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.tailMaxEntryPrice = n; },
};

/** Load config from environment variables with sensible defaults */
export function loadConfig(): BotConfig {
  const config: BotConfig = {
    kalshi: {
      apiKey: env("KALSHI_API_KEY"),
      apiSecret: envFile("KALSHI_API_SECRET_FILE"),
      baseUrl: env("KALSHI_BASE_URL", "https://api.elections.kalshi.com/trade-api/v2"),
    },
    weather: {
      openweatherApiKey: env("OPENWEATHER_API_KEY") || undefined,
      tomorrowIoApiKey: env("TOMORROW_IO_API_KEY") || undefined,
    },
    bot: {
      dryRun: envBool("DRY_RUN", true),
      tickIntervalSec: envNum("TICK_INTERVAL_SEC", 300),
      edgeThreshold: envNum("EDGE_THRESHOLD", 0.20),
      minConfidence: envNum("MIN_CONFIDENCE", 0.80),
      maxKellyFraction: envNum("MAX_KELLY_FRACTION", 0.05),
      maxOpenPositions: envNum("MAX_OPEN_POSITIONS", 6),
      maxContractsPerOrder: envNum("MAX_CONTRACTS_PER_ORDER", 15),
      enabledSeries: env("ENABLED_SERIES")
        ? env("ENABLED_SERIES").split(",")
        : [],
      enabledStations: env("ENABLED_STATIONS")
        ? env("ENABLED_STATIONS").split(",")
        : ["KNYC", "KORD", "KLAX", "KMIA", "KDEN", "KAUS"],
      exitEdgeThreshold: envNum("EXIT_EDGE_THRESHOLD", 0.03),
      stopLossPct: envNum("STOP_LOSS_PCT", 0.25),
      stopLossMinEdge: envNum("STOP_LOSS_MIN_EDGE", 0.05),
      exitTimeDaysBeforeClose: envNum("EXIT_TIME_DAYS_BEFORE_CLOSE", 0.25),
      exitTimeMinEdge: envNum("EXIT_TIME_MIN_EDGE", 0.08),
      minContractPrice: envNum("MIN_CONTRACT_PRICE", 15),
      exitCooldownTicks: envNum("EXIT_COOLDOWN_TICKS", 15),
      // Revisit after bankroll top-up: scale with seed capital.
      maxExposurePerTicker: envNum("MAX_EXPOSURE_PER_TICKER", 1000),
      minBalanceFloor: envNum("MIN_BALANCE_FLOOR", 5000), // $50 default
      // Revisit after bankroll top-up.
      seedCapital: envNum("SEED_CAPITAL", 17556), // $175.56 current balance
      profitReservePct: envNum("PROFIT_RESERVE_PCT", 0.5), // keep 50% of profits
      sniperHorizonHours: envNum("SNIPER_HORIZON_HOURS", 12), // enter positions within 12h of close
      minBetSizeCents: envNum("MIN_BET_SIZE_CENTS", 500), // $5 floor; skip sub-$5 sized bets
      flatBetSizeCents: envNum("FLAT_BET_SIZE_CENTS", 500), // $5 flat per signal; 0 = fall back to Kelly sizing
      // Confidence-tier sizing: scale up to $10 on conf >= 0.95 signals (per 2026-05-23 analysis,
      // 0.95+ bucket = 56% win / +$8.4k; 0.90-0.95 bucket = 32% win / -$5.6k, so do NOT scale that band)
      highConfidenceThreshold: envNum("HIGH_CONFIDENCE_THRESHOLD", 0.95),
      highConfidenceBetSizeCents: envNum("HIGH_CONFIDENCE_BET_SIZE_CENTS", 1000), // $10 on high-conf signals
      historicalPriorWeight: envNum("HISTORICAL_PRIOR_WEIGHT", 0.3), // blend toward observed historical hit rate
      marketPriorWeight: envNum("MARKET_PRIOR_WEIGHT", 0), // ship dark; activate via runtime_config row
      tailMaxEntryPrice: envNum("TAIL_MAX_ENTRY_PRICE", 0), // ship dark; runtime row sets 0.10
    },
    calibration: {
      biasWindowDays: envNum("BIAS_WINDOW_DAYS", 30),
      calibrationWindowDays: envNum("CALIBRATION_WINDOW_DAYS", 30),
      maxCalibrationError: envNum("MAX_CALIBRATION_ERROR", 0.05),
    },
    db: {
      path: env("DB_PATH", "./data/kalshi-bot.db"),
    },
    log: {
      level: (env("LOG_LEVEL", "info") as BotConfig["log"]["level"]),
    },
    ai: {
      anthropicApiKey: env("ANTHROPIC_API_KEY") || undefined,
    },
  };

  // Apply runtime_config overrides from DB (if DB exists)
  applyRuntimeOverrides(config);

  return config;
}

/** Load persisted overrides from the runtime_config table */
function applyRuntimeOverrides(config: BotConfig): void {
  try {
    const dbPath = resolve(config.db.path);
    if (!existsSync(dbPath)) return;

    using sqlite = new Database(dbPath, { readonly: true });
    const rows = sqlite
      .query("SELECT key, value FROM runtime_config")
      .all() as Array<{ key: string; value: string }>;

    for (const row of rows) {
      const applier = RUNTIME_CONFIG_MAP[row.key];
      if (applier) {
        applier(config, row.value);
      }
    }
  } catch {
    // DB doesn't exist or table doesn't exist yet — silently skip
  }
}

/** Singleton config instance */
let _config: BotConfig | null = null;

export function getConfig(): BotConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/** Override config values (useful for tests and the `config set` command) */
export function updateConfig(patch: Partial<BotConfig>): BotConfig {
  _config = { ...getConfig(), ...patch };
  return _config;
}
