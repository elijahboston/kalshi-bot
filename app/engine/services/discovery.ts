import { KalshiClient, type KalshiMarket } from "@kcb/kalshi-client";
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

  // Parse bracket: B37, B51.5, T57, etc.
  const bracketMatch = bracketStr.match(/^[BT]([\d.]+)$/);
  const bracketLow = bracketMatch ? Number(bracketMatch[1]) : null;

  const stationId = extractStationFromSeries(seriesTicker);
  const category = seriesCategory(seriesTicker);

  return {
    seriesTicker,
    eventTicker: `${seriesTicker}-${dateStr}`,
    targetDate,
    bracketLow,
    stationId,
    category,
  };
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

      if (existing.length > 0) {
        // Update prices and status
        await db
          .update(markets)
          .set({
            lastYesPrice: km.last_price,
            lastNoPrice: km.last_price != null ? 100 - km.last_price : null,
            status: km.status,
            result: km.result ?? undefined,
            updatedAt: timestamp,
          })
          .where(eq(markets.ticker, km.ticker));
      } else {
        // Insert new market
        await db.insert(markets).values({
          ticker: km.ticker,
          eventTicker: parsed.eventTicker,
          seriesTicker: parsed.seriesTicker,
          title: km.title,
          category: parsed.category,
          stationId: parsed.stationId,
          targetDate: parsed.targetDate,
          bracketLow: parsed.bracketLow,
          bracketHigh: parsed.bracketLow != null ? parsed.bracketLow + 1 : null,
          status: km.status,
          closeTime: km.close_time,
          lastYesPrice: km.last_price,
          lastNoPrice: km.last_price != null ? 100 - km.last_price : null,
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
