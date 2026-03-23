import { Database } from "bun:sqlite";
const db = new Database("./data/kalshi-bot.db", { readonly: true });

// Sample some orders to understand structure
console.log("=== Sample orders (bot orders with signal_id) ===");
const orders = db.query("SELECT * FROM orders WHERE signal_id IS NOT NULL LIMIT 5").all();
console.log(JSON.stringify(orders, null, 2));

console.log("\n=== Order action/side/status distribution (bot orders) ===");
const dist = db.query(`
  SELECT action, side, status, count(*) as n, sum(filled_quantity) as total_filled
  FROM orders WHERE signal_id IS NOT NULL
  GROUP BY action, side, status ORDER BY n DESC
`).all();
console.log(JSON.stringify(dist, null, 2));

console.log("\n=== Sample trades ===");
const trades = db.query("SELECT * FROM trades LIMIT 5").all();
console.log(JSON.stringify(trades, null, 2));

console.log("\n=== Sample signals (acted) ===");
const sigs = db.query("SELECT * FROM signals WHERE acted = 1 LIMIT 3").all();
console.log(JSON.stringify(sigs, null, 2));

console.log("\n=== Market result distribution ===");
const mkt = db.query("SELECT result, status, count(*) as n FROM markets GROUP BY result, status").all();
console.log(JSON.stringify(mkt, null, 2));

console.log("\n=== Dry run distribution ===");
const dry = db.query("SELECT dry_run, count(*) as n FROM orders WHERE signal_id IS NOT NULL GROUP BY dry_run").all();
console.log(JSON.stringify(dry, null, 2));

console.log("\n=== Balance history range ===");
const bal = db.query("SELECT min(recorded_at) as first, max(recorded_at) as last, min(balance) as min_bal, max(balance) as max_bal FROM balance_history").get();
console.log(JSON.stringify(bal, null, 2));
