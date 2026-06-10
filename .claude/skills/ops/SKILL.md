---
name: ops
description: Operate the kalshi-bot's autonomous layer via `bun ops` — check bot/automation status, see what follow-ups are due, view or change runtime config knobs WITH attribution, inspect the config audit trail, run/pause the daily sweep. Use when the user says "/ops", asks about bot status, due follow-ups, config knobs/changes ("who changed X", "set X to Y", "enable ultra-sniper"), the sweep/automation, or at session start to surface due items. Also use INSTEAD of raw sqlite3 whenever modifying runtime_config.
---

# ops — operate the bot's autonomous layer

One CLI for the operational surface: automation health, due follow-ups, runtime config + its audit trail. Built 2026-06-06; see `docs/follow-ups.md` §"Scheduled automation" and `scripts/ops.ts`.

```sh
bun ops status                       # automation + bot + regime health at a glance
bun ops due                          # follow-ups.md items due/overdue today
bun ops knobs                        # runtime_config with last-change attribution
bun ops history [n]                  # audit trail (default 20 rows)
bun ops set <key> <value> --why "…"  # audited config change
bun ops sweep                        # run the follow-ups sweep NOW (invokes claude -p; minutes)
bun ops pause | resume               # toggle .sweep-paused sentinel (honored by the sweep script)
```

## Rules

1. **Session start:** run `bun ops status` and `bun ops due`. Surface due/overdue items and any unattributed or surprising recent config changes to the user before new work.
2. **All runtime_config writes go through `bun ops set --why`** — never raw `sqlite3 ... UPDATE runtime_config` and never bare drizzle writes. Migration 0006's triggers audit every write regardless, but only `ops set` (and self-attributing services like the station-health gate) record WHO and WHY. An unattributed row in `bun ops history` is a smell — investigate it.
3. **`ops set` refuses `dry_run=false` by design.** Going live is a human decision made deliberately in the REPL — do not work around this, do not suggest workarounds.
4. **The regime boundary is law:** all win-rate/calibration measurement starts at `REGIME_BOUNDARY_ISO` (2026-06-05T20:00Z, exported from `@kcb/shared`). Any rolling-window analytic feeding a live decision must clamp its window start to it — the station-health gate once disabled ALL SIX stations by reading old-regime statistics (2026-06-06 incident, see `docs/follow-ups.md` Log). If you build a new window-based check, reuse the constant.
5. **Closing a due item:** run its exact Check from `docs/follow-ups.md`, act per its Decide column (config changes via `ops set --why` referencing the item, e.g. `--why "follow-up #3: 3 clean days"`), record the outcome in the file's Log section (newest first), and set the next due date if it recurs. Then `bun test` → commit → push (CLAUDE.md rules).
6. **Pause before invasive work:** if you're about to restructure the estimator/execution path or run a long migration, `bun ops pause` so the daily sweep doesn't act on a half-changed tree; `bun ops resume` after.

## Key context

- The bot runs paper-mode (`dry_run=true`) under `bun --watch`. As of 2026-06-10 it re-reads `runtime_config` at the top of every orchestrator tick (`refreshRuntimeConfig`), so an `ops set` applies within ~1–2 min with no restart. (Before that fix, `getConfig()` cached config once per process and silently ignored every runtime change until a restart — the 2026-06-09 sizing enable was inert for a day. `bun --watch` soft-reloads on real file *content* edits but NOT on a bare `touch`.)
- The daily sweep (8:53am local) executes the canonical prompt in `docs/follow-ups.md` with full autonomy inside hard guardrails (never `dry_run=false`, never delete data, never new market categories). Mechanisms: launchd (preferred, machine-level — install block in that doc) or in-session `CronCreate` fallback.
- Output of sweeps: `logs/follow-ups-sweep.log`. Win-rate scoreboard: the `wins` REPL command (or import `winsCommands` from `app/cli/src/commands/wins.ts` via `bun -e`).
- Knob reference: `packages/config/src/index.ts` (`RUNTIME_CONFIG_MAP` lists every runtime-settable key and its parser).
