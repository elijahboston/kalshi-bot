import { Database } from "bun:sqlite";
const db = new Database("./data/kalshi-bot.db", { readonly: true });

console.log("=== 6. MARKET SELECTION ===\n");

// Series/category breakdown
const seriesPerf = db.query(`
  WITH pos AS (
    SELECT
      t.ticker, t.side, m.series_ticker, m.category, m.target_date,
      m.last_yes_price, m.last_no_price,
      SUM(CASE WHEN t.action='buy' THEN t.price*t.quantity ELSE 0 END) as buy_cost,
      SUM(CASE WHEN t.action='sell' THEN t.price*t.quantity ELSE 0 END) as sell_proceeds,
      SUM(CASE WHEN t.action='buy' THEN t.quantity ELSE 0 END) as bought,
      SUM(CASE WHEN t.action='sell' THEN t.quantity ELSE 0 END) as sold
    FROM trades t
    JOIN markets m ON m.ticker = t.ticker
    WHERE m.target_date < '2026-03-03'
    GROUP BY t.ticker, t.side
  )
  SELECT
    series_ticker,
    COUNT(*) as positions,
    SUM(buy_cost) as total_buy_cost,
    SUM(sell_proceeds) as total_sell_proceeds,
    SUM(bought) as total_bought,
    SUM(sold) as total_sold,
    SUM(bought - sold) as net_held,
    SUM(CASE WHEN side='yes' THEN (bought-sold)*last_yes_price
             WHEN side='no' THEN (bought-sold)*last_no_price
             ELSE 0 END) as held_final_value,
    AVG(CASE WHEN side='yes' THEN last_yes_price ELSE last_no_price END) as avg_final_price
  FROM pos
  GROUP BY series_ticker
  ORDER BY total_buy_cost DESC
`).all() as { series_ticker: string; positions: number; total_buy_cost: number; total_sell_proceeds: number; total_bought: number; total_sold: number; net_held: number; held_final_value: number; avg_final_price: number }[];

console.log("Performance by series (past target date, using last prices as proxy for settlement):");
for (const r of seriesPerf) {
  const impliedPnl = r.total_sell_proceeds + r.held_final_value - r.total_buy_cost;
  console.log(`\n  ${r.series_ticker}:`);
  console.log(`    Positions: ${r.positions}, Bought: ${r.total_bought}, Sold: ${r.total_sold}, Held: ${r.net_held}`);
  console.log(`    Buy cost: $${(r.total_buy_cost / 100).toFixed(2)}, Sell proceeds: $${(r.total_sell_proceeds / 100).toFixed(2)}`);
  console.log(`    Held final value: $${(r.held_final_value / 100).toFixed(2)}`);
  console.log(`    Implied P&L: $${(impliedPnl / 100).toFixed(2)}`);
  console.log(`    Avg final price (traded side): ${r.avg_final_price.toFixed(0)}c`);
}

// By city (extracted from ticker)
console.log("\n\nPerformance by city:");
const cityPerf = db.query(`
  WITH pos AS (
    SELECT
      t.ticker, t.side,
      CASE
        WHEN t.ticker LIKE '%CHI%' THEN 'Chicago'
        WHEN t.ticker LIKE '%NY%' THEN 'New York'
        WHEN t.ticker LIKE '%LAX%' THEN 'Los Angeles'
        ELSE 'Other'
      END as city,
      m.last_yes_price, m.last_no_price,
      SUM(CASE WHEN t.action='buy' THEN t.price*t.quantity ELSE 0 END) as buy_cost,
      SUM(CASE WHEN t.action='sell' THEN t.price*t.quantity ELSE 0 END) as sell_proceeds,
      SUM(CASE WHEN t.action='buy' THEN t.quantity ELSE 0 END) as bought,
      SUM(CASE WHEN t.action='sell' THEN t.quantity ELSE 0 END) as sold
    FROM trades t
    JOIN markets m ON m.ticker = t.ticker
    WHERE m.target_date < '2026-03-03'
    GROUP BY t.ticker, t.side
  )
  SELECT
    city,
    COUNT(*) as positions,
    SUM(buy_cost) as total_buy,
    SUM(sell_proceeds) as total_sell,
    SUM(CASE WHEN side='yes' THEN (bought-sold)*last_yes_price
             WHEN side='no' THEN (bought-sold)*last_no_price
             ELSE 0 END) as held_value
  FROM pos
  GROUP BY city
`).all() as { city: string; positions: number; total_buy: number; total_sell: number; held_value: number }[];
for (const r of cityPerf) {
  const pnl = r.total_sell + r.held_value - r.total_buy;
  console.log(`  ${r.city}: ${r.positions} positions, buy=$${(r.total_buy / 100).toFixed(2)}, sell=$${(r.total_sell / 100).toFixed(2)}, held=$${(r.held_value / 100).toFixed(2)}, P&L=$${(pnl / 100).toFixed(2)}`);
}

