import { Database } from "bun:sqlite";
const db = new Database("./data/kalshi-bot.db", { readonly: true });

console.log("═══════════════════════════════════════════════════════════════");
console.log("  1. OVERALL P&L BREAKDOWN");
console.log("═══════════════════════════════════════════════════════════════\n");

// On Kalshi: buying YES at price P costs P cents. If YES wins, you get 100 cents. If NO wins, you get 0.
// Buying NO at price P costs P cents. If NO wins, you get 100 cents. If YES wins, you get 0.
// Selling is the reverse: selling YES at P gets you P cents, selling NO at P gets you P cents.

// Total buy cost from trades (bot orders only = signal_id IS NOT NULL in orders)
const buyCost = db.query(`
  SELECT
    t.side,
    count(*) as num_trades,
    sum(t.quantity) as total_contracts,
    sum(t.price * t.quantity) as total_cost_cents,
    avg(t.price) as avg_price,
    min(t.price) as min_price,
    max(t.price) as max_price
  FROM trades t
  JOIN orders o ON t.order_id = o.order_id
  WHERE o.signal_id IS NOT NULL AND o.signal_id != 'bot-exit' AND t.action = 'buy'
  GROUP BY t.side
`).all();

console.log("BUY trades (entering positions):");
for (const row of buyCost as any[]) {
  console.log(`  Side: ${row.side}`);
  console.log(`    Trades: ${row.num_trades}, Contracts: ${row.total_contracts}`);
  console.log(`    Total cost: ${row.total_cost_cents} cents ($${(row.total_cost_cents / 100).toFixed(2)})`);
  console.log(`    Avg price: ${row.avg_price.toFixed(1)}c, Range: ${row.min_price}-${row.max_price}c`);
}

const sellProceeds = db.query(`
  SELECT
    t.side,
    count(*) as num_trades,
    sum(t.quantity) as total_contracts,
    sum(t.price * t.quantity) as total_proceeds_cents,
    avg(t.price) as avg_price,
    min(t.price) as min_price,
    max(t.price) as max_price
  FROM trades t
  JOIN orders o ON t.order_id = o.order_id
  WHERE o.signal_id IS NOT NULL AND t.action = 'sell'
  GROUP BY t.side
`).all();

console.log("\nSELL trades (exiting positions):");
for (const row of sellProceeds as any[]) {
  console.log(`  Side: ${row.side}`);
  console.log(`    Trades: ${row.num_trades}, Contracts: ${row.total_contracts}`);
  console.log(`    Total proceeds: ${row.total_proceeds_cents} cents ($${(row.total_proceeds_cents / 100).toFixed(2)})`);
  console.log(`    Avg price: ${row.avg_price.toFixed(1)}c, Range: ${row.min_price}-${row.max_price}c`);
}

// Total summary
const totalBuy = db.query(`
  SELECT sum(t.price * t.quantity) as total
  FROM trades t JOIN orders o ON t.order_id = o.order_id
  WHERE o.signal_id IS NOT NULL AND o.signal_id != 'bot-exit' AND t.action = 'buy'
`).get() as any;

const totalSell = db.query(`
  SELECT sum(t.price * t.quantity) as total
  FROM trades t JOIN orders o ON t.order_id = o.order_id
  WHERE o.signal_id IS NOT NULL AND t.action = 'sell'
`).get() as any;

console.log("\n--- AGGREGATE ---");
console.log(`Total spent buying:  ${totalBuy.total} cents ($${(totalBuy.total / 100).toFixed(2)})`);
console.log(`Total from selling:  ${totalSell.total} cents ($${(totalSell.total / 100).toFixed(2)})`);
console.log(`Net from trades:     ${totalSell.total - totalBuy.total} cents ($${((totalSell.total - totalBuy.total) / 100).toFixed(2)})`);

// Balance-based P&L (most reliable since it includes settlements)
console.log("\n--- BALANCE-BASED P&L ---");
const balFirst = db.query("SELECT balance, total_equity, recorded_at FROM balance_history ORDER BY recorded_at ASC LIMIT 1").get() as any;
const balLast = db.query("SELECT balance, total_equity, recorded_at FROM balance_history ORDER BY recorded_at DESC LIMIT 1").get() as any;
console.log(`Starting balance:  ${balFirst.balance} cents ($${(balFirst.balance / 100).toFixed(2)}) at ${balFirst.recorded_at}`);
console.log(`Starting equity:   ${balFirst.total_equity} cents ($${(balFirst.total_equity / 100).toFixed(2)})`);
console.log(`Current balance:   ${balLast.balance} cents ($${(balLast.balance / 100).toFixed(2)}) at ${balLast.recorded_at}`);
console.log(`Current equity:    ${balLast.total_equity} cents ($${(balLast.total_equity / 100).toFixed(2)})`);
console.log(`P&L (equity):      ${balLast.total_equity - balFirst.total_equity} cents ($${((balLast.total_equity - balFirst.total_equity) / 100).toFixed(2)})`);
console.log(`P&L (cash):        ${balLast.balance - balFirst.balance} cents ($${((balLast.balance - balFirst.balance) / 100).toFixed(2)})`);

