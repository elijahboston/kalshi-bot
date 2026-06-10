import { getDb, signals, markets, orders, eq, and, sql } from "@kcb/db";
import { takerFeeCents } from "@kcb/shared";
import type { CommandDef, CommandResult } from "./index";

/**
 * `wins` — gate-level outcome attribution (win-rate-80 plan #10).
 *
 * The 2026-06-05/06 strategy redirection (entry gates, confirmation mode,
 * event-coherent estimation, obs anchor, geometry fix) must be iterated on
 * with data, not anecdotes. This command answers, from settled markets only:
 *   - summary        overall + per-pathway win rate vs the 80% target
 *   - by_gate        for SKIPPED signals: would the blocked side have won?
 *                    (<50% = the gate is saving money, >50% = costing money)
 *   - by_path        acted trades by recommendation (buy_* vs confirm_*)
 *   - by_confidence  acted trades by confidence bucket (plan #6 follow-up —
 *                    satisfied as an on-demand view, not a persisted table)
 *   - by_station     acted trades per station (with disabled marker)
 *   - by_hour        acted trades by UTC entry hour (N12 prep)
 *
 * All reports default to the NEW REGIME (signals after 2026-06-05T20:00Z, the
 * first post-redirection trade); append `all` for full history. PnL columns
 * are "entry-attributed, settle-assumed": each filled buy is scored as if held
 * to settlement (early exits deliberately ignored — round-trip accounting
 * lives in the calibration view).
 */
const REGIME_BOUNDARY = "2026-06-05T20:00";

/**
 * skip_reason → gate family. Matching is by prefix on the first 12 chars (the
 * SQL pre-aggregation groups on `substr(skip_reason, 1, 12)` so the 500k-row
 * signals table collapses server-side before JS sees it).
 */
const GATE_FAMILIES: Array<[prefix: string, family: string]> = [
  ["contra-market", "contra-market"],
  ["disagreement", "disagreement"],
  ["coin-flip", "coin-flip"],
  ["station health", "station health"],
  ["event argmax", "event argmax"],
  ["hrrr unavail", "hrrr unavailable"],
  ["obs stale", "obs stale/missing"],
  ["no same-day", "obs stale/missing"],
  ["spread", "spread"],
  ["confirmation", "confirmation entry cap"],
  ["tail entry", "tail entry"],
  ["edge ", "edge < threshold"],
  ["confidence ", "confidence < min"],
  ["scout mode", "scout mode"],
  ["no edge", "no edge"],
  ["cooldown", "cooldown"],
  ["already hold", "already hold"],
  ["recent-loss", "recent-loss"],
  ["max position", "max positions"],
];

export function gateFamily(reasonKey: string | null): string {
  if (!reasonKey) return "other";
  for (const [prefix, family] of GATE_FAMILIES) {
    const p = prefix.slice(0, 12);
    if (reasonKey.startsWith(p)) return family;
  }
  return "other";
}

function windowCutoff(all: boolean): string {
  return all ? "0000" : REGIME_BOUNDARY;
}

function pct(wins: number, total: number): string {
  return total > 0 ? `${((100 * wins) / total).toFixed(1)}%` : "—";
}

function money(cents: number): string {
  const dollars = cents / 100;
  return `${dollars >= 0 ? "+" : "−"}$${Math.abs(dollars).toFixed(2)}`;
}

function pad(s: string | number, w: number): string {
  return String(s).padEnd(w);
}

interface ActedRow {
  ticker: string;
  side: string;
  price: number;
  qty: number;
  result: string;
  recommendation: string | null;
  confidence: number | null;
  stationId: string | null;
  createdAt: string;
}

