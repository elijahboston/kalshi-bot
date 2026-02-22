import { getDb, signals, markets, orders, desc, eq } from "@kcb/db";
import type { CommandDef } from "./index";
import type { ReasoningTrace } from "@kcb/signals";

export const explainCommands: CommandDef[] = [
  {
    name: "explain",
    aliases: ["why"],
    description: "Explain the bot's reasoning for a market",
    usage: "explain <ticker>",
    handler: async (args) => {
      const ticker = args[0];
      if (!ticker) {
        return "Usage: explain <ticker>\nExample: explain KXHIGHNY-26FEB21-B38";
      }

      return await explainTicker(ticker.toUpperCase());
    },
  },
];

async function explainTicker(ticker: string): Promise<string> {
  const db = getDb();

  // Find most recent signal for this ticker
  const [signal] = await db
    .select()
    .from(signals)
    .where(eq(signals.ticker, ticker))
    .orderBy(desc(signals.createdAt))
    .limit(1);

  if (!signal) {
    return `No signals found for ${ticker}. The bot may not have evaluated this market yet.`;
  }

  // Get market details
  const [market] = await db
    .select()
    .from(markets)
    .where(eq(markets.ticker, ticker))
    .limit(1);

  // Get order if acted
  let order = null;
  if (signal.orderId) {
    const [o] = await db
      .select()
      .from(orders)
      .where(eq(orders.orderId, signal.orderId))
      .limit(1);
    order = o ?? null;
  }

  // Parse reasoning trace
  let reasoning: ReasoningTrace | null = null;
  if (signal.reasoning) {
    try {
      reasoning = JSON.parse(signal.reasoning) as ReasoningTrace;
    } catch {
      // Malformed — skip
    }
  }

  const lines: string[] = [];

  // Header
  lines.push(`=== Explanation: ${ticker} ===`);
  lines.push("");

  // Market details
  if (market) {
    lines.push("MARKET");
    lines.push(`  Title:       ${market.title}`);
    lines.push(`  Category:    ${market.category}`);
    lines.push(`  Station:     ${market.stationId || "unknown"}`);
    lines.push(`  Target date: ${market.targetDate || "unknown"}`);
    lines.push(
      `  Bracket:     ${market.bracketLow != null ? `${market.bracketLow} to ${market.bracketHigh}` : "unknown"}`
    );
    lines.push(`  Status:      ${market.status}`);
    lines.push(
      `  Last price:  ${market.lastYesPrice != null ? `${market.lastYesPrice}c YES` : "unknown"}`
    );
    lines.push("");
  }

  // Estimate
  lines.push("ESTIMATE");
  lines.push(`  Probability: ${(signal.estimatedProb * 100).toFixed(1)}%`);
  lines.push(`  Confidence:  ${(signal.confidence * 100).toFixed(1)}%`);
  lines.push(`  Ensemble:    ${signal.ensembleSize ?? "?"} members`);
  lines.push("");

  // Edge analysis
  lines.push("EDGE ANALYSIS");
  lines.push(`  Market price:     ${(signal.marketPrice * 100).toFixed(1)}%`);
  lines.push(
    `  Edge:             ${signal.edge >= 0 ? "+" : ""}${(signal.edge * 100).toFixed(1)}c`
  );
  lines.push(
    `  Edge threshold:   ${(signal.edgeThreshold * 100).toFixed(1)}c`
  );
  lines.push(`  Recommendation:   ${signal.recommendation}`);
  lines.push(
    `  Kelly fraction:   ${signal.kellyFraction != null ? signal.kellyFraction.toFixed(4) : "N/A"}`
  );
  lines.push("");

  // Ensemble / Bias details from reasoning
  if (reasoning) {
    lines.push("ENSEMBLE BREAKDOWN");
    lines.push(
      `  Forecast horizon:    ${reasoning.forecastHorizon} day(s)`
    );
    lines.push(
      `  Raw ensemble mean:   ${reasoning.rawEnsembleStats.mean.toFixed(1)}`
    );
    lines.push(
      `  Raw ensemble std:    ${reasoning.rawEnsembleStats.std.toFixed(2)}`
    );
    lines.push(
      `  Ensemble members:    ${reasoning.rawEnsembleStats.count}`
    );

    if (reasoning.biasCorrection) {
      lines.push("");
      lines.push("  BIAS CORRECTION");
      lines.push(
        `    Mean bias:   ${reasoning.biasCorrection.meanBias >= 0 ? "+" : ""}${reasoning.biasCorrection.meanBias.toFixed(2)} deg F`
      );
      lines.push(
        `    Sample size: ${reasoning.biasCorrection.sampleSize}`
      );
      lines.push(
        `    Corrected mean: ${reasoning.correctedEnsembleStats.mean.toFixed(1)}`
      );
      lines.push(
        `    Corrected std:  ${reasoning.correctedEnsembleStats.std.toFixed(2)}`
      );
    } else {
      lines.push("  No bias correction applied (insufficient data)");
    }

    lines.push("");
    lines.push(
      `  Members in bracket: ${reasoning.membersInBracket} / ${reasoning.rawEnsembleStats.count}`
    );
    if (reasoning.cdfProbability != null) {
      lines.push(
        `  CDF probability:    ${(reasoning.cdfProbability * 100).toFixed(1)}%`
      );
    }
    if (reasoning.countingProbability != null) {
      lines.push(
        `  Counting prob:      ${(reasoning.countingProbability * 100).toFixed(1)}%`
      );
    }
    if (reasoning.historicalHitRate != null) {
      lines.push(
        `  Historical hit rate: ${(reasoning.historicalHitRate * 100).toFixed(1)}%`
      );
    }
    lines.push("");
  }

  // Order details
  if (signal.acted && order) {
    lines.push("ORDER PLACED");
    lines.push(`  Order ID:   ${order.orderId}`);
    lines.push(`  Side:       ${order.side.toUpperCase()}`);
    lines.push(`  Price:      ${order.limitPrice}c`);
    lines.push(`  Quantity:   ${order.quantity} contracts`);
    lines.push(`  Filled:     ${order.filledQuantity}`);
    lines.push(`  Status:     ${order.status}`);
    lines.push(`  Dry run:    ${order.dryRun ? "yes" : "no"}`);
    lines.push("");
  } else if (signal.skipReason) {
    lines.push("NOT TRADED");
    lines.push(`  Reason: ${signal.skipReason}`);
    lines.push("");
  }

  lines.push(`Signal generated at: ${signal.createdAt}`);

  return lines.join("\n");
}