// Infer settlements: Look at balance jumps when open_positions decreases
// A settlement shows up as a balance increase without a corresponding sell trade
console.log("\n--- INFERRING SETTLEMENTS FROM BALANCE HISTORY ---");
// Find large balance jumps
const balanceJumps = db.query(`
  WITH bh AS (
    SELECT
      balance,
      total_equity,
      open_positions,
      recorded_at,
      LAG(balance) OVER (ORDER BY recorded_at) as prev_balance,
      LAG(total_equity) OVER (ORDER BY recorded_at) as prev_equity,
      LAG(open_positions) OVER (ORDER BY recorded_at) as prev_positions,
      LAG(recorded_at) OVER (ORDER BY recorded_at) as prev_time
    FROM balance_history
  )
  SELECT * FROM bh
  WHERE abs(balance - prev_balance) > 50
  ORDER BY abs(balance - prev_balance) DESC
  LIMIT 30
`).all();

console.log("Large balance changes (>50 cents):");
let totalSettlement = 0;
for (const j of balanceJumps as any[]) {
  const delta = j.balance - j.prev_balance;
  const posDelta = j.open_positions - j.prev_positions;
  console.log(`  ${j.prev_time?.substring(0, 19)} -> ${j.recorded_at.substring(0, 19)}: balance ${delta > 0 ? '+' : ''}${delta}c, positions ${posDelta > 0 ? '+' : ''}${posDelta}, equity ${j.total_equity - j.prev_equity > 0 ? '+' : ''}${j.total_equity - j.prev_equity}c`);
}

// Current positions value
console.log("\n--- CURRENT OPEN POSITIONS ---");
const positions = db.query("SELECT * FROM positions").all();
for (const p of positions as any[]) {
  console.log(`  ${p.ticker} ${p.side}: qty=${p.quantity}, avg_entry=${p.avg_entry_price}, cost=${p.cost_basis}, mkt_val=${p.market_value}, unrealized=${p.unrealized_pnl}`);
}

// Break down: what fraction of contracts bought have been sold vs presumably settled?
console.log("\n--- CONTRACT LIFECYCLE ---");
const lifecycle = db.query(`
  WITH bought AS (
    SELECT t.ticker, t.side, sum(t.quantity) as bought_qty
    FROM trades t JOIN orders o ON t.order_id = o.order_id
    WHERE o.signal_id IS NOT NULL AND o.signal_id != 'bot-exit' AND t.action = 'buy'
    GROUP BY t.ticker, t.side
  ),
  sold AS (
    SELECT t.ticker, t.side, sum(t.quantity) as sold_qty
    FROM trades t JOIN orders o ON t.order_id = o.order_id
    WHERE o.signal_id IS NOT NULL AND t.action = 'sell'
    GROUP BY t.ticker, t.side
  ),
  held AS (
    SELECT ticker, side, quantity as held_qty FROM positions
  )
  SELECT
    b.ticker, b.side, b.bought_qty,
    COALESCE(s.sold_qty, 0) as sold_qty,
    COALESCE(h.held_qty, 0) as held_qty,
    b.bought_qty - COALESCE(s.sold_qty, 0) - COALESCE(h.held_qty, 0) as settled_qty
  FROM bought b
  LEFT JOIN sold s ON b.ticker = s.ticker AND b.side = s.side
  LEFT JOIN held h ON b.ticker = h.ticker AND b.side = h.side
  ORDER BY b.ticker
`).all();

let totalBought = 0, totalSold2 = 0, totalHeld = 0, totalSettled = 0;
const settledTickers: any[] = [];
for (const row of lifecycle as any[]) {
  totalBought += row.bought_qty;
  totalSold2 += row.sold_qty;
  totalHeld += row.held_qty;
  totalSettled += row.settled_qty;
  if (row.settled_qty > 0) {
    settledTickers.push(row);
  }
}
console.log(`Total contracts bought: ${totalBought}`);
console.log(`Total contracts sold (exited): ${totalSold2}`);
console.log(`Total contracts still held: ${totalHeld}`);
console.log(`Total contracts settled (bought - sold - held): ${totalSettled}`);

console.log(`\nSettled tickers (${settledTickers.length}):`);
for (const row of settledTickers) {
  console.log(`  ${row.ticker} ${row.side}: bought=${row.bought_qty}, sold=${row.sold_qty}, held=${row.held_qty}, settled=${row.settled_qty}`);
}

