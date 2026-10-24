# Headless Resilience — Power-Loss & Restart Survival

**Status:** TODO / not yet implemented
**Created:** 2026-07-06
**Context:** A power cut shut down the Mac mini running the bot. Recovery currently
requires physically attaching a keyboard + monitor to unlock FileVault and log in.
After that, the bot does **not** auto-restart and the scheduled LaunchAgents only
fire once someone logs in. Goal: fully headless operation that survives a cold
power loss with zero human touch.

## Current state (baseline, 2026-07-06)

- **Bot process:** runs as `bun --watch app/cli/src/index.tsx` in a plain terminal
  session (PID observed: 1844). **Not supervised** — nothing restarts it on crash or
  reboot. `--watch` is a dev flag that restarts the process on any file change.
- **Scheduled jobs:** three **LaunchAgents** (per-user, require a GUI login to fire):
  - `com.elijah.kalshi-bot.follow-ups` — 08:53
  - `com.elijah.kalshi-bot.db-snapshot` — 09:55
  - `com.elijah.kalshi-bot.daily-perf-review` — 10:00 (shells out to `claude`, needs `~/.claude`)
- **FileVault:** ON → forces pre-boot password entry + forbids auto-login. **Root blocker.**
- **Power:** `autorestart 0` (will not power back on after an outage).
- **Sleep:** disabled only via a live `caffeinate` process (dies on reboot; not persistent).
- **Secrets:** repo-local `.env` (Bun auto-loads). No Keychain dependency → LaunchAgents
  running as `elijah` work without a GUI unlock beyond login.

## Decision (made 2026-07-06)

**Disable FileVault** to enable auto-login and fully-headless boot. Accepted tradeoff:
disk is unencrypted at rest, so physical theft of the mini would expose the SQLite DB
and Kalshi API key in `.env`. Acceptable for a home-hosted trading bot.

**Architecture: auto-login + LaunchAgents** (not root LaunchDaemons), because the
perf-review job needs the user's `~/.claude` and secrets live in the repo `.env` —
everything should run as `elijah` in a logged-in session.

---

## TODO

### Layer 1 — Auto power-on after outage
- [ ] `sudo pmset -a autorestart 1` — power on after a power failure
- [ ] `sudo systemsetup -setrestartpowerfailure on`
- [ ] `sudo pmset -a sleep 0 disksleep 0` — persistent no-sleep (replaces the transient `caffeinate`)
- [ ] Verify with `pmset -g | grep -E 'autorestart|sleep'`

### Layer 2 — Boot into a logged-in session (headless)
- [ ] Turn **OFF** FileVault: System Settings → Privacy & Security → FileVault → Turn Off.
      Wait for background decryption to complete.
- [ ] Enable **Automatic Login**: System Settings → Users & Groups → Automatically log in as → `elijah`
      (option is greyed out until decryption finishes).
- [ ] Confirm: cold reboot → auto power-on → boots to logged-in desktop → LaunchAgents load unattended.

### Layer 3 — Supervise the bot itself  *(biggest gap)*
- [ ] Create LaunchAgent `com.elijah.kalshi-bot.engine.plist`:
  - `ProgramArguments`: `bun run app/cli/src/index.tsx` (**drop `--watch`**)
  - `WorkingDirectory`: `/path/to/kalshi-bot`
  - `RunAtLoad` = true, `KeepAlive` = true (restart on crash + at login)
  - `StandardOutPath`/`StandardErrorPath` → `logs/engine-launchd.log`
  - `ProcessType` = Background
- [ ] Stop the manual `bun --watch` terminal session once the agent is live.
- [ ] `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.elijah.kalshi-bot.engine.plist`
- [ ] Verify auto-restart: `kill` the bot PID, confirm launchd respawns it.

### Layer 4 — Remote access (retire the keyboard/monitor)
- [ ] `sudo systemsetup -setremotelogin on` — enable SSH
- [ ] Enable Screen Sharing (System Settings → General → Sharing → Screen Sharing)
- [ ] Buy + insert a **~$10 HDMI dummy plug** so the GPU presents a real display for
      Screen Sharing at full resolution (headless Macs otherwise fall back to 640×480).
- [ ] Test: reboot, then SSH + Screen Share in from another machine with peripherals detached.

### Layer 5 — Dead-man's switch / alerting  *(highest-value add)*
- [ ] Pick a monitor: **healthchecks.io** (free, zero-install) vs Pushover/ntfy.
- [ ] Add a heartbeat ping to the bot's main loop (each cycle).
- [ ] Add a heartbeat ping to `scripts/daily-perf-review.sh` (confirms the 10:00 job ran).
- [ ] Configure alert → phone push when a check-in is missed (e.g. no ping in N minutes).
- [ ] Test: kill the bot, confirm an alert arrives.

### Layer 6 — Convenience
- [ ] Write `scripts/headless-setup.sh` bundling the Layer 1/4 `sudo` commands (idempotent).
- [ ] After a UPS is installed, connect it via USB → macOS Energy Saver → UPS tab →
      configure graceful shutdown on low battery (rides out brief outages entirely).

---

## Verification checklist (post-implementation)

- [ ] Full cold test: pull power → restore → machine boots, unlocks, logs in, bot is
      running, all LaunchAgents scheduled — **without touching a keyboard or monitor**.
- [ ] Crash test: `kill <bot pid>` → launchd respawns within seconds.
- [ ] Alert test: stop the bot longer than the heartbeat window → phone alert fires.

## Notes / open questions

- FileVault-off means `.env` (Kalshi API key) sits on an unencrypted disk. If that risk
  grows, revisit: keep FileVault + UPS and use `sudo fdesetup authrestart` for planned
  reboots (does **not** help cold power loss).
- A UPS (Layer 6) is the real long-term fix — most outages never take the box down, so
  the headless-cold-boot path becomes a rare fallback rather than the daily reality.