/** Filled buy orders joined to their signal + settled market, inside the window. */
async function actedRows(all: boolean): Promise<ActedRow[]> {
  const db = getDb();
  const cutoff = windowCutoff(all);
  const rows = await db
    .select({
      ticker: orders.ticker,
      side: orders.side,
      price: orders.limitPrice,
      qty: orders.filledQuantity,
      result: markets.result,
      recommendation: signals.recommendation,
      confidence: signals.confidence,
      stationId: markets.stationId,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(markets, eq(orders.ticker, markets.ticker))
    .leftJoin(signals, eq(orders.signalId, signals.id))
    .where(
      and(
        eq(orders.action, "buy"),
        eq(orders.status, "filled"),
        sql`${markets.result} IN ('yes','no')`,
        sql`${orders.createdAt} >= ${cutoff}`
      )
    );
  return rows as ActedRow[];
}

/** Settle-assumed PnL net of the entry taker fee (paid win or lose). At
 * confirmation prices the fee is ~6% of the average gross win — the 80%-verdict
 * review must be judged on fee-true numbers. */
export function pnlCents(r: ActedRow): number {
  const fee = takerFeeCents(r.price, r.qty);
  return (r.result === r.side ? r.qty * (100 - r.price) : -r.qty * r.price) - fee;
}

interface Bucket {
  label: string;
  n: number;
  wins: number;
  pnl: number;
  priceSum: number;
}

function bucketize(rows: ActedRow[], key: (r: ActedRow) => string): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const r of rows) {
    const label = key(r);
    const b = map.get(label) ?? { label, n: 0, wins: 0, pnl: 0, priceSum: 0 };
    b.n++;
    if (r.result === r.side) b.wins++;
    b.pnl += pnlCents(r);
    b.priceSum += r.price;
    map.set(label, b);
  }
  return [...map.values()].sort((a, b) => b.n - a.n);
}

function bucketTable(title: string, buckets: Bucket[], opts?: { avgPrice?: boolean }): string {
  const lines = [title, ""];
  lines.push(
    pad("bucket", 24) + pad("trades", 8) + pad("wins", 6) + pad("win%", 8) +
    (opts?.avgPrice ? pad("avg¢", 7) : "") + "pnl (settle-assumed)"
  );
  for (const b of buckets) {
    lines.push(
      pad(b.label, 24) + pad(b.n, 8) + pad(b.wins, 6) + pad(pct(b.wins, b.n), 8) +
      (opts?.avgPrice ? pad((b.priceSum / b.n).toFixed(0), 7) : "") + money(b.pnl)
    );
  }
  return lines.join("\n");
}

const emptyMsg = (all: boolean) =>
  all
    ? "No settled acted trades found."
    : `No settled trades since ${REGIME_BOUNDARY} (new regime) — use \`wins summary all\` for full history.`;

async function winsSummary(all: boolean): Promise<string> {
  const rows = await actedRows(all);
  if (rows.length === 0) return emptyMsg(all);

  const total = rows.length;
  const wins = rows.filter((r) => r.result === r.side).length;
  const pnl = rows.reduce((s, r) => s + pnlCents(r), 0);

  const byPath = bucketize(rows, (r) =>
    r.recommendation?.startsWith("confirm") ? "confirmation" : "contrarian"
  );

  const header = all ? "All history" : `New regime (since ${REGIME_BOUNDARY}Z)`;
  const lines = [
    `Win-rate attribution — ${header} · entry-attributed, settle-assumed PnL`,
    "",
    `  win rate ${pct(wins, total)} vs 80% target (n=${total})   pnl ${money(pnl)}`,
    "",
    bucketTable("By pathway:", byPath, { avgPrice: true }),
  ];
  return lines.join("\n");
}

async function winsByGate(all: boolean): Promise<string> {
  const db = getDb();
  const cutoff = windowCutoff(all);

  // Server-side pre-aggregation: one row per (ticker, 12-char reason key, side),
  // carrying the latest signal timestamp. Keeps the 500k-row signals table out
  // of JS; the JS pass below maps keys → families and dedupes to ONE signal per
  // (ticker, family) — the LAST by created_at — to kill tick-resampling bias.
  const rows = (await db.all(sql`
    SELECT m.ticker AS ticker,
           substr(s.skip_reason, 1, 12) AS rk,
           s.side AS side,
           m.result AS result,
           MAX(s.created_at) AS last_at
    FROM signals s
    JOIN markets m ON m.ticker = s.ticker
    WHERE s.acted = 0
      AND s.side IS NOT NULL
      AND s.skip_reason IS NOT NULL
      AND m.result IN ('yes','no')
      AND s.created_at >= ${cutoff}
    GROUP BY m.ticker, rk, s.side
  `)) as Array<{ ticker: string; rk: string; side: string; result: string; last_at: string }>;

  if (rows.length === 0) return emptyMsg(all);

  // Dedupe to last signal per (ticker, family).
  const latest = new Map<string, { side: string; result: string; lastAt: string; family: string }>();
  for (const r of rows) {
    const family = gateFamily(r.rk);
    const k = `${r.ticker}|${family}`;
    const cur = latest.get(k);
    if (!cur || r.last_at > cur.lastAt) {
      latest.set(k, { side: r.side, result: r.result, lastAt: r.last_at, family });
    }
  }

  const fam = new Map<string, { n: number; wouldWin: number }>();
  for (const v of latest.values()) {
    const f = fam.get(v.family) ?? { n: 0, wouldWin: 0 };
    f.n++;
    if (v.result === v.side) f.wouldWin++;
    fam.set(v.family, f);
  }

  const header = all ? "all history" : `since ${REGIME_BOUNDARY}Z`;
  const lines = [
    `Blocked-signal attribution by gate (${header})`,
    "Deduped to the LAST signal per (ticker, gate family). would-win < 50% ⇒ the gate is saving money.",
    "",
    pad("gate family", 24) + pad("blocked", 9) + pad("would-win%", 12) + "verdict",
  ];
  const sorted = [...fam.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [family, f] of sorted) {
    const rate = f.n > 0 ? (100 * f.wouldWin) / f.n : 0;
    const verdict = f.n < 5 ? "(n too small)" : rate < 50 ? "SAVING" : "⚠ COSTING";
    lines.push(pad(family, 24) + pad(f.n, 9) + pad(pct(f.wouldWin, f.n), 12) + verdict);
  }
  return lines.join("\n");
}

