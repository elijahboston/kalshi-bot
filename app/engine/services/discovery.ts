import { KalshiClient, type KalshiMarket, parseMarketPrices } from "@kcb/kalshi-client";
import { getDb, markets, eq } from "@kcb/db";
import { getConfig } from "@kcb/config";
import { bus, createLogger } from "../events";
import {
  CLIMATE_SERIES_PREFIXES,
  buildSeriesTickers,
  seriesCategory,
  extractStationFromSeries,
  now,
} from "@kcb/shared";

const log = createLogger("discovery");

/** Parse a Kalshi climate ticker into its components */
export function parseTicker(ticker: string) {
  // e.g. KXHIGHNY-25FEB19-B37
  const parts = ticker.split("-");
  if (parts.length < 3) return null;

  const seriesTicker = parts[0]!;
  const dateStr = parts[1]!;
  const bracketStr = parts[2]!;

  // Parse date: 25FEB19 → 2025-02-19
  const dateMatch = dateStr.match(/^(\d{2})([A-Z]{3})(\d{2})$/);
  if (!dateMatch) return null;

  const monthMap: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04",
    MAY: "05", JUN: "06", JUL: "07", AUG: "08",
    SEP: "09", OCT: "10", NOV: "11", DEC: "12",
  };
  const year = `20${dateMatch[1]}`;
  const month = monthMap[dateMatch[2]!];
  const day = dateMatch[3]!;
  if (!month) return null;

  const targetDate = `${year}-${month}-${day}`;

  // Parse bracket: B37, B51.5 (bracket) or T57 (threshold/tail)
  const bracketMatch = bracketStr.match(/^([BT])([\d.]+)$/);
  const bracketLow = bracketMatch ? Number(bracketMatch[2]) : null;
  const isThreshold = bracketMatch?.[1] === "T";

  const stationId = extractStationFromSeries(seriesTicker);
  const category = seriesCategory(seriesTicker);

  return {
    seriesTicker,
    eventTicker: `${seriesTicker}-${dateStr}`,
    targetDate,
    bracketLow,
    isThreshold,
    stationId,
    category,
  };
}

export interface ParsedBracket {
  marketType: "bracket" | "upper_tail" | "lower_tail";
  bracketLow: number | null;
  bracketHigh: number | null;
}

/**
 * Derive the TRUE settlement interval from a temperature market's title.
 *
 * Kalshi settles temperature markets on the rounded integer high/low, so a
 * "87-88°" bracket pays YES for any official value in [86.5, 88.5) — 2°F of
 * coverage, midpoint = the ticker's B-number (B87.5). The original parser
 * stored [B, B+1) = [87.5, 88.5), silently dropping the entire "87" half of
 * every bracket: CDF integrals ran over half the true interval (structurally
 * understating YES — a primary driver of the contra-market NO book), event
 * coverage summed to ~0.79, and tail thresholds were off by 0.5°F. Found
 * 2026-06-05 by the N2 event-coherence telemetry (finalSum ≈ 0.79 over a
 * complete partition). See win-rate-80-addendum-2026-06-05.md (Finding 11).
 *
 * Title forms (all 1,512 settled rows audited):
 *   "be 87-88°" → bracket  [86.5, 88.5)
 *   "be <87°"   → lower_tail, YES when X < 86.5  (rounded ≤ 86)
 *   "be >94°"   → upper_tail, YES when X > 94.5  (rounded ≥ 95)
 *   "be 78°"    → bracket  [77.5, 78.5)  (single-value, defensive)
 *
 * Returns null for non-temperature categories (precip/snow keep the legacy
 * ticker-based parse until their settlement rules are audited) and for
 * unrecognized titles (caller falls back to the legacy parse).
 */
export function parseBracketFromTitle(title: string, category: string): ParsedBracket | null {
  if (category !== "high_temp" && category !== "low_temp") return null;

  // Order matters: range before single (the single-value regex would match the
  // first number of a range); tails carry an explicit </> marker.
  const range = title.match(/be (-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)°/);
  if (range) {
    return {
      marketType: "bracket",
      bracketLow: Number(range[1]) - 0.5,
      bracketHigh: Number(range[2]) + 0.5,
    };
  }

  const lower = title.match(/be <(-?\d+(?:\.\d+)?)°/);
  if (lower) {
    return { marketType: "lower_tail", bracketLow: Number(lower[1]) - 0.5, bracketHigh: null };
  }

  const upper = title.match(/be >(-?\d+(?:\.\d+)?)°/);
  if (upper) {
    return { marketType: "upper_tail", bracketLow: Number(upper[1]) + 0.5, bracketHigh: null };
  }

  const single = title.match(/be (-?\d+(?:\.\d+)?)°/);
  if (single) {
    return {
      marketType: "bracket",
      bracketLow: Number(single[1]) - 0.5,
      bracketHigh: Number(single[1]) + 0.5,
    };
  }

  return null;
}

/** Check if a market's target date is within the next N days */
function isWithinDays(targetDate: string, days: number): boolean {
  const target = new Date(targetDate);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  return target >= new Date(Date.now() - 3 * 86400_000) && target <= cutoff;
}

