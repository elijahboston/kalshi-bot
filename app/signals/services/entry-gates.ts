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
