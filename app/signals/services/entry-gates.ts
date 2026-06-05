import type { Market } from "@kcb/db";

export interface TailGateInput {
  market: Pick<Market, "marketType">;
  side: "yes" | "no";
  /** Market-implied P(YES) in [0, 1] */
  marketPrice: number;
  /** Max contract entry price (in [0, 1]) the bot may pay on a tail market. 0 = gate disabled. */
  tailMaxEntryPrice: number;
}

export interface TailGateResult {
  allowed: boolean;
  /** Skip-reason string, populated when allowed=false */
  reason?: string;
}

/**
 * Gate tail-market entries by the contract price the bot would pay. Tails
 * (upper_tail / lower_tail) have historically bled: 9 resolved trades over the
 * 2026-05 audit window produced 11% win rate and -$38 PnL, with losses
 * spanning the 20-62¢ entry range. Restricting tail entry to deep-cheap
 * contracts caps per-trade downside and forces the model to be correct on
 * "rare event" tails rather than coin-flip mid-priced ones.
 *
 * Returns allowed=true for non-tail markets unconditionally — this gate only
 * applies to upper_tail / lower_tail markets.
 */
export function evaluateTailGate(input: TailGateInput): TailGateResult {
  const { market, side, marketPrice, tailMaxEntryPrice } = input;

  const isTail =
    market.marketType === "upper_tail" || market.marketType === "lower_tail";
  if (!isTail) return { allowed: true };

  if (tailMaxEntryPrice <= 0) return { allowed: true };

  // Contract price the bot pays: YES side pays marketPrice; NO side pays (1 - marketPrice).
  const entryPrice = side === "yes" ? marketPrice : 1 - marketPrice;

  if (entryPrice > tailMaxEntryPrice) {
    return {
      allowed: false,
      reason: `tail entry ${(entryPrice * 100).toFixed(0)}¢ > max ${(tailMaxEntryPrice * 100).toFixed(0)}¢`,
    };
  }

  return { allowed: true };
}

export interface EntryGateInput {
  side: "yes" | "no";
  /** Estimator's final P(YES) in [0, 1] */
  estimatedProb: number;
  /** Market-implied P(YES) in [0, 1] */
  marketPrice: number;
  /** Station code (e.g. "KNYC"), or null when unknown. */
  stationId: string | null;
  config: {
    /** Max |estimatedProb − marketPrice| on a contrarian entry. 0 = disabled. */
    disagreementCap: number;
    /** Block buy_no when marketPrice ≥ this. 0 = disabled. */
    noSideMaxMarketPrice: number;
    /** Block buy_yes when marketPrice ≤ this. 0 = disabled. */
    yesSideMinMarketPrice: number;
    /** Coin-flip dead zone lower bound. Gate disabled when either bound is 0. */
    coinFlipZoneLow: number;
    /** Coin-flip dead zone upper bound. Gate disabled when either bound is 0. */
    coinFlipZoneHigh: number;
    /** Stations blocked from new entries. */
    disabledStations: string[];
  };
}

export interface EntryGateResult {
  allowed: boolean;
  /** Skip-reason string, populated when allowed=false. Queried from signals.skip_reason — keep prefixes stable. */
  reason?: string;
}

