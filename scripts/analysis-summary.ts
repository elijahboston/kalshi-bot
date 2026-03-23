import { Database } from "bun:sqlite";
const db = new Database("./data/kalshi-bot.db", { readonly: true });

console.log("=== COMPREHENSIVE P&L RECONCILIATION ===\n");

// Starting balance vs current
const first = db.query(
  `SELECT * FROM balance_history ORDER BY recorded_at ASC LIMIT 1`
).get() as { balance: number; total_equity: number; recorded_at: string };
const last = db.query(
  `SELECT * FROM balance_history ORDER BY recorded_at DESC LIMIT 1`
).get() as {
  balance: number;
  total_equity: number;
  open_positions: number;
  recorded_at: string;
};

console.log(`Starting: ${first.recorded_at} balance=$${(first.balance / 100).toFixed(2)} equity=$${(first.total_equity / 100).toFixed(2)}`);
console.log(`Current:  ${last.recorded_at} balance=$${(last.balance / 100).toFixed(2)} equity=$${(last.total_equity / 100).toFixed(2)} positions=${last.open_positions}`);
console.log(`Equity change: $${((last.total_equity - first.total_equity) / 100).toFixed(2)} (${((last.total_equity / first.total_equity - 1) * 100).toFixed(1)}%)`);
console.log(`Balance change: $${((last.balance - first.balance) / 100).toFixed(2)}`);

// Calculate implied total P&L using last prices as settlement proxy
console.log("\n=== IMPLIED P&L (using last prices as settlement proxy) ===\n");
const impliedPnl = db.query(`
  WITH pos AS (
    SELECT
      t.ticker, t.side,
      m.last_yes_price, m.last_no_price, m.target_date,
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
    SUM(buy_cost) as total_buy,
    SUM(sell_proceeds) as total_sell,
    SUM(CASE WHEN side='yes' THEN (bought-sold)*last_yes_price
             WHEN side='no' THEN (bought-sold)*last_no_price
             ELSE 0 END) as held_value,
    COUNT(*) as total_positions,
    SUM(CASE
      WHEN sell_proceeds + (CASE WHEN side='yes' THEN (bought-sold)*last_yes_price
                                  WHEN side='no' THEN (bought-sold)*last_no_price ELSE 0 END) > buy_cost
      THEN 1 ELSE 0 END) as profitable_positions,
    SUM(bought) as total_bought,
    SUM(sold) as total_sold
  FROM pos
`).get() as {
  total_buy: number;
  total_sell: number;
  held_value: number;
  total_positions: number;
  profitable_positions: number;
  total_bought: number;
  total_sold: number;
};

console.log(`Total buy cost: $${(impliedPnl.total_buy / 100).toFixed(2)} (${impliedPnl.total_bought} contracts)`);
console.log(`Total sell proceeds: $${(impliedPnl.total_sell / 100).toFixed(2)} (${impliedPnl.total_sold} contracts)`);
console.log(`Held-to-settlement value: $${(impliedPnl.held_value / 100).toFixed(2)}`);
console.log(`Net implied P&L: $${((impliedPnl.total_sell + impliedPnl.held_value - impliedPnl.total_buy) / 100).toFixed(2)}`);
console.log(`Profitable positions: ${impliedPnl.profitable_positions}/${impliedPnl.total_positions}`);

// Breakdown: yes-side vs no-side performance
console.log("\n=== YES vs NO SIDE PERFORMANCE ===\n");
const sidePerf = db.query(`
  WITH pos AS (
    SELECT
      t.ticker, t.side,
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
    side,
    COUNT(*) as positions,
    SUM(buy_cost) as total_buy,
    SUM(sell_proceeds) as total_sell,
    SUM(bought) as total_bought,
    SUM(sold) as total_sold,
    SUM(CASE WHEN side='yes' THEN (bought-sold)*last_yes_price
             WHEN side='no' THEN (bought-sold)*last_no_price
             ELSE 0 END) as held_value,
    AVG(CASE WHEN side='yes' THEN last_yes_price ELSE last_no_price END) as avg_final
  FROM pos
  GROUP BY side
`).all() as {
  side: string;
  positions: number;
  total_buy: number;
  total_sell: number;
  total_bought: number;
  total_sold: number;
  held_value: number;
  avg_final: number;
}[];
for (const r of sidePerf) {
  const pnl = r.total_sell + r.held_value - r.total_buy;
  console.log(`${r.side.toUpperCase()} side:`);
  console.log(`  ${r.positions} positions, ${r.total_bought} bought / ${r.total_sold} sold`);
  console.log(`  Buy: $${(r.total_buy / 100).toFixed(2)}, Sell: $${(r.total_sell / 100).toFixed(2)}, Held: $${(r.held_value / 100).toFixed(2)}`);
  console.log(`  P&L: $${(pnl / 100).toFixed(2)}`);
  console.log(`  Avg final price (own side): ${r.avg_final.toFixed(0)}c`);
}

