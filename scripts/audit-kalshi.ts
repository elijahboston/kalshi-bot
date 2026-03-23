/**
 * Audit script: compare Kalshi API settlements/orders with local DB
 * to identify discrepancies in win rate and PnL reporting.
 */
import { KalshiClient } from "@kcb/kalshi-client";
import { Database } from "bun:sqlite";

const db = new Database("./data/kalshi-bot.db", { readonly: true });
const kalshi = new KalshiClient();

// ── Fetch Kalshi data ──────────────────────────────────────

console.log("Fetching settlements from Kalshi API...");
const settlements = await kalshi.getAllSettlements();
console.log(`  ${settlements.length} settlements from Kalshi\n`);

console.log("Fetching orders from Kalshi API...");
const kalshiOrders = await kalshi.getAllOrders();
console.log(`  ${kalshiOrders.length} orders from Kalshi\n`);

// ── Local DB data ──────────────────────────────────────────

const localOrders = db
  .query(
    `SELECT order_id, ticker, action, side, quantity, filled_quantity, status, signal_id, limit_price
     FROM orders WHERE signal_id IS NOT NULL AND dry_run = 0`
  )
  .all() as Array<{
  order_id: string;
  ticker: string;
  action: string;
  side: string;
  quantity: number;
  filled_quantity: number;
  status: string;
  signal_id: string;
  limit_price: number;
}>;

const localCal = db
  .query(
    `SELECT ticker, traded, realized_pnl, actual_outcome, resolved_at
     FROM calibration WHERE traded = 1
     ORDER BY resolved_at DESC`
  )
  .all() as Array<{
  ticker: string;
  traded: number;
  realized_pnl: number;
  actual_outcome: number;
  resolved_at: string;
}>;

console.log(`Local DB: ${localOrders.length} bot orders, ${localCal.length} traded calibration records\n`);

// ── 1. Orders with filledQuantity=0 but Kalshi says executed ──

console.log("=== FILL QUANTITY DISCREPANCIES ===");
const kalshiOrderMap = new Map(kalshiOrders.map((o) => [o.order_id, o]));

let fillMismatches = 0;
for (const lo of localOrders) {
  if (lo.filled_quantity > 0) continue;
  if (lo.status !== "filled") continue;

  const ko = kalshiOrderMap.get(lo.order_id);
  if (!ko) {
    console.log(`  MISSING on Kalshi: ${lo.order_id} (${lo.ticker})`);
    continue;
  }

  if (ko.status === "executed" && ko.count > 0) {
    fillMismatches++;
    if (fillMismatches <= 10) {
      console.log(
        `  ${lo.ticker}: local filled_qty=0 but Kalshi count=${ko.count} status=${ko.status}`
      );
    }
  }
}
console.log(`\nTotal orders with fill=0 but Kalshi executed: ${fillMismatches}`);
console.log();

// ── 2. Settlement PnL vs local calibration PnL ──

console.log("=== SETTLEMENT PNL COMPARISON (recent 20) ===");
const settlementMap = new Map(settlements.map((s) => [s.ticker, s]));

// Only look at tickers where we have both a settlement and a calibration record
let pnlMatches = 0;
let pnlMismatches = 0;
let shown = 0;

for (const cal of localCal) {
  const s = settlementMap.get(cal.ticker);
  if (!s) continue;

  const kalshiPnl = s.realized_pnl ?? (s.revenue - (s.yes_total_cost ?? 0) - (s.no_total_cost ?? 0));
  const localPnl = cal.realized_pnl;

  if (Math.abs(kalshiPnl - localPnl) > 1) {
    pnlMismatches++;
    if (shown < 20) {
      const kalshiResult = s.market_result;
      console.log(
        `  ${cal.ticker}: kalshi_pnl=${kalshiPnl} local_pnl=${localPnl} result=${kalshiResult} local_outcome=${cal.actual_outcome}`
      );
      shown++;
    }
  } else {
    pnlMatches++;
  }
}

console.log(`\nPnL matches: ${pnlMatches}, mismatches: ${pnlMismatches}`);
console.log();

// ── 3. Win rate comparison ──

console.log("=== WIN RATE COMPARISON ===");

// Kalshi win rate from settlements (only tickers we traded)
const tradedTickers = new Set(localOrders.map((o) => o.ticker));
const tradedSettlements = settlements.filter((s) => tradedTickers.has(s.ticker));
const kalshiWins = tradedSettlements.filter((s) => s.realized_pnl > 0).length;
const kalshiTotal = tradedSettlements.length;

// Local win rate from calibration
const localWins = localCal.filter((c) => c.realized_pnl > 0).length;
const localTotal = localCal.length;
const localZeroPnl = localCal.filter((c) => c.realized_pnl === 0).length;

console.log(`Kalshi settlements (traded tickers): ${kalshiWins}/${kalshiTotal} wins = ${kalshiTotal > 0 ? ((kalshiWins / kalshiTotal) * 100).toFixed(1) : 0}%`);
console.log(`Local calibration: ${localWins}/${localTotal} wins = ${localTotal > 0 ? ((localWins / localTotal) * 100).toFixed(1) : 0}%`);
console.log(`Local calibration with PnL=0 (stuck): ${localZeroPnl}`);
console.log();

// ── 4. Time-windowed win rates ──

console.log("=== TIME-WINDOWED WIN RATES (Kalshi truth) ===");
const now = Date.now();
for (const { label, hours } of [
  { label: "24h", hours: 24 },
  { label: "48h", hours: 48 },
  { label: "7d", hours: 168 },
]) {
  const cutoff = new Date(now - hours * 60 * 60 * 1000).toISOString();

  const kalshiWindow = tradedSettlements.filter(
    (s) => s.settled_time >= cutoff
  );
  const kWins = kalshiWindow.filter((s) => s.realized_pnl > 0).length;

  const localWindow = localCal.filter((c) => c.resolved_at >= cutoff);
  const lWins = localWindow.filter((c) => c.realized_pnl > 0).length;

  console.log(
    `  ${label}: Kalshi ${kWins}/${kalshiWindow.length} | Local ${lWins}/${localWindow.length}`
  );
}

// ── 5. Tickers settled on Kalshi but missing from calibration ──

console.log("\n=== MISSING CALIBRATION RECORDS ===");
const calTickers = new Set(localCal.map((c) => c.ticker));
const allCalTickers = new Set(
  (db.query("SELECT ticker FROM calibration").all() as Array<{ ticker: string }>).map(
    (r) => r.ticker
  )
);

let missingTraded = 0;
for (const s of tradedSettlements) {
  if (!allCalTickers.has(s.ticker)) {
    missingTraded++;
    if (missingTraded <= 10) {
      console.log(`  ${s.ticker}: settled on Kalshi but no calibration record`);
    }
  }
}
console.log(`Total traded tickers missing from calibration: ${missingTraded}`);