// For settled contracts, we need to figure out if they won or lost
// On Kalshi: if you bought YES and YES wins -> you get 100c per contract
// If you bought YES and NO wins -> you get 0
// If you bought NO and NO wins -> you get 100c per contract
// If you bought NO and YES wins -> you get 0
// We can infer wins by looking at the balance change around settlement time
// But since markets table has no results, let's estimate from the ticker patterns

// Parse target dates from tickers
console.log("\n--- SETTLEMENT P&L ESTIMATE ---");
// For each settled ticker, compute what the payout would have been
// We know the bot started with 4770c and now has 5877c cash + positions
// Total cash from sells we can calculate, rest must be settlements

const totalBuyCost2 = db.query(`
  SELECT sum(t.price * t.quantity) as total
  FROM trades t JOIN orders o ON t.order_id = o.order_id
  WHERE o.signal_id IS NOT NULL AND o.signal_id != 'bot-exit' AND t.action = 'buy'
`).get() as any;

const totalSellProceeds2 = db.query(`
  SELECT sum(t.price * t.quantity) as total
  FROM trades t JOIN orders o ON t.order_id = o.order_id
  WHERE o.signal_id IS NOT NULL AND t.action = 'sell'
`).get() as any;

// Balance equation: starting_balance + sell_proceeds - buy_costs + settlement_payouts = current_balance
// settlement_payouts = current_balance - starting_balance - sell_proceeds + buy_costs
const settlementPayouts = balLast.balance - balFirst.balance - totalSellProceeds2.total + totalBuyCost2.total;
console.log(`Settlement payouts = current_balance - starting_balance - sell_proceeds + buy_costs`);
console.log(`  = ${balLast.balance} - ${balFirst.balance} - ${totalSellProceeds2.total} + ${totalBuyCost2.total}`);
console.log(`  = ${settlementPayouts} cents ($${(settlementPayouts / 100).toFixed(2)})`);
console.log(`\nSettled ${totalSettled} contracts -> avg payout = ${(settlementPayouts / totalSettled).toFixed(1)} cents per contract`);
console.log(`Max possible payout (all win at 100c) = ${totalSettled * 100} cents`);
console.log(`Win rate implied: ${((settlementPayouts / (totalSettled * 100)) * 100).toFixed(1)}%`);

// Cost basis for settled contracts
const settledCostBasis = db.query(`
  WITH bought AS (
    SELECT t.ticker, t.side, sum(t.quantity) as bought_qty, sum(t.price * t.quantity) as cost
    FROM trades t JOIN orders o ON t.order_id = o.order_id
    WHERE o.signal_id IS NOT NULL AND o.signal_id != 'bot-exit' AND t.action = 'buy'
    GROUP BY t.ticker, t.side
  ),
  sold AS (
    SELECT t.ticker, t.side, sum(t.quantity) as sold_qty, sum(t.price * t.quantity) as proceeds
    FROM trades t JOIN orders o ON t.order_id = o.order_id
    WHERE o.signal_id IS NOT NULL AND t.action = 'sell'
    GROUP BY t.ticker, t.side
  ),
  held AS (
    SELECT ticker, side, quantity as held_qty FROM positions
  )
  SELECT
    b.ticker, b.side, b.bought_qty, b.cost,
    COALESCE(s.sold_qty, 0) as sold_qty, COALESCE(s.proceeds, 0) as sell_proceeds,
    COALESCE(h.held_qty, 0) as held_qty,
    b.bought_qty - COALESCE(s.sold_qty, 0) - COALESCE(h.held_qty, 0) as settled_qty
  FROM bought b
  LEFT JOIN sold s ON b.ticker = s.ticker AND b.side = s.side
  LEFT JOIN held h ON b.ticker = h.ticker AND b.side = h.side
  WHERE b.bought_qty - COALESCE(s.sold_qty, 0) - COALESCE(h.held_qty, 0) > 0
  ORDER BY b.ticker
`).all();

// For settled contracts, approximate cost basis proportionally
let totalSettledCost = 0;
for (const row of settledCostBasis as any[]) {
  const avgCost = row.cost / row.bought_qty;
  const settledCost = avgCost * row.settled_qty;
  totalSettledCost += settledCost;
}
console.log(`\nCost basis of settled contracts: ${totalSettledCost.toFixed(0)} cents ($${(totalSettledCost / 100).toFixed(2)})`);
console.log(`Settlement P&L: ${(settlementPayouts - totalSettledCost).toFixed(0)} cents ($${((settlementPayouts - totalSettledCost) / 100).toFixed(2)})`);
