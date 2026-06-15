# REPL Commands

**Type:** Reference
**Last updated:** 2026-06-10

Commands are defined in `app/cli/src/commands/`. Each file exports an array of `CommandDef` objects. The registry in `commands/index.ts` flattens them into a lookup map by name and aliases.

```typescript
interface CommandDef {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  handler: (args: string[]) => Promise<CommandResult>;
}

// CommandResult = string | React.ReactElement
// The REPL view renders JSX directly (enables ink-table components in command output)
```

To add a new command: create the `CommandDef[]` array, import it in `commands/index.ts`, add it to `commandGroups`.

## Commands

| Command | Aliases | Args | Description |
|---------|---------|------|-------------|
| `start` | — | — | Start bot loop |
| `stop` | — | — | Stop bot loop |
| `status` | — | — | Show bot state, uptime, tick count |
| `restart` | — | — | Stop + start |
| `markets` | `ls`, `list` | `[status]` | List tracked markets, optional status filter |
| `inspect` | — | `<ticker>` | Full market details from DB |
| `positions` | `pos` | — | Open positions with P&L |
| `pnl` | — | — | Realized P&L summary |
| `orders` | — | `[status]` | Recent orders, optional status filter |
| `config` | `cfg` | `list\|get <key>\|set <key> <val>` | View/modify runtime config |
| `calibration` | `cal` | `summary\|detail [series]\|bias [station]\|retrain` | Calibration reports |
| `explain` | — | `<ticker>` | Show signal reasoning for a market |
| `backtest` | — | `<series> --days <N>` | Run estimator against historical data |
| `wins` | `w` | `[summary\|by_gate\|by_path\|by_confidence\|by_station\|by_hour] [all]` | Win-rate attribution (plan #10). Defaults to the new regime (since 2026-06-05T20:00Z); `all` = full history. `by_gate` shows would-have-won rates for BLOCKED signals (<50% ⇒ the gate is saving money), deduped to the last signal per (ticker, gate family). PnL columns are entry-attributed / settle-assumed (early exits ignored — round-trips live in `calibration`). |
| `help` | — | — | List all commands |
| `exit` / `quit` | — | — | Return to dashboard |

## Notes

- The `explain` command surfaces the `reasoning` JSON trace: SIGMA section (source + value vs ensemble), OBSERVATION ADJUSTMENT (when same-day obs are used), DATA SOURCES (ensemble breakdown, HRRR weight, Tomorrow.io), forecast horizon in hours with sniper/scout label.
- `backtest` re-runs `ProbabilityEstimator` against archived `weather_forecasts` where `actualValue` is non-null, then simulates trades using historical market prices and Kelly sizing. Reports win rate, simulated P&L, and Brier score.
- `calibration retrain` recomputes all `station_bias` and `adaptive_thresholds` entries from full history.
- Tables in REPL output use the custom `Table` component (`components/table.tsx`) because `ink-table` CJS is incompatible with Bun ESM.