async function winsByPath(all: boolean): Promise<string> {
  const rows = await actedRows(all);
  if (rows.length === 0) return emptyMsg(all);
  return bucketTable(
    `Acted trades by pathway (${all ? "all history" : `since ${REGIME_BOUNDARY}Z`}):`,
    bucketize(rows, (r) => r.recommendation ?? "unknown"),
    { avgPrice: true }
  );
}

async function winsByConfidence(all: boolean): Promise<string> {
  const rows = await actedRows(all);
  if (rows.length === 0) return emptyMsg(all);
  const bucket = (c: number | null) => {
    if (c == null) return "unknown";
    if (c < 0.8) return "<0.80";
    if (c < 0.85) return "0.80-0.85";
    if (c < 0.9) return "0.85-0.90";
    if (c < 0.95) return "0.90-0.95";
    return "≥0.95";
  };
  return bucketTable(
    `Acted trades by confidence (${all ? "all history" : `since ${REGIME_BOUNDARY}Z`}):`,
    bucketize(rows, (r) => bucket(r.confidence))
  );
}

async function winsByStation(all: boolean): Promise<string> {
  const rows = await actedRows(all);
  if (rows.length === 0) return emptyMsg(all);

  const db = getDb();
  const disabledRow = (await db.all(
    sql`SELECT value FROM runtime_config WHERE key = 'disabled_stations'`
  )) as Array<{ value: string }>;
  const disabled = new Set(
    (disabledRow[0]?.value ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  );

  const buckets = bucketize(rows, (r) => r.stationId ?? "unknown");
  for (const b of buckets) {
    if (disabled.has(b.label)) b.label = `${b.label} [disabled]`;
  }
  return bucketTable(
    `Acted trades by station (${all ? "all history" : `since ${REGIME_BOUNDARY}Z`}):`,
    buckets
  );
}

async function winsByHour(all: boolean): Promise<string> {
  const rows = await actedRows(all);
  if (rows.length === 0) return emptyMsg(all);
  return bucketTable(
    `Acted trades by UTC entry hour (${all ? "all history" : `since ${REGIME_BOUNDARY}Z`}):`,
    bucketize(rows, (r) => `${r.createdAt.slice(11, 13)}Z`)
  );
}

const USAGE =
  "Usage: wins [summary | by_gate | by_path | by_confidence | by_station | by_hour] [all]\n" +
  `Defaults to the new regime (since ${REGIME_BOUNDARY}Z); append \`all\` for full history.`;

export const winsCommands: CommandDef[] = [
  {
    name: "wins",
    aliases: ["w"],
    description: "Win-rate attribution by gate / pathway / confidence / station / hour",
    usage: "wins [summary | by_gate | by_path | by_confidence | by_station | by_hour] [all]",
    handler: async (args): Promise<CommandResult> => {
      const all = args.includes("all");
      const sub = (args.find((a) => a !== "all") ?? "summary").toLowerCase();

      switch (sub) {
        case "summary":
          return winsSummary(all);
        case "by_gate":
          return winsByGate(all);
        case "by_path":
          return winsByPath(all);
        case "by_confidence":
          return winsByConfidence(all);
        case "by_station":
          return winsByStation(all);
        case "by_hour":
          return winsByHour(all);
        default:
          return USAGE;
      }
    },
  },
];
