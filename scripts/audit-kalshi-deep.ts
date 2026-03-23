/**
 * Deeper audit: understand fill quantity and PnL discrepancies
 */
import { KalshiClient } from "@kcb/kalshi-client";
import { Database } from "bun:sqlite";

const db = new Database("./data/kalshi-bot.db", { readonly: true });
const kalshi = new KalshiClient();

const settlements = await kalshi.getAllSettlements();
const kalshiOrders = await kalshi.getAllOrders();
const kalshiOrderMap = new Map(kalshiOrders.map((o) => [o.order_id, o]));
const settlementMap = new Map(settlements.map((s) => [s.ticker, s]));

// ── 1. Why do 179 orders have filled_quantity=0 + status=filled? ──

console.log("=== DIAGNOSING filled_quantity=0 + status=filled ===\n");

const stuckOrders = db
  .query(
    `SELECT order_id, ticker, action, side, quantity, filled_quantity, status, signal_id
     FROM orders WHERE signal_id IS NOT NULL AND dry_run = 0
     AND filled_quantity = 0 AND status = 'filled'`
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
}>;

let onKalshi = 0, notOnKalshi = 0, executedOnKalshi = 0;
for (const lo of stuckOrders) {
  const ko = kalshiOrderMap.get(lo.order_id);
  if (ko) {
    onKalshi++;
    if (ko.status === "executed") executedOnKalshi++;
  } else {
    notOnKalshi++;
  }
}
console.log(`${stuckOrders.length} stuck orders (filled_qty=0, status=filled):`);
console.log(`  Found on Kalshi API: ${onKalshi} (${executedOnKalshi} with status=executed)`);
console.log(`  NOT on Kalshi API: ${notOnKalshi}`);

// Show a few not-on-Kalshi examples
const notOnKalshiExamples = stuckOrders.filter((o) => !kalshiOrderMap.has(o.order_id));
console.log(`\nExamples of orders NOT on Kalshi:`);
for (const o of notOnKalshiExamples.slice(0, 5)) {
  console.log(`  ${o.order_id} ${o.ticker} ${o.action} ${o.side} qty=${o.quantity}`);
}

// ── 2. How many local orders exist on Kalshi? ──

console.log("\n=== ORDER OVERLAP ===\n");
const allBotOrders = db
  .query(
    `SELECT order_id, ticker, action, side, quantity, filled_quantity, status, signal_id
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
}>;

let localOnKalshi = 0, localNotOnKalshi = 0;
for (const lo of allBotOrders) {
  if (kalshiOrderMap.has(lo.order_id)) localOnKalshi++;
  else localNotOnKalshi++;
}
console.log(`Local bot orders: ${allBotOrders.length}`);
console.log(`  Found on Kalshi: ${localOnKalshi}`);
console.log(`  NOT on Kalshi: ${localNotOnKalshi}`);

// Are not-on-Kalshi orders mostly sells or a specific pattern?
const notOnKalshiAll = allBotOrders.filter((o) => !kalshiOrderMap.has(o.order_id));
const byStat: Record<string, number> = {};
const byAction: Record<string, number> = {};
for (const o of notOnKalshiAll) {
  byStat[o.status] = (byStat[o.status] ?? 0) + 1;
  byAction[o.action] = (byAction[o.action] ?? 0) + 1;
}
console.log(`  By status:`, byStat);
console.log(`  By action:`, byAction);

// ── 3. Detailed PnL comparison for a single ticker ──

console.log("\n=== DETAILED: KXHIGHNY-26MAR05-B43.5 ===\n");
const ticker = "KXHIGHNY-26MAR05-B43.5";

const tickerOrders = db
  .query(
    `SELECT order_id, action, side, quantity, filled_quantity, limit_price, status, signal_id
     FROM orders WHERE ticker = ? AND signal_id IS NOT NULL ORDER BY created_at`
  )
  .all(ticker) as Array<{
  order_id: string;
  action: string;
  side: string;
  quantity: number;
  filled_quantity: number;
  limit_price: number;
  status: string;
  signal_id: string;
}>;

console.log("Local DB orders:");
for (const o of tickerOrders) {
  const ko = kalshiOrderMap.get(o.order_id);
  const kalshiInfo = ko
    ? `kalshi: count=${ko.count} remaining=${ko.remaining_count} status=${ko.status}`
    : "NOT ON KALSHI";
  console.log(
    `  ${o.action.padEnd(4)} ${o.side.padEnd(3)} qty=${String(o.quantity).padEnd(3)} filled=${String(o.filled_quantity).padEnd(3)} price=${String(o.limit_price).padEnd(4)} status=${o.status.padEnd(8)} | ${kalshiInfo}`
  );
}

const sKalshi = settlementMap.get(ticker);
if (sKalshi) {
  console.log(`\nKalshi settlement:`);
  console.log(`  result=${sKalshi.market_result} yes_count=${sKalshi.yes_count} no_count=${sKalshi.no_count}`);
  console.log(`  yes_cost=${sKalshi.yes_total_cost} no_cost=${sKalshi.no_total_cost}`);
  console.log(`  revenue=${sKalshi.revenue} realized_pnl=${sKalshi.realized_pnl}`);
}

const calRecord = db
  .query("SELECT * FROM calibration WHERE ticker = ?")
  .get(ticker) as Record<string, unknown> | null;
if (calRecord) {
  console.log(`\nLocal calibration:`);
  console.log(`  traded=${calRecord.traded} realized_pnl=${calRecord.realized_pnl} actual_outcome=${calRecord.actual_outcome}`);
}

// ── 4. Summary: Kalshi's actual account PnL ──

console.log("\n=== KALSHI ACCOUNT-LEVEL PNL ===\n");
const totalKalshiPnl = settlements.reduce((s, t) => s + (t.realized_pnl ?? 0), 0);
const localTotalPnl = (
  db.query("SELECT SUM(realized_pnl) as total FROM calibration WHERE traded = 1").get() as {
    total: number | null;
  }
).total ?? 0;

console.log(`Kalshi total realized PnL: $${(totalKalshiPnl / 100).toFixed(2)}`);
console.log(`Local total realized PnL: $${(localTotalPnl / 100).toFixed(2)}`);
console.log(`Gap: $${((totalKalshiPnl - localTotalPnl) / 100).toFixed(2)}`);

// Check if user was right about 3/4 positive payouts for Mar 5 NYC
console.log("\n=== MARCH 5 NYC SETTLEMENTS ===\n");
const mar5ny = settlements.filter((s) => s.ticker.startsWith("KXHIGHNY-26MAR05"));
for (const s of mar5ny) {
  console.log(
    `  ${s.ticker}: result=${s.market_result} revenue=${s.revenue} cost=${s.yes_total_cost + s.no_total_cost} pnl=${s.realized_pnl}`
  );
}
