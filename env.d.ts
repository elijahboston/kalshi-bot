declare module "bun" {
  interface Env {
    // Kalshi API
    KALSHI_API_KEY?: string;
    KALSHI_API_SECRET_FILE?: string;
    KALSHI_BASE_URL?: string;

    // Weather data sources
    OPENWEATHER_API_KEY?: string;
    TOMORROW_IO_API_KEY?: string;

    // Bot parameters
    DRY_RUN?: string;
    TICK_INTERVAL_SEC?: string;
    EDGE_THRESHOLD?: string;
    MIN_CONFIDENCE?: string;
    MAX_KELLY_FRACTION?: string;
    MAX_OPEN_POSITIONS?: string;
    MAX_CONTRACTS_PER_ORDER?: string;
    ENABLED_SERIES?: string;
    ENABLED_STATIONS?: string;

    // Calibration
    BIAS_WINDOW_DAYS?: string;
    CALIBRATION_WINDOW_DAYS?: string;
    MAX_CALIBRATION_ERROR?: string;

    // Storage & logging
    DB_PATH?: string;
    LOG_LEVEL?: string;

    // AI
    ANTHROPIC_API_KEY?: string;
  }
}