/**
 * Discover climate markets from Kalshi and upsert into the DB.
 * Returns the number of new markets discovered.
 */
export async function discoverMarkets(client: KalshiClient): Promise<number> {
  const config = getConfig();
  const db = getDb();
  let newCount = 0;

  // Build full series tickers: prefix × station (e.g. KXHIGHNY, KXLOWLAX)
  const seriesTickers = config.bot.enabledSeries.length > 0
    ? config.bot.enabledSeries
    : buildSeriesTickers(CLIMATE_SERIES_PREFIXES, config.bot.enabledStations);

  for (const seriesTicker of seriesTickers) {
    let allMarkets: KalshiMarket[];
    try {
      log.info(`Fetching markets for series ${seriesTicker}...`);
      allMarkets = await client.getAllMarkets({
        series_ticker: seriesTicker,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to fetch markets for ${seriesTicker}: ${msg}`);
      continue;
    }

    if (allMarkets.length > 0) {
      // Log status breakdown to diagnose filtering
      const statusCounts: Record<string, number> = {};
      for (const m of allMarkets) {
        statusCounts[m.status] = (statusCounts[m.status] || 0) + 1;
      }
      const breakdown = Object.entries(statusCounts)
        .map(([s, n]) => `${n} ${s}`)
        .join(", ");
      log.info(`Fetched ${allMarkets.length} markets for ${seriesTicker} (${breakdown})`);
    } else {
      log.debug(`Fetched 0 markets for ${seriesTicker}`);
    }

    // Keep open + recently closed/settled (for calibration & display)
    for (const km of allMarkets) {
      const parsed = parseTicker(km.ticker);
      if (!parsed) {
        log.debug(`Skipping unparseable ticker: ${km.ticker}`);
        continue;
      }

      // Filter: station must be enabled (skip if station unknown — keep it)
      if (parsed.stationId && !config.bot.enabledStations.includes(parsed.stationId)) {
        continue;
      }

      // Filter: target date within 7 days
      if (parsed.targetDate && !isWithinDays(parsed.targetDate, 7)) {
        continue;
      }

      const timestamp = now();

      // Check if market already exists
      const existing = await db
        .select({ ticker: markets.ticker })
        .from(markets)
        .where(eq(markets.ticker, km.ticker))
        .limit(1);

      // Parse prices from Kalshi API (handles both legacy and v3 dollar-string fields)
      const prices = parseMarketPrices(km);
      const yesPrice = prices.lastPrice
        ?? (prices.yesBid != null && prices.yesAsk != null
          ? Math.round((prices.yesBid + prices.yesAsk) / 2)
          : prices.yesBid ?? prices.yesAsk);
      const noPrice = yesPrice != null ? 100 - yesPrice : null;

      if (existing.length > 0) {
        // Update prices and status
        await db
          .update(markets)
          .set({
            lastYesPrice: yesPrice,
            lastNoPrice: noPrice,
            status: km.status,
            result: km.result ?? undefined,
            updatedAt: timestamp,
          })
          .where(eq(markets.ticker, km.ticker));
      } else {
        // Determine market type and bracket bounds. Temperature markets parse
        // the TRUE settlement interval from the title (rounded-integer
        // semantics — see parseBracketFromTitle); the legacy ticker-based
        // parse remains as the fallback for non-temp categories and
        // unrecognized titles.
        let marketType: "bracket" | "upper_tail" | "lower_tail" = "bracket";
        let bracketLow = parsed.bracketLow;
        let bracketHigh = parsed.bracketLow != null ? parsed.bracketLow + 1 : null;

        const titleBracket = parseBracketFromTitle(km.title, parsed.category);
        if (titleBracket) {
          marketType = titleBracket.marketType;
          bracketLow = titleBracket.bracketLow;
          bracketHigh = titleBracket.bracketHigh;
        } else if (parsed.isThreshold) {
          // Legacy tail handling — parse direction from title
          // ">X°" = upper_tail (YES = temp > X), "<X°" = lower_tail (YES = temp < X)
          if (km.title.includes(">")) {
            marketType = "upper_tail";
            bracketHigh = null; // No upper bound for upper tail
          } else if (km.title.includes("<")) {
            marketType = "lower_tail";
            bracketHigh = null; // bracketLow is the threshold, no meaningful bracketHigh
          }
        }

        // Insert new market
        await db.insert(markets).values({
          ticker: km.ticker,
          eventTicker: parsed.eventTicker,
          seriesTicker: parsed.seriesTicker,
          title: km.title,
          category: parsed.category,
          stationId: parsed.stationId,
          targetDate: parsed.targetDate,
          bracketLow,
          bracketHigh,
          marketType,
          status: km.status,
          closeTime: km.close_time,
          lastYesPrice: yesPrice,
          lastNoPrice: noPrice,
          discoveredAt: timestamp,
          updatedAt: timestamp,
        });

        newCount++;
        bus.emit("market:discovered", {
          ticker: km.ticker,
          eventTicker: parsed.eventTicker,
          title: km.title,
          category: parsed.category,
        });
      }
    }
  }

  if (newCount > 0) {
    log.info(`Discovered ${newCount} new market(s)`);
  } else {
    log.debug("No new markets discovered");
  }

  return newCount;
}
