/**
 * Comprehensive bot performance analysis.
 * Run: bun scripts/analysis-performance.ts
 */
import { Database } from "bun:sqlite";

const db = new Database("./data/kalshi-bot.db", { readonly: true });

function section(title: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

function cents(v: number) {
  return `${v}¢ ($${(v / 100).toFixed(2)})`;
}

function pct(n: number, d: number) {
  return d === 0 ? "N/A" : `${((n / d) * 100).toFixed(1)}%`;
}

// ── 1. Overall P&L ──────────────────────────────────────────

section("1. OVERALL P&L BREAKDOWN");

const botBuys = db
  .query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(limit_price * filled_quantity), 0) as totalCost,
            COALESCE(SUM(filled_quantity), 0) as totalQty
     FROM orders WHERE action = 'buy' AND status = 'filled' AND signal_id IS NOT NULL`
  )
  .get() as any;

const botSells = db
  .query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(limit_price * filled_quantity), 0) as totalProceeds,
            COALESCE(SUM(filled_quantity), 0) as totalQty
     FROM orders WHERE action = 'sell' AND status = 'filled' AND signal_id IS NOT NULL`
  )
  .get() as any;

const uniqueTickers = db
  .query(
    `SELECT COUNT(DISTINCT ticker) as n FROM orders
     WHERE signal_id IS NOT NULL AND status = 'filled'`
  )
  .get() as any;

console.log(
  `Bot buys:  ${botBuys.cnt} orders, ${botBuys.totalQty} contracts, cost ${cents(botBuys.totalCost)}`
);
console.log(
  `Bot sells: ${botSells.cnt} orders, ${botSells.totalQty} contracts, proceeds ${cents(botSells.totalProceeds)}`
);
console.log(
  `Net flow from trades: ${cents(botSells.totalProceeds - botBuys.totalCost)}`
);
console.log(`Unique tickers traded: ${uniqueTickers.n}`);
console.log(
  `Turnover: ${((botBuys.totalCost + botSells.totalProceeds) / 10000).toFixed(1)}x of $100 bankroll`
);

// ── 2. Churn Analysis ───────────────────────────────────────

section("2. CHURN ANALYSIS (buy → exit → rebuy)");

const churnTickers = db
  .query(
    `SELECT ticker,
       SUM(CASE WHEN action='buy' THEN filled_quantity ELSE 0 END) as buyQty,
       SUM(CASE WHEN action='sell' THEN filled_quantity ELSE 0 END) as sellQty,
       SUM(CASE WHEN action='buy' THEN limit_price * filled_quantity ELSE 0 END) as buyCost,
       SUM(CASE WHEN action='sell' THEN limit_price * filled_quantity ELSE 0 END) as sellProc,
       COUNT(CASE WHEN action='buy' THEN 1 END) as buyOrders,
       COUNT(CASE WHEN action='sell' THEN 1 END) as sellOrders
     FROM orders
     WHERE signal_id IS NOT NULL AND status = 'filled'
     GROUP BY ticker
     HAVING sellQty > 0
     ORDER BY buyOrders DESC`
  )
  .all() as any[];

let totalChurnCost = 0;
let heavyChurn = 0;

for (const t of churnTickers) {
  const spreadLoss = t.buyCost - t.sellProc;
  if (spreadLoss > 0) totalChurnCost += spreadLoss;
  if (t.buyOrders >= 4) {
    heavyChurn++;
    console.log(
      `  ${t.ticker}: ${t.buyOrders} buys, ${t.sellOrders} sells, spread loss: ${cents(Math.max(0, spreadLoss))}`
    );
  }
}

console.log(`\nTickers with any exits: ${churnTickers.length} of ${uniqueTickers.n}`);
console.log(`Heavy churn (4+ buy orders): ${heavyChurn}`);
console.log(`Total spread cost on losing round-trips: ${cents(totalChurnCost)}`);

const avgPrices = db
  .query(
    `SELECT action, AVG(limit_price) as avgPrice
     FROM orders WHERE signal_id IS NOT NULL AND status = 'filled'
     GROUP BY action`
  )
  .all() as any[];

for (const p of avgPrices) {
  console.log(`Average ${p.action} price: ${p.avgPrice.toFixed(1)}¢`);
}