// What bracket types is the bot trading?
console.log("\n\nBracket type analysis (B=above, T=above threshold):");
const bracketPerf = db.query(`
  WITH pos AS (
    SELECT
      t.ticker, t.side,
      CASE
        WHEN t.ticker LIKE '%-B%' THEN 'bracket'
        WHEN t.ticker LIKE '%-T%' THEN 'threshold'
        ELSE 'other'
      END as bracket_type,
      m.last_yes_price, m.last_no_price,
      SUM(CASE WHEN t.action='buy' THEN t.price*t.quantity ELSE 0 END) as buy_cost,
      SUM(CASE WHEN t.action='sell' THEN t.price*t.quantity ELSE 0 END) as sell_proceeds,
      SUM(CASE WHEN t.action='buy' THEN t.quantity ELSE 0 END) as bought,
      SUM(CASE WHEN t.action='sell' THEN t.quantity ELSE 0 END) as sold
    FROM trades t
    JOIN markets m ON m.ticker = t.ticker
    WHERE m.target_date < '2026-03-03'
    GROUP BY t.ticker, t.side
  )
  SELECT
    bracket_type, side,
    COUNT(*) as positions,
    SUM(buy_cost) as total_buy,
    SUM(sell_proceeds) as total_sell,
    SUM(CASE WHEN side='yes' THEN (bought-sold)*last_yes_price
             WHEN side='no' THEN (bought-sold)*last_no_price
             ELSE 0 END) as held_value
  FROM pos
  GROUP BY bracket_type, side
  ORDER BY bracket_type, side
`).all() as { bracket_type: string; side: string; positions: number; total_buy: number; total_sell: number; held_value: number }[];
for (const r of bracketPerf) {
  const pnl = r.total_sell + r.held_value - r.total_buy;
  console.log(`  ${r.bracket_type} (${r.side}): ${r.positions} positions, buy=$${(r.total_buy / 100).toFixed(2)}, sell=$${(r.total_sell / 100).toFixed(2)}, held=$${(r.held_value / 100).toFixed(2)}, P&L=$${(pnl / 100).toFixed(2)}`);
}

console.log("\n\n=== 7. TIMING ANALYSIS ===\n");

// How far from expiry does the bot trade?
interface TimingTrade {
  ticker: string;
  action: string;
  filled_at: string;
  price: number;
  quantity: number;
  side: string;
  target_date: string;
  close_time: string;
  last_yes_price: number;
  last_no_price: number;
  hours_to_close: number;
  days_to_target: number;
}

const timingAnalysis = db.query(`
  SELECT
    t.ticker, t.action, t.filled_at, t.price, t.quantity, t.side,
    m.target_date, m.close_time, m.last_yes_price, m.last_no_price,
    CAST((julianday(m.close_time) - julianday(t.filled_at)) * 24 AS INTEGER) as hours_to_close,
    CAST((julianday(m.target_date) - julianday(t.filled_at)) AS INTEGER) as days_to_target
  FROM trades t
  JOIN markets m ON m.ticker = t.ticker
  WHERE t.action = 'buy'
  ORDER BY hours_to_close
`).all() as TimingTrade[];

// Distribution of hours to close
console.log("Hours to market close when buying:");
const hourBuckets: Record<string, { count: number; total_cost: number; sum_price: number }> = {};
for (const r of timingAnalysis) {
  let bucket: string;
  if (r.hours_to_close < 3) bucket = "0-3h";
  else if (r.hours_to_close < 6) bucket = "3-6h";
  else if (r.hours_to_close < 12) bucket = "6-12h";
  else if (r.hours_to_close < 24) bucket = "12-24h";
  else if (r.hours_to_close < 48) bucket = "24-48h";
  else bucket = "48h+";

  if (!hourBuckets[bucket])
    hourBuckets[bucket] = { count: 0, total_cost: 0, sum_price: 0 };
  hourBuckets[bucket].count++;
  hourBuckets[bucket].total_cost += r.price * r.quantity;
  hourBuckets[bucket].sum_price += r.price;
}
const bucketOrder = ["0-3h", "3-6h", "6-12h", "12-24h", "24-48h", "48h+"];
for (const bucket of bucketOrder) {
  const data = hourBuckets[bucket];
  if (!data) continue;
  console.log(
    `  ${bucket}: ${data.count} buys, $${(data.total_cost / 100).toFixed(2)} total cost, avg price ${(data.sum_price / data.count).toFixed(0)}c`
  );
}

