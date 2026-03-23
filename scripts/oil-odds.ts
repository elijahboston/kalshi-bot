/**
 * Check payout multiples for WTI oil yearly high markets on Kalshi.
 *
 * Usage: bun scripts/oil-odds.ts
 */
import { KalshiClient } from "@kcb/kalshi-client";

const client = new KalshiClient();

const markets = await client.getAllMarkets({ series_ticker: "KXWTIMAX" });

// Filter to active/open markets, sort by ticker
const active = markets
  .filter((m) => m.status !== "finalized")
  .sort((a, b) => a.ticker.localeCompare(b.ticker));

console.log(`\nWTI Oil Yearly High — ${active.length} active markets\n`);
console.log("Ticker".padEnd(30), "Title".padEnd(50), "Yes¢", "  No¢", "  Multiple");
console.log("-".repeat(120));

for (const m of active) {
  const yesAsk = m.yes_ask ?? m.last_price ?? null;
  const multiple = yesAsk && yesAsk > 0 ? (100 / yesAsk).toFixed(1) + "x" : "n/a";
  console.log(
    m.ticker.padEnd(30),
    (m.title ?? "").slice(0, 48).padEnd(50),
    String(yesAsk ?? "—").padStart(4),
    String(m.no_ask ?? "—").padStart(5),
    String(multiple).padStart(7)
  );
}

// Specifically look for $180+ bracket
console.log("\n--- $180+ Scenario ---\n");

const high = active.filter(
  (m) => m.title?.includes("180") || m.title?.includes("190") || m.title?.includes("200") || m.ticker.includes("T180") || m.ticker.includes("B180")
);

if (high.length === 0) {
  // Try broader search — look for the highest brackets
  const sorted = [...active].sort((a, b) => (b.yes_ask ?? 0) - (a.yes_ask ?? 0));
  const cheapest = sorted.slice(-5);
  console.log("No $180 bracket found. Cheapest (longest odds) markets:");
  for (const m of cheapest) {
    const yesAsk = m.yes_ask ?? m.last_price ?? 0;
    const multiple = yesAsk > 0 ? (100 / yesAsk).toFixed(1) + "x" : "n/a";
    console.log(`  ${m.ticker}: ${m.title} — Yes: ${yesAsk}¢ → ${multiple} payout`);
  }
} else {
  for (const m of high) {
    const yesAsk = m.yes_ask ?? m.last_price ?? 0;
    const multiple = yesAsk > 0 ? (100 / yesAsk).toFixed(1) + "x" : "n/a";
    console.log(`  ${m.ticker}: ${m.title}`);
    console.log(`    Yes ask: ${yesAsk}¢ → buy at ${yesAsk}¢, pays $1 if YES → ${multiple} return`);
    console.log(`    If oil hits 200+, this bracket resolves YES → you get $1 per contract`);
    console.log();
  }
}
