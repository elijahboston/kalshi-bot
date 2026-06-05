/**
 * One-time migration: re-derive bracket bounds for ALL temperature markets from
 * their titles (rounded-integer settlement semantics).
 *
 * Background (win-rate-80-addendum-2026-06-05.md, Finding 11): Kalshi's
 * "87-88°" bracket settles YES for any official high in [86.5, 88.5) — 2°F of
 * coverage with the ticker's B-number (87.5) as midpoint. The original parser
 * stored [B, B+1) = [87.5, 88.5), dropping half of every bracket; tails were
 * off by 0.5°F. This script rewrites markets.bracket_low / bracket_high /
 * market_type from the stored titles via the same parseBracketFromTitle used
 * by discovery going forward.
 *
 * AFTER running this, re-run `bun scripts/rebuild-ground-truth.ts` — the
 * settlement-derived actuals and station_bias were computed from the old
 * (wrong) intervals and must be re-derived from the corrected ones.
 *
 * Usage:
 *   bun scripts/fix-bracket-geometry.ts [--db ./data/kalshi-bot.db] [--dry-run]
 */
import { Database } from "bun:sqlite";
import { parseBracketFromTitle } from "../app/engine/services/discovery";

const args = Bun.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbFlag = args.indexOf("--db");
const dbPath = dbFlag >= 0 ? args[dbFlag + 1]! : "./data/kalshi-bot.db";

const db = new Database(dbPath);
console.log(`[fix-bracket-geometry] db=${dbPath}${dryRun ? "  (DRY RUN)" : ""}\n`);

interface Row {
  ticker: string;
  title: string;
  category: string;
  market_type: string;
  bracket_low: number | null;
  bracket_high: number | null;
}

const rows = db
  .query(
    `SELECT ticker, title, category, market_type, bracket_low, bracket_high
     FROM markets WHERE category IN ('high_temp', 'low_temp')`
  )
  .all() as Row[];

let changed = 0;
let unparseable = 0;
const samples: string[] = [];
const byKind = { bracket: 0, lower_tail: 0, upper_tail: 0 };

const update = db.prepare(
  `UPDATE markets SET bracket_low = ?, bracket_high = ?, market_type = ?, updated_at = ? WHERE ticker = ?`
);

for (const row of rows) {
  const parsed = parseBracketFromTitle(row.title, row.category);
  if (!parsed) {
    unparseable++;
    if (unparseable <= 5) console.log(`  ! unparseable title: ${row.ticker} — "${row.title}"`);
    continue;
  }

  const differs =
    parsed.bracketLow !== row.bracket_low ||
    parsed.bracketHigh !== row.bracket_high ||
    parsed.marketType !== row.market_type;
  if (!differs) continue;

  changed++;
  byKind[parsed.marketType]++;
  if (samples.length < 6) {
    samples.push(
      `  ${row.ticker}: [${row.bracket_low}, ${row.bracket_high}] ${row.market_type} → ` +
      `[${parsed.bracketLow}, ${parsed.bracketHigh}] ${parsed.marketType}   "${row.title.replace(/\*\*/g, "")}"`
    );
  }

  if (!dryRun) {
    update.run(
      parsed.bracketLow,
      parsed.bracketHigh,
      parsed.marketType,
      new Date().toISOString(),
      row.ticker
    );
  }
}

console.log(`Scanned ${rows.length} temperature market(s).`);
console.log(
  `${dryRun ? "Would update" : "Updated"} ${changed} row(s) ` +
  `(${byKind.bracket} brackets, ${byKind.lower_tail} lower tails, ${byKind.upper_tail} upper tails); ` +
  `${unparseable} unparseable (left untouched).`
);
if (samples.length > 0) {
  console.log(`\nSamples:`);
  for (const s of samples) console.log(s);
}

// Sanity check: settled YES brackets should now contain... well, we can't know
// the official value, but each event's YES market should be unique and the
// corrected brackets of one event should tile without overlap.
const overlaps = db
  .query(
    `SELECT a.event_ticker, a.ticker, b.ticker
     FROM markets a JOIN markets b
       ON a.event_ticker = b.event_ticker AND a.ticker < b.ticker
      AND a.market_type = 'bracket' AND b.market_type = 'bracket'
      AND a.bracket_low < b.bracket_high AND b.bracket_low < a.bracket_high
     WHERE a.category IN ('high_temp','low_temp')
     LIMIT 5`
  )
  .all() as Array<Record<string, string>>;
if (overlaps.length > 0) {
  console.log(`\n⚠ ${overlaps.length}+ overlapping bracket pair(s) detected after migration:`);
  for (const o of overlaps) console.log(`  ${JSON.stringify(o)}`);
} else {
  console.log(`\n✓ No overlapping brackets within any event.`);
}

console.log(
  dryRun
    ? "\nDry run — nothing written."
    : "\nDone. NOW RUN: bun scripts/rebuild-ground-truth.ts --db " + dbPath
);
