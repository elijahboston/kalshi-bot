import {
  getDb,
  orders,
  signals,
  markets,
  runtimeConfig,
  eq,
  and,
  gte,
  inArray,
  sql,
} from "@kcb/db";
// `notLike` / `isNotNull` are not among @kcb/db's re-exported drizzle operators;
// pull them straight from drizzle-orm (the established pattern across app/*).
import { notLike, isNotNull } from "drizzle-orm";
import { getConfig } from "@kcb/config";
import { createLogger } from "@kcb/engine";
import { now, REGIME_BOUNDARY_ISO } from "@kcb/shared";

const log = createLogger("station-health");

/** A single settled, model-driven trade outcome for one station. */
export interface StationTradeOutcome {
  stationId: string;
  /** True when the trade resolved in the bot's favor (market.result === order.side). */
  win: boolean;
  /** Settled-at ISO timestamp — used only to order outcomes within a station. */
  settledAt: string;
}

export interface StationHealthDecision {
  stationId: string;
  action: "disable" | "reenable" | "hold";
  /** Rolling-window rate for disable checks, trailing-N rate for re-enable checks, or null when no outcomes exist. */
  winRate: number | null;
  /** Number of outcomes the rate was computed over (window count, or trailing-N count). */
  trades: number;
  /** Human-readable reason, logged and persisted. */
  reason: string;
}

/**
 * Minimum trailing-set size for a re-enable check to be considered at all.
 * A disabled station places NO new trades, so its outcome stream largely
 * freezes — we never want to flip a station back on off one or two stale wins.
 */
const REENABLE_MIN_FLOOR = 5;

/**
 * Pure decision logic for the per-station auto health gate (addendum N9).
 *
 * Hysteresis with two bands keeps a station from flip-flopping at the boundary:
 *   - An ENABLED station disables only when its rolling-window win rate drops
 *     BELOW `disableBelow` with at least `minTrades` settled outcomes.
 *   - A DISABLED station re-enables only when the trailing `reenableTrades`
 *     most-recent outcomes win at/above `reenableAbove`.
 * Because `disableBelow < reenableAbove` (asserted/clamped below), a win rate in
 * the dead band between the two thresholds leaves a station in whatever state it
 * is already in — enabled stays enabled, disabled stays disabled.
 *
 * IMPORTANT CAVEAT — re-enable is largely data-starved by construction. A
 * disabled station is blocked from placing new entries (see
 * `evaluateEntryGates`'s station-health gate), so its settled-outcome stream
 * stops growing the moment it is disabled. The trailing-N re-enable check
 * therefore operates on whatever outcomes already exist; once those age out of
 * the window the station has ZERO outcomes and simply holds (disabled) forever
 * here. Re-enabling such a station in practice requires a manual nudge (clear it
 * from the `disabled_stations` runtime_config row) or a future paper-shadow
 * trade source that keeps evaluating disabled stations. What this gate DOES
 * guarantee is: when fresh outcomes do accrue (e.g. the station was disabled by
 * an operator, not the gate, and still has recent settled trades; or a shadow
 * stream is added later), the hysteresis band prevents thrash. We disable on
 * evidence; we only ever re-enable on evidence; we never auto-re-enable on
 * silence.
 *
 * @param args.outcomes Settled trades, ANY order (sorted internally by
 *   `settledAt`), already filtered to the rolling window upstream.
 * @param args.currentlyDisabled Stations currently in `disabled_stations`.
 * @param args.config Threshold knobs (see `getConfig().bot.stationHealth*`).
 * @returns One decision per station that has outcomes OR is currently disabled.
 *   Manual-only disabled stations with no outcomes return action "hold" (they
 *   are preserved untouched).
 */
