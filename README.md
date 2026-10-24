# Kalshi Climate Bot

> **Archived (October 2026).** This project is no longer maintained. Paper-trading only; it never ran with a validated edge. Published as a reference implementation of a Kalshi trading engine with calibration tracking, audited runtime config, and headless ops tooling. Use at your own risk — nothing here is financial advice.

A terminal-based trading agent for Kalshi climate prediction markets. Think `claude-code` meets a trading terminal — a persistent, interactive session you talk to.

## Architecture

Single-process, no HTTP server. The Ink terminal UI and the bot engine share memory via a typed `EventEmitter`. SQLite is the integration point for persistence.

```
┌────────────────────────────────┐
│  CLI (Ink / React for terminal)│
│  ├── Dashboard view            │
│  ├── REPL (commands + explain) │
│  ├── Markets view              │
│  └── Logs view                 │
├────────────────────────────────┤
│  Engine (headless bot logic)   │   ← EventEmitter (typed)
│  ├── Orchestrator (tick loop)  │
│  ├── Discovery (Kalshi API)    │
│  ├── Estimation (NWS + GEFS)   │
│  └── Execution (Kelly + orders)│
├────────────────────────────────┤
│  SQLite (Drizzle ORM)          │
│  ├── markets, orders, trades   │
│  ├── signals, positions        │
│  ├── calibration, station_bias │
│  └── weather_forecasts         │
└────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
bun install

# Copy env and configure
cp .env.example .env
# Edit .env with your Kalshi API credentials

# Run DB migrations
bun run db:migrate

# Launch the bot
bun run bot
```

## Terminal Controls

| Key     | Action                 |
|---------|------------------------|
| `1`     | Dashboard view         |
| `2`     | REPL (interactive)     |
| `3`     | Markets view           |
| `4`     | Logs view              |
| `Tab`   | Cycle views            |
| `Esc`   | Return to dashboard    |
| `Ctrl+C`| Quit                   |

## REPL Commands

| Command                       | Description                        |
|-------------------------------|------------------------------------|
| `start` / `stop` / `restart` | Control the bot loop               |
| `status`                      | Current bot state                  |
| `markets`                     | List tracked markets               |
| `inspect <ticker>`            | Market details                     |
| `positions`                   | Open positions                     |
| `orders [status]`             | Recent orders                      |
| `pnl`                         | Realized PnL summary               |
| `calibration summary`         | Calibration report                 |
| `calibration detail [series]` | Per-market calibration             |
| `calibration bias [station]`  | Station bias corrections           |
| `calibration retrain`         | Force full recalibration           |
| `config list`                 | Show all tunable parameters        |
| `config set <key> <value>`    | Update a parameter                 |
| `help`                        | All available commands              |

## Self-Improvement

The bot improves automatically via:

1. **Station bias tracking** — learns systematic forecast errors per NWS station per forecast horizon
2. **Adaptive thresholds** — adjusts edge requirements per probability bucket based on recent calibration
3. **Calibration scoring** — tracks Brier score and bucket-level accuracy continuously
4. **Manual retrain** — `calibration retrain` forces full recalibration from history

## Automated Log Review

A macOS LaunchAgent runs Claude Code daily at 6:03am to review the last 24 hours of bot logs, identify issues, and auto-fix them.

**What it does:**
1. Reads `logs/bot.log` (and rotated files) for errors, warnings, and anomalous patterns
2. Traces issues back to source code and diagnoses root causes
3. Implements fixes with tests, runs `bun test`, and commits+pushes if everything passes
4. Does nothing if logs are clean — not every run produces a commit

**LaunchAgent location:** `~/Library/LaunchAgents/com.climatebot.log-review.plist`

**Review output:** `logs/log-review-stdout.log` and `logs/log-review-stderr.log`

**Commands:**
```bash
# Test it now
launchctl kickstart gui/$(id -u)/com.climatebot.log-review

# Check status
launchctl print gui/$(id -u)/com.climatebot.log-review

# Stop it
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.climatebot.log-review.plist

# Restart it
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.climatebot.log-review.plist
```

## Packages

| Package | Description |
|---------|-------------|
| `@kcb/cli` | Ink terminal UI |
| `@kcb/engine` | Bot loop, orchestrator, event bus |
| `@kcb/data` | Weather data ingestion (NWS, ensembles) |
| `@kcb/signals` | Probability estimation, signal generation |
| `@kcb/execution` | Kelly sizing, order placement |
| `@kcb/db` | SQLite + Drizzle schema/migrations |
| `@kcb/config` | Typed configuration |
| `@kcb/kalshi-client` | Kalshi REST API wrapper |

## Data Sources

**Free:**
- NWS API (api.weather.gov) — point forecasts, grid data, observations

**Paid (optional, recommended):**
- Open-Meteo — GFS/GEFS ensemble access
- Tomorrow.io — high-resolution forecasts
- OpenWeather — historical data for backtesting

## Development

```bash
# Type checking
bun run typecheck

# Browse DB
bun run db:studio

# Generate migrations after schema changes
bun run db:generate
```