// Win rate by hours to close
console.log(
  "\nWin rate by hours to close (using last price as settlement proxy):"
);
const winByTiming = db.query(`
  WITH buy_timing AS (
    SELECT
      t.ticker, t.side, t.price as buy_price, t.quantity,
      CAST((julianday(m.close_time) - julianday(t.filled_at)) * 24 AS INTEGER) as hours_to_close,
      CASE WHEN t.side = 'yes' THEN m.last_yes_price ELSE m.last_no_price END as final_price
    FROM trades t
    JOIN markets m ON m.ticker = t.ticker
    WHERE t.action = 'buy' AND m.target_date < '2026-03-03'
  )
  SELECT
    CASE
      WHEN hours_to_close < 3 THEN '0-3h'
      WHEN hours_to_close < 6 THEN '3-6h'
      WHEN hours_to_close < 12 THEN '6-12h'
      WHEN hours_to_close < 24 THEN '12-24h'
      WHEN hours_to_close < 48 THEN '24-48h'
      ELSE '48h+'
    END as timing_bucket,
    COUNT(*) as trades,
    SUM(CASE WHEN final_price > buy_price THEN 1 ELSE 0 END) as winners,
    SUM(CASE WHEN final_price <= buy_price THEN 1 ELSE 0 END) as losers,
    SUM((final_price - buy_price) * quantity) as pnl_cents,
    AVG(buy_price) as avg_buy,
    AVG(final_price) as avg_final
  FROM buy_timing
  GROUP BY timing_bucket
  ORDER BY MIN(hours_to_close)
`).all() as {
  timing_bucket: string;
  trades: number;
  winners: number;
  losers: number;
  pnl_cents: number;
  avg_buy: number;
  avg_final: number;
}[];
for (const r of winByTiming) {
  const winRate =
    r.trades > 0 ? ((r.winners / r.trades) * 100).toFixed(0) : "0";
  console.log(
    `  ${r.timing_bucket}: ${r.trades} trades, ${r.winners}W/${r.losers}L (${winRate}%), P&L=$${(r.pnl_cents / 100).toFixed(2)}, avg buy=${r.avg_buy.toFixed(0)}c -> avg final=${r.avg_final.toFixed(0)}c`
  );
}

// Day of week analysis
console.log("\nPerformance by day of week:");
const dayOfWeek = db.query(`
  WITH buy_daily AS (
    SELECT
      t.ticker, t.side, t.price as buy_price, t.quantity,
      CASE CAST(strftime('%w', t.filled_at) AS INTEGER)
        WHEN 0 THEN 'Sunday'
        WHEN 1 THEN 'Monday'
        WHEN 2 THEN 'Tuesday'
        WHEN 3 THEN 'Wednesday'
        WHEN 4 THEN 'Thursday'
        WHEN 5 THEN 'Friday'
        WHEN 6 THEN 'Saturday'
      END as day_name,
      CAST(strftime('%w', t.filled_at) AS INTEGER) as day_num,
      CASE WHEN t.side = 'yes' THEN m.last_yes_price ELSE m.last_no_price END as final_price
    FROM trades t
    JOIN markets m ON m.ticker = t.ticker
    WHERE t.action = 'buy' AND m.target_date < '2026-03-03'
  )
  SELECT
    day_name, day_num,
    COUNT(*) as trades,
    SUM((final_price - buy_price) * quantity) as pnl_cents,
    SUM(buy_price * quantity) as total_cost
  FROM buy_daily
  GROUP BY day_name, day_num
  ORDER BY day_num
`).all() as {
  day_name: string;
  day_num: number;
  trades: number;
  pnl_cents: number;
  total_cost: number;
}[];
for (const r of dayOfWeek) {
  console.log(
    `  ${r.day_name}: ${r.trades} buys, cost=$${(r.total_cost / 100).toFixed(2)}, P&L=$${(r.pnl_cents / 100).toFixed(2)}`
  );
}

// Hour of day analysis
console.log("\nPerformance by hour of day (UTC):");
const hourOfDay = db.query(`
  WITH buy_hourly AS (
    SELECT
      t.ticker, t.side, t.price as buy_price, t.quantity,
      CAST(strftime('%H', t.filled_at) AS INTEGER) as hour,
      CASE WHEN t.side = 'yes' THEN m.last_yes_price ELSE m.last_no_price END as final_price
    FROM trades t
    JOIN markets m ON m.ticker = t.ticker
    WHERE t.action = 'buy' AND m.target_date < '2026-03-03'
  )
  SELECT
    hour,
    COUNT(*) as trades,
    SUM((final_price - buy_price) * quantity) as pnl_cents,
    SUM(buy_price * quantity) as total_cost
  FROM buy_hourly
  GROUP BY hour
  ORDER BY hour
`).all() as { hour: number; trades: number; pnl_cents: number; total_cost: number }[];
for (const r of hourOfDay) {
  console.log(
    `  ${r.hour.toString().padStart(2, "0")}:00 UTC: ${r.trades} buys, cost=$${(r.total_cost / 100).toFixed(2)}, P&L=$${(r.pnl_cents / 100).toFixed(2)}`
  );
}

db.close();