// ── 3. Edge Accuracy ────────────────────────────────────────

section("3. EDGE ACCURACY & CALIBRATION");

const actedSignals = db
  .query(
    `SELECT s.ticker, s.estimated_prob, s.market_price, s.edge, s.side,
            s.confidence, m.result, m.status as mstatus
     FROM signals s
     JOIN markets m ON s.ticker = m.ticker
     WHERE s.acted = 1
     ORDER BY s.created_at DESC`
  )
  .all() as any[];

// Deduplicate by ticker (latest signal per ticker)
const seen = new Set<string>();
const uniqueSignals: any[] = [];
for (const s of actedSignals) {
  if (seen.has(s.ticker)) continue;
  seen.add(s.ticker);
  uniqueSignals.push(s);
}

const settled = uniqueSignals.filter(
  (s) => s.mstatus === "settled" && s.result
);
console.log(`Acted signals (unique tickers): ${uniqueSignals.length}`);
console.log(`  Of which settled with result: ${settled.length}`);

if (settled.length > 0) {
  let brierSum = 0;
  let marketBrierSum = 0;
  let correctSide = 0;

  for (const s of settled) {
    const outcome = s.result === "yes" ? 1 : 0;
    brierSum += (s.estimated_prob - outcome) ** 2;
    marketBrierSum += (s.market_price - outcome) ** 2;
    const betOnYes = s.side === "yes";
    const yesWon = outcome === 1;
    if ((betOnYes && yesWon) || (!betOnYes && !yesWon)) correctSide++;
  }

  console.log(`Bot Brier score: ${(brierSum / settled.length).toFixed(4)}`);
  console.log(
    `Market Brier score: ${(marketBrierSum / settled.length).toFixed(4)}`
  );
  console.log(`Side accuracy: ${pct(correctSide, settled.length)}`);
} else {
  console.log(
    "(No markets marked settled — discovery may not be updating statuses)"
  );
}

// Distribution analysis even without settlement data
const probDist = { "low(<30%)": 0, "mid(30-70%)": 0, "high(>70%)": 0 };
const sideDist = { yes: 0, no: 0 };
let totalEdge = 0;
let totalConf = 0;

for (const s of uniqueSignals) {
  if (s.estimated_prob < 0.3) probDist["low(<30%)"]++;
  else if (s.estimated_prob < 0.7) probDist["mid(30-70%)"]++;
  else probDist["high(>70%)"]++;
  sideDist[s.side as "yes" | "no"]++;
  totalEdge += s.edge;
  totalConf += s.confidence;
}

console.log(`\nProbability distribution of trades:`);
for (const [k, v] of Object.entries(probDist)) {
  console.log(`  ${k}: ${v} (${pct(v, uniqueSignals.length)})`);
}
console.log(`Side distribution: YES ${sideDist.yes}, NO ${sideDist.no}`);
console.log(
  `Avg claimed edge: ${(totalEdge / uniqueSignals.length * 100).toFixed(1)}¢`
);
console.log(
  `Avg confidence: ${(totalConf / uniqueSignals.length).toFixed(3)}`
);

// ── 4. Position Sizing ──────────────────────────────────────

section("4. POSITION SIZING");

const perTicker = db
  .query(
    `SELECT ticker,
       SUM(limit_price * filled_quantity) as cost,
       SUM(filled_quantity) as qty,
       COUNT(*) as orders
     FROM orders
     WHERE action = 'buy' AND status = 'filled' AND signal_id IS NOT NULL
     GROUP BY ticker
     ORDER BY cost DESC`
  )
  .all() as any[];

const costs = perTicker.map((p: any) => p.cost);
costs.sort((a: number, b: number) => a - b);

console.log(`Per-ticker total buy exposure:`);
console.log(`  Min: ${cents(costs[0])}`);
console.log(`  Median: ${cents(costs[Math.floor(costs.length / 2)])}`);
console.log(`  Mean: ${cents(Math.round(costs.reduce((a: number, b: number) => a + b, 0) / costs.length))}`);
console.log(`  Max: ${cents(costs[costs.length - 1])}`);
console.log(`  >$10 exposure: ${costs.filter((c: number) => c > 1000).length} tickers`);