/**
 * Win-rate-80 entry gates: a layered set of hard "don't bet" rules that strip
 * the bot's anti-edge contra-market posture. The thesis (see
 * `docs/improvements/win-rate-80-plan-2026-06-05.md` and its addendum) is that
 * **the market is well-calibrated end-to-end and the model is not** — so the
 * model's loudest "edge" signals are precisely the ones the market disagrees
 * with, and the market is right ~80% of the time in that disagreement.
 *
 * Each gate is justified by the 200-trade paper book (2026-04-26 → 2026-06-05),
 * with all money in cents:
 *
 * - **Side-vs-market (disaster zone):** 109 of 200 trades were buy_no against a
 *   market already pricing YES at 65–85¢. They won 19.4% and lost ~$85. Mirror
 *   applies to buy_yes into a ≤35¢ (market-says-NO) market. → reasons prefixed
 *   `contra-market:`. (Plan item #1, "Side-vs-market hard gate".)
 *
 * - **Concordance:** trades with |estimatedProb − marketPrice| > 25pp ran ~47%
 *   win. Large model/market disagreement is evidence the *model* is wrong, not
 *   the market. → reason prefixed `disagreement`. (Plan item #1, "Concordance
 *   gate".)
 *
 * - **Coin-flip dead zone:** 78 trades entered with the market at 45–55¢ won
 *   48.7% (−$13.77) — a pure coin flip minus the spread. Without an information
 *   edge these are unwinnable. → reason prefixed `coin-flip zone:`. (Addendum
 *   item N7. This implementation is unconditional; the obs-anchor carve-out
 *   described in N7 lands with the N3 running-max work.)
 *
 * - **Station health:** KORD/KLAX/KNYC bled (−$70/−$25/−$69) on ~1°F phantom
 *   bias; disabling them caps blast radius while data keeps accruing for
 *   re-enable. → reason prefixed `station health gate:`. (Plan item #7.)
 *
 * Check order is fail-fast and deliberate: the cheapest/highest-confidence
 * "never do this" rules run first so their skip_reason wins attribution.
 *   1. station health → 2. side-vs-market → 3. concordance → 4. coin-flip zone.
 *
 * Each sub-gate is independently disabled by a 0 (or empty-array) config value,
 * so the bundle can be rolled out / rolled back per-rule via runtime config.
 */
export function evaluateEntryGates(input: EntryGateInput): EntryGateResult {
  const { side, estimatedProb, marketPrice, stationId, config } = input;
  const {
    disagreementCap,
    noSideMaxMarketPrice,
    yesSideMinMarketPrice,
    coinFlipZoneLow,
    coinFlipZoneHigh,
    disabledStations,
  } = config;

  // 1. Station health gate — losing stations are blocked from new entries.
  if (stationId != null && disabledStations.includes(stationId)) {
    return {
      allowed: false,
      reason: `station health gate: ${stationId} disabled`,
    };
  }

  // 2. Side-vs-market (disaster zone) — never fade a market that already prices
  // the opposite side with conviction. buy_no into a ≥65¢ market won 19.4%.
  if (
    side === "no" &&
    noSideMaxMarketPrice > 0 &&
    marketPrice >= noSideMaxMarketPrice
  ) {
    return {
      allowed: false,
      reason: `contra-market: buy_no blocked (market ${(marketPrice * 100).toFixed(0)}¢ ≥ ${(noSideMaxMarketPrice * 100).toFixed(0)}¢ says YES)`,
    };
  }
  if (
    side === "yes" &&
    yesSideMinMarketPrice > 0 &&
    marketPrice <= yesSideMinMarketPrice
  ) {
    return {
      allowed: false,
      reason: `contra-market: buy_yes blocked (market ${(marketPrice * 100).toFixed(0)}¢ ≤ ${(yesSideMinMarketPrice * 100).toFixed(0)}¢ says NO)`,
    };
  }

  // 3. Concordance — large model/market disagreement means the model is wrong.
  const disagreement = Math.abs(estimatedProb - marketPrice);
  if (disagreementCap > 0 && disagreement > disagreementCap) {
    return {
      allowed: false,
      reason: `disagreement ${(disagreement * 100).toFixed(1)}¢ > cap ${(disagreementCap * 100).toFixed(0)}¢ (market better calibrated)`,
    };
  }

  // 4. Coin-flip dead zone — mid-priced markets are unwinnable without an edge.
  if (
    coinFlipZoneLow > 0 &&
    coinFlipZoneHigh > 0 &&
    marketPrice >= coinFlipZoneLow &&
    marketPrice <= coinFlipZoneHigh
  ) {
    return {
      allowed: false,
      reason: `coin-flip zone: market ${(marketPrice * 100).toFixed(0)}¢ in [${coinFlipZoneLow * 100}, ${coinFlipZoneHigh * 100}]¢`,
    };
  }

  return { allowed: true };
}