export function evaluateStationHealth(args: {
  outcomes: StationTradeOutcome[];
  currentlyDisabled: Set<string>;
  config: {
    disableBelow: number;
    reenableAbove: number;
    minTrades: number;
    reenableTrades: number;
  };
}): StationHealthDecision[] {
  const { outcomes, currentlyDisabled } = args;
  const { disableBelow, minTrades, reenableTrades } = args.config;

  // Hysteresis invariant: reenableAbove must sit strictly above disableBelow,
  // otherwise the two bands overlap and a station can disable+re-enable on the
  // same rate. Clamp defensively if misconfigured.
  const reenableAbove =
    args.config.reenableAbove > disableBelow
      ? args.config.reenableAbove
      : disableBelow + 0.1;

  // Bucket outcomes by station, preserving sortability.
  const byStation = new Map<string, StationTradeOutcome[]>();
  for (const o of outcomes) {
    const list = byStation.get(o.stationId) ?? [];
    list.push(o);
    byStation.set(o.stationId, list);
  }

  // Every station we must emit a decision for: those with outcomes plus every
  // currently-disabled station (so a frozen disabled station gets an explicit
  // "hold" rather than silently dropping out).
  const stationIds = new Set<string>([
    ...byStation.keys(),
    ...currentlyDisabled,
  ]);

  const decisions: StationHealthDecision[] = [];

  for (const stationId of stationIds) {
    const stationOutcomes = (byStation.get(stationId) ?? [])
      .slice()
      .sort((a, b) => a.settledAt.localeCompare(b.settledAt));
    const isDisabled = currentlyDisabled.has(stationId);

    // Stations with zero outcomes: nothing to act on — hold.
    if (stationOutcomes.length === 0) {
      decisions.push({
        stationId,
        action: "hold",
        winRate: null,
        trades: 0,
        reason: isDisabled
          ? "no settled outcomes in window — disabled station held (re-enable needs fresh data)"
          : "no settled outcomes in window",
      });
      continue;
    }

    if (isDisabled) {
      // Re-enable check: trailing-N most-recent outcomes.
      const trailing = stationOutcomes.slice(-reenableTrades);
      const wins = trailing.filter((o) => o.win).length;
      const winRate = wins / trailing.length;
      const minNeeded = Math.min(reenableTrades, REENABLE_MIN_FLOOR);

      if (winRate >= reenableAbove && trailing.length >= minNeeded) {
        decisions.push({
          stationId,
          action: "reenable",
          winRate,
          trades: trailing.length,
          reason: `win rate ${pct(winRate)} over trailing ${trailing.length} settled trades ≥ ${pct(
            reenableAbove
          )} re-enable bar`,
        });
      } else {
        decisions.push({
          stationId,
          action: "hold",
          winRate,
          trades: trailing.length,
          reason:
            trailing.length < minNeeded
              ? `held disabled — only ${trailing.length} trailing settled trades (need ${minNeeded} to re-enable)`
              : `held disabled — win rate ${pct(winRate)} over trailing ${trailing.length} < ${pct(
                  reenableAbove
                )} re-enable bar`,
        });
      }
      continue;
    }

    // Enabled station — disable check over the full window.
    const wins = stationOutcomes.filter((o) => o.win).length;
    const winRate = wins / stationOutcomes.length;

    if (winRate < disableBelow && stationOutcomes.length >= minTrades) {
      decisions.push({
        stationId,
        action: "disable",
        winRate,
        trades: stationOutcomes.length,
        reason: `win rate ${pct(winRate)} over ${stationOutcomes.length} settled trades < ${pct(
          disableBelow
        )} floor`,
      });
    } else {
      decisions.push({
        stationId,
        action: "hold",
        winRate,
        trades: stationOutcomes.length,
        reason:
          stationOutcomes.length < minTrades
            ? `held — only ${stationOutcomes.length} settled trades (need ${minTrades} to disable)`
            : `held — win rate ${pct(winRate)} over ${stationOutcomes.length} ≥ ${pct(
                disableBelow
              )} floor`,
      });
    }
  }

  return decisions;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * Read the current `disabled_stations` CSV directly from `runtime_config`.
 * Raw query rather than the config singleton: the singleton is loaded once at
 * process start and the reconciliation cycle may have written a newer value
 * (or another operator may have via the CLI/API) since.
 */
function readDisabledStations(): Set<string> {
  const db = getDb();
  const row = db
    .select({ value: runtimeConfig.value })
    .from(runtimeConfig)
    .where(eq(runtimeConfig.key, "disabled_stations"))
    .all()[0];
  if (!row || !row.value) return new Set();
  return new Set(
    row.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * DB-aware wrapper for the per-station auto health gate (addendum N9). Intended
 * to be called once per hour from the reconciliation cycle.
 *
 * Pipeline:
 *   1. Read settled, model-driven trade outcomes inside the rolling window.
 *      Source = filled buy orders joined to their generating signal and the
 *      now-settled market. Win = `market.result === order.side`.
 *      - Confirmation entries (`recommendation LIKE 'confirm_%'`) are EXCLUDED:
 *        the gate measures the CONTRARIAN model's quality, and confirmation
 *        trades' high win rate would mask a sick station.
 *   2. Read the current `disabled_stations` set from `runtime_config` (raw).
 *   3. Run `evaluateStationHealth`.
 *   4. If any decision is not "hold", apply it to the CSV (ADD disables, REMOVE
 *      re-enables; everything else — including unknown manually-disabled
 *      stations with no recent data — is preserved), upsert the new CSV back to
 *      `runtime_config.disabled_stations`, and log each acted decision at info
 *      under the stable `station health:` prefix.
 *
 * Manual overrides are respected: this function only ADDS stations it decides
 * to disable and only REMOVES stations whose recent settled data justifies a
 * re-enable. A station an operator put in the CSV by hand with no qualifying
 * outcomes stays put.
 *
 * No-op (returns []) when `stationHealthEnabled` is false.
 *
 * Settled-at proxy: `markets.updatedAt`. `markets` has no dedicated `settled_at`
 * column; `close_time` is nullable, whereas `updated_at` is written on every
 * record update (including the settlement write that sets `result`), so it is
 * the always-present best available proxy for when the market resolved. It is
 * used only to (a) bound the rolling window and (b) order each station's
 * outcomes for the trailing-N re-enable check — neither use needs second-level
 * settlement precision.
 *
 * @returns The decisions that were ACTED on (action ≠ "hold"); [] when nothing
 *   changed or the gate is disabled.
 */
export async function updateStationHealthGate(): Promise<StationHealthDecision[]> {
  const config = getConfig();
  if (!config.bot.stationHealthEnabled) return [];

  const db = getDb();
  const windowDays = config.bot.stationHealthWindowDays;
  // Clamp the rolling window to the regime boundary: on 2026-06-06 the
  // unclamped 30-day window reached across the 2026-06-05 redirection into
  // the old bot's 33%-win-rate era and disabled ALL SIX stations (including
  // the profitable ones) on its first hourly run. Old-regime outcomes measure
  // a bot that no longer exists; the gate must only ever judge the current one.
  const rawCutoff = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const cutoff = rawCutoff > REGIME_BOUNDARY_ISO ? rawCutoff : REGIME_BOUNDARY_ISO;
  // The regime clamp must bind on the ORDER's entry time, not the market's
  // updated_at: updated_at is rewritten by any touch of the market row (the
  // 2026-06-05 bracket-geometry migration bumped 1,584 old markets past the
  // boundary, and seven minutes after the manual restore the gate re-disabled
  // all six stations from those same old-regime trades — 2026-06-06 incident,
  // round two). orders.created_at is immutable and is what "trades made by the
  // current bot" actually means.

  // Settled, model-driven trade outcomes within the window.
  const rows = await db
    .select({
      stationId: markets.stationId,
      side: orders.side,
      result: markets.result,
      settledAt: markets.updatedAt,
    })
    .from(orders)
    .innerJoin(signals, eq(orders.signalId, signals.id))
    .innerJoin(markets, eq(orders.ticker, markets.ticker))
    .where(
      and(
        eq(orders.action, "buy"),
        eq(orders.status, "filled"),
        // Exclude confirmation entries — they measure the market's quality, not
        // the contrarian model's; their high win rate would mask a sick station.
        notLike(signals.recommendation, "confirm_%"),
        inArray(markets.result, ["yes", "no"]),
        isNotNull(markets.stationId),
        gte(markets.updatedAt, cutoff),
        gte(orders.createdAt, REGIME_BOUNDARY_ISO)
      )
    );

  const outcomes: StationTradeOutcome[] = rows
    .filter((r): r is typeof r & { stationId: string } => r.stationId != null)
    .map((r) => ({
      stationId: r.stationId,
      win: r.result === r.side,
      settledAt: r.settledAt,
    }));

  const currentlyDisabled = readDisabledStations();

  const decisions = evaluateStationHealth({
    outcomes,
    currentlyDisabled,
    config: {
      disableBelow: config.bot.stationHealthDisableBelow,
      reenableAbove: config.bot.stationHealthReenableAbove,
      minTrades: config.bot.stationHealthMinTrades,
      reenableTrades: config.bot.stationHealthReenableTrades,
    },
  });

  const acted = decisions.filter((d) => d.action !== "hold");
  if (acted.length === 0) return [];

  // Apply: start from the current set (preserving manual entries), then add
  // disables and remove re-enables. Only stations the gate explicitly decided
  // on are touched.
  const next = new Set(currentlyDisabled);
  for (const d of acted) {
    if (d.action === "disable") next.add(d.stationId);
    else if (d.action === "reenable") next.delete(d.stationId);
  }

  const csv = [...next].sort().join(",");
  const timestamp = now();
  await db
    .insert(runtimeConfig)
    .values({ key: "disabled_stations", value: csv, updatedAt: timestamp })
    .onConflictDoUpdate({
      target: runtimeConfig.key,
      set: { value: csv, updatedAt: timestamp },
    });

  // Attribute the audit row the 0006 trigger just wrote (actor stays NULL
  // from triggers; `bun ops history` shows who did what and why).
  await db.run(sql`
    UPDATE runtime_config_log
    SET actor = 'station-health-gate',
        note = ${acted.map((d) => `${d.stationId} ${d.action}: ${d.reason}`).join("; ")}
    WHERE id = (SELECT MAX(id) FROM runtime_config_log WHERE key = 'disabled_stations')
      AND actor IS NULL
  `);

  for (const d of acted) {
    log.info(`station health: ${d.action} ${d.stationId} — ${d.reason}`);
  }
  log.info(`station health: disabled_stations now "${csv}"`);

  return acted;
}