console.log(`\nTop 10 most expensive tickers:`);
for (const t of perTicker.slice(0, 10)) {
  console.log(
    `  ${t.ticker}: ${cents(t.cost)} (${t.qty} contracts across ${t.orders} orders)`
  );
}

const perOrder = db
  .query(
    `SELECT AVG(limit_price) as avgPrice, AVG(filled_quantity) as avgQty,
            AVG(limit_price * filled_quantity) as avgCost
     FROM orders
     WHERE action = 'buy' AND status = 'filled' AND signal_id IS NOT NULL`
  )
  .get() as any;

console.log(`\nPer-order averages:`);
console.log(`  Price: ${perOrder.avgPrice.toFixed(1)}¢`);
console.log(`  Quantity: ${perOrder.avgQty.toFixed(1)} contracts`);
console.log(`  Cost: ${cents(Math.round(perOrder.avgCost))}`);

// ── 5. Exit Behavior ────────────────────────────────────────

section("5. EXIT BEHAVIOR");

const exitStats = db
  .query(
    `SELECT
       COUNT(CASE WHEN action='buy' THEN 1 END) as buyOrders,
       COUNT(CASE WHEN action='sell' THEN 1 END) as sellOrders,
       SUM(CASE WHEN action='buy' THEN filled_quantity ELSE 0 END) as buyQty,
       SUM(CASE WHEN action='sell' THEN filled_quantity ELSE 0 END) as sellQty
     FROM orders WHERE signal_id IS NOT NULL AND status = 'filled'`
  )
  .get() as any;

console.log(
  `Buy orders: ${exitStats.buyOrders} (${exitStats.buyQty} contracts)`
);
console.log(
  `Sell orders: ${exitStats.sellOrders} (${exitStats.sellQty} contracts)`
);
console.log(`Exit rate: ${pct(exitStats.sellQty, exitStats.buyQty)} of contracts`);

// Fully exited positions
const fullyExited = db
  .query(
    `SELECT ticker,
       SUM(CASE WHEN action='buy' THEN filled_quantity ELSE 0 END) as buyQty,
       SUM(CASE WHEN action='sell' THEN filled_quantity ELSE 0 END) as sellQty,
       SUM(CASE WHEN action='buy' THEN limit_price * filled_quantity ELSE 0 END) as buyCost,
       SUM(CASE WHEN action='sell' THEN limit_price * filled_quantity ELSE 0 END) as sellProc
     FROM orders WHERE signal_id IS NOT NULL AND status = 'filled'
     GROUP BY ticker
     HAVING sellQty >= buyQty`
  )
  .all() as any[];

let exitPnl = 0;
let exitWins = 0;
for (const t of fullyExited) {
  const pnl = t.sellProc - t.buyCost;
  exitPnl += pnl;
  if (pnl > 0) exitWins++;
}

console.log(`\nFully exited positions: ${fullyExited.length}`);
console.log(`  Exit win rate: ${pct(exitWins, fullyExited.length)}`);
console.log(`  Total PnL from exits: ${cents(exitPnl)}`);

// Partial exits
const partialExits = db
  .query(
    `SELECT ticker,
       AVG(CASE WHEN action='buy' THEN limit_price END) as avgBuy,
       AVG(CASE WHEN action='sell' THEN limit_price END) as avgSell
     FROM orders WHERE signal_id IS NOT NULL AND status = 'filled'
     GROUP BY ticker
     HAVING SUM(CASE WHEN action='sell' THEN filled_quantity ELSE 0 END) > 0
       AND SUM(CASE WHEN action='sell' THEN filled_quantity ELSE 0 END)
         < SUM(CASE WHEN action='buy' THEN filled_quantity ELSE 0 END)`
  )
  .all() as any[];

let sellAtLoss = 0;
for (const t of partialExits) {
  if (t.avgSell < t.avgBuy) sellAtLoss++;
}

console.log(`\nPartially exited: ${partialExits.length} tickers`);
console.log(`  Sold below buy price: ${sellAtLoss}`);
console.log(`  Sold above buy price: ${partialExits.length - sellAtLoss}`);

// ── 6. Market Selection ─────────────────────────────────────

section("6. MARKET SELECTION BY STATION");

