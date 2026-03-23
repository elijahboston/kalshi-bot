import { Database } from "bun:sqlite";
const db = new Database("./data/kalshi-bot.db", { readonly: true });

// Check if there's settlement info anywhere - maybe in balance history or trades
console.log("=== Balance history sample (recent) ===");
const bh = db.query("SELECT * FROM balance_history ORDER BY recorded_at DESC LIMIT 5").all();
console.log(JSON.stringify(bh, null, 2));

console.log("\n=== Balance history sample (early) ===");
const bh2 = db.query("SELECT * FROM balance_history ORDER BY recorded_at ASC LIMIT 5").all();
console.log(JSON.stringify(bh2, null, 2));

// Check for trades that might indicate settlements
console.log("\n=== Trade actions distribution ===");
const ta = db.query("SELECT action, side, count(*) as n, sum(quantity) as total_qty, avg(price) as avg_price FROM trades GROUP BY action, side").all();
console.log(JSON.stringify(ta, null, 2));

// Look at tickers that have both buy and sell trades
console.log("\n=== Tickers with sells (potential exits/settlements) ===");
const sells = db.query(`
  SELECT t.ticker, t.action, t.side, t.price, t.quantity, t.filled_at, o.signal_id
  FROM trades t
  LEFT JOIN orders o ON t.order_id = o.order_id
  WHERE t.action = 'sell'
  ORDER BY t.filled_at
  LIMIT 20
`).all();
console.log(JSON.stringify(sells, null, 2));

// Check if Kalshi settled contracts show up as sells with price 100 or 0
console.log("\n=== Sell trades price distribution ===");
const sp = db.query(`
  SELECT t.price, count(*) as n, sum(t.quantity) as total_qty
  FROM trades t WHERE t.action = 'sell'
  GROUP BY t.price ORDER BY t.price
`).all();
console.log(JSON.stringify(sp, null, 2));

// Check for markets whose target_date has passed
console.log("\n=== Markets by target_date ===");
const md = db.query(`
  SELECT target_date, count(*) as n
  FROM markets
  GROUP BY target_date
  ORDER BY target_date
`).all();
console.log(JSON.stringify(md, null, 2));

// Look at the series_ticker distribution in signals that were acted on
console.log("\n=== Series ticker distribution (acted signals) ===");
const st = db.query(`
  SELECT series_ticker, count(*) as n
  FROM signals WHERE acted = 1
  GROUP BY series_ticker ORDER BY n DESC
`).all();
console.log(JSON.stringify(st, null, 2));

// Check unique tickers in orders
console.log("\n=== Unique tickers with bot orders ===");
const ut = db.query(`
  SELECT COUNT(DISTINCT ticker) as n FROM orders WHERE signal_id IS NOT NULL AND status='filled'
`).get();
console.log(JSON.stringify(ut));

// Balance history to understand P&L over time
console.log("\n=== Balance at start vs end ===");
const balStart = db.query("SELECT * FROM balance_history ORDER BY recorded_at ASC LIMIT 1").get();
const balEnd = db.query("SELECT * FROM balance_history ORDER BY recorded_at DESC LIMIT 1").get();
console.log("Start:", JSON.stringify(balStart));
console.log("End:", JSON.stringify(balEnd));