// Edge accuracy summary for yes vs no
console.log("\n=== EDGE ACCURACY BY SIDE (past target markets) ===\n");
const edgeBySide = db.query(`
  WITH first_signal AS (
    SELECT ticker, side, MIN(created_at) as first_at
    FROM signals WHERE acted = 1
    GROUP BY ticker, side
  ),
  first_acted AS (
    SELECT s.ticker, s.estimated_prob, s.market_price, s.edge, s.side, s.created_at
    FROM signals s
    JOIN first_signal fs ON s.ticker = fs.ticker AND s.side = fs.side AND s.created_at = fs.first_at
    WHERE s.acted = 1
  )
  SELECT
    fa.side,
    COUNT(*) as count,
    SUM(CASE
      WHEN fa.side = 'yes' AND m.last_yes_price > fa.market_price * 100 THEN 1
      WHEN fa.side = 'no' AND m.last_no_price > (1 - fa.market_price) * 100 THEN 1
      ELSE 0
    END) as correct,
    AVG(fa.edge) as avg_edge,
    AVG(fa.estimated_prob) as avg_prob,
    AVG(fa.market_price) as avg_market
  FROM first_acted fa
  JOIN markets m ON m.ticker = fa.ticker
  WHERE m.target_date < '2026-03-03'
  GROUP BY fa.side
`).all() as {
  side: string;
  count: number;
  correct: number;
  avg_edge: number;
  avg_prob: number;
  avg_market: number;
}[];
for (const r of edgeBySide) {
  console.log(`${r.side.toUpperCase()}: ${r.correct}/${r.count} correct (${((r.correct / r.count) * 100).toFixed(0)}%), avg edge=${(r.avg_edge * 100).toFixed(1)}%, avg prob=${(r.avg_prob * 100).toFixed(1)}%, avg market=${(r.avg_market * 100).toFixed(1)}%`);
}

// Churn cost summary
console.log("\n=== CHURN COST SUMMARY ===\n");
const churnCost = db.query(`
  WITH ticker_stats AS (
    SELECT
      ticker, side,
      SUM(CASE WHEN action='buy' THEN price * quantity ELSE 0 END) as buy_cost,
      SUM(CASE WHEN action='sell' THEN price * quantity ELSE 0 END) as sell_proceeds,
      SUM(CASE WHEN action='buy' THEN quantity ELSE 0 END) as bought,
      SUM(CASE WHEN action='sell' THEN quantity ELSE 0 END) as sold,
      COUNT(DISTINCT CASE WHEN action='buy' THEN filled_at END) as buy_events,
      COUNT(DISTINCT CASE WHEN action='sell' THEN filled_at END) as sell_events
    FROM trades
    GROUP BY ticker, side
  ),
  with_churn AS (
    SELECT *,
      buy_events + sell_events as total_events,
      CASE WHEN buy_events > 1 AND sell_events > 0 THEN 1 ELSE 0 END as has_churn
    FROM ticker_stats
  )
  SELECT
    SUM(has_churn) as churned_positions,
    COUNT(*) as total_positions,
    SUM(CASE WHEN has_churn = 1 THEN total_events ELSE 0 END) as churn_trade_events,
    SUM(CASE WHEN has_churn = 1 THEN buy_cost ELSE 0 END) as churn_buy_cost,
    SUM(CASE WHEN has_churn = 1 THEN sell_proceeds ELSE 0 END) as churn_sell_proceeds
  FROM with_churn
  WHERE sold > 0
`).get() as {
  churned_positions: number;
  total_positions: number;
  churn_trade_events: number;
  churn_buy_cost: number;
  churn_sell_proceeds: number;
};
console.log(`Positions with buy->sell->rebuy churn: ${churnCost.churned_positions}/${churnCost.total_positions} (of those with any sells)`);
console.log(`Trade events in churned positions: ${churnCost.churn_trade_events}`);
console.log(`Churn buy cost: $${(churnCost.churn_buy_cost / 100).toFixed(2)}, sell proceeds: $${(churnCost.churn_sell_proceeds / 100).toFixed(2)}`);

// Fees (Kalshi charges fees on trades)
console.log("\n=== ESTIMATED FEES ===\n");
const feeData = db.query(`
  SELECT COUNT(*) as total_trades, SUM(quantity) as total_contracts,
    SUM(price * quantity) as total_notional
  FROM trades
`).get() as { total_trades: number; total_contracts: number; total_notional: number };
// Kalshi fee is typically 1c per contract for market takers (capped)
const estFees = feeData.total_contracts * 1; // 1 cent per contract
console.log(`Total trades: ${feeData.total_trades}, Total contracts: ${feeData.total_contracts}`);
console.log(`Estimated fees (1c/contract): $${(estFees / 100).toFixed(2)}`);
console.log(`Total notional: $${(feeData.total_notional / 100).toFixed(2)}`);

// Skip reason analysis
console.log("\n=== SIGNAL SKIP REASONS ===\n");
const skipReasons = db.query(`
  SELECT skip_reason, COUNT(*) as count
  FROM signals
  WHERE skip_reason IS NOT NULL AND acted = 0
  GROUP BY skip_reason
  ORDER BY count DESC
  LIMIT 20
`).all() as { skip_reason: string; count: number }[];
for (const r of skipReasons) {
  console.log(`  ${r.skip_reason}: ${r.count}`);
}

db.close();