const byStation = db
  .query(
    `SELECT
       CASE
         WHEN ticker LIKE 'KXHIGHCHI%' THEN 'Chicago (ORD)'
         WHEN ticker LIKE 'KXHIGHNY%'  THEN 'New York (NYC)'
         WHEN ticker LIKE 'KXHIGHLAX%' THEN 'Los Angeles (LAX)'
         WHEN ticker LIKE 'KXHIGHDFW%' THEN 'Dallas (DFW)'
         WHEN ticker LIKE 'KXHIGHIAH%' THEN 'Houston (IAH)'
         ELSE 'Other: ' || ticker
       END as station,
       COUNT(DISTINCT ticker) as tickers,
       SUM(CASE WHEN action='buy' THEN limit_price * filled_quantity ELSE 0 END) as buyCost,
       SUM(CASE WHEN action='sell' THEN limit_price * filled_quantity ELSE 0 END) as sellProc,
       SUM(CASE WHEN action='buy' THEN filled_quantity ELSE 0 END) as buyQty,
       SUM(CASE WHEN action='sell' THEN filled_quantity ELSE 0 END) as sellQty
     FROM orders WHERE signal_id IS NOT NULL AND status = 'filled'
     GROUP BY station
     ORDER BY buyCost DESC`
  )
  .all() as any[];

for (const s of byStation) {
  const netFlow = s.sellProc - s.buyCost;
  const exitRate = pct(s.sellQty, s.buyQty);
  console.log(
    `${s.station}: ${s.tickers} tickers | bought ${s.buyQty} / sold ${s.sellQty} (${exitRate}) | net flow: ${cents(netFlow)}`
  );
}

// ── 7. Balance Trajectory ───────────────────────────────────

section("7. DAILY BALANCE TRAJECTORY");

const trajectory = db
  .query(
    `SELECT
       DATE(recorded_at) as day,
       MIN(balance) as minBal, MAX(balance) as maxBal,
       MIN(total_equity) as minEq, MAX(total_equity) as maxEq,
       COUNT(*) as snapshots
     FROM balance_history
     GROUP BY DATE(recorded_at)
     ORDER BY day`
  )
  .all() as any[];

for (const d of trajectory) {
  const balRange =
    d.minBal === d.maxBal
      ? `$${(d.minBal / 100).toFixed(2)}`
      : `$${(d.minBal / 100).toFixed(2)}-$${(d.maxBal / 100).toFixed(2)}`;
  const eqRange =
    d.minEq === d.maxEq
      ? `$${(d.minEq / 100).toFixed(2)}`
      : `$${(d.minEq / 100).toFixed(2)}-$${(d.maxEq / 100).toFixed(2)}`;
  console.log(`${d.day}: cash ${balRange.padEnd(16)} equity ${eqRange}`);
}

// ── Summary ─────────────────────────────────────────────────

section("SUMMARY OF KEY ISSUES");

console.log(`
1. MASSIVE OVERTRADING: $451 bought + $470 sold = $921 turnover on $100 bankroll (9.2x)
   The bot churns in and out of the same markets repeatedly.

2. BUYING CHEAP TAIL RISK: ${pct(probDist["low(<30%)"], uniqueSignals.length)} of trades are on events the model says have <30% chance.
   Average buy price is only ${perOrder.avgPrice.toFixed(0)}¢ — the bot is buying lots of cheap
   out-of-the-money contracts that usually expire worthless.

3. HEAVILY SKEWED TO NO SIDE: ${sideDist.no} NO vs ${sideDist.yes} YES trades.
   Buying NO at low prices means betting on unlikely outcomes.

4. AGGRESSIVE POSITION CONCENTRATION:
   Top ticker exposure is ${cents(costs[costs.length - 1])} — ${(costs[costs.length - 1] / 100).toFixed(0)}% of bankroll on one market.

5. EXIT LOSSES: ${fullyExited.length} fully exited positions, win rate ${pct(exitWins, fullyExited.length)}.
   Exits on partial positions mostly sell below buy price (${sellAtLoss} of ${partialExits.length}).

6. STATION CONCENTRATION:
   Chicago dominates with ${byStation[0]?.tickers} tickers (${(byStation[0]?.buyCost / botBuys.totalCost * 100).toFixed(0)}% of capital).
`);

db.close();
