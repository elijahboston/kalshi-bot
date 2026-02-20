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

function env(key: string, fallback = ""): string {
  return process.env[key] || fallback;
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

/** Load config from environment variables with sensible defaults */
export function loadConfig(): BotConfig {
  return {
    kalshi: {
      apiKey: env("KALSHI_API_KEY"),
      apiSecret: env("KALSHI_API_SECRET"),
      baseUrl: env("KALSHI_BASE_URL", "https://api.elections.kalshi.com/trade-api/v2"),
    },
    weather: {
      openweatherApiKey: env("OPENWEATHER_API_KEY") || undefined,
      tomorrowIoApiKey: env("TOMORROW_IO_API_KEY") || undefined,
    },
    bot: {
      dryRun: envBool("DRY_RUN", true),
      tickIntervalSec: envNum("TICK_INTERVAL_SEC", 60),
      edgeThreshold: envNum("EDGE_THRESHOLD", 0.08),
      minConfidence: envNum("MIN_CONFIDENCE", 0.5),
      maxKellyFraction: envNum("MAX_KELLY_FRACTION", 0.05),
      maxOpenPositions: envNum("MAX_OPEN_POSITIONS", 10),
      maxContractsPerOrder: envNum("MAX_CONTRACTS_PER_ORDER", 25),
      enabledSeries: env("ENABLED_SERIES")
        ? env("ENABLED_SERIES").split(",")
        : [],
      enabledStations: env("ENABLED_STATIONS")
        ? env("ENABLED_STATIONS").split(",")
        : ["KNYC", "KORD", "KLAX", "KDFW", "KIAH"],
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
