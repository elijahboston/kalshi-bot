import Elysia from "elysia";
import { getConfig } from "@kcb/config";
import { loop } from "@kcb/engine";

export const statusRoutes = new Elysia({ prefix: "/api" })
  .get("/status", () => {
    const state = loop.getLoopState();
    const config = getConfig();
    return {
      running: state.running,
      dryRun: config.bot.dryRun,
      tickCount: state.tickCount,
      lastTickAt: state.lastTickAt,
      uptime: state.startedAt ? Date.now() - state.startedAt : 0,
    };
  })
  .get("/config", () => {
    const config = getConfig();
    // Expose non-sensitive config only
    return {
      bot: {
        dryRun: config.bot.dryRun,
        tickIntervalSec: config.bot.tickIntervalSec,
        edgeThreshold: config.bot.edgeThreshold,
        minConfidence: config.bot.minConfidence,
        maxKellyFraction: config.bot.maxKellyFraction,
        maxOpenPositions: config.bot.maxOpenPositions,
        maxContractsPerOrder: config.bot.maxContractsPerOrder,
        enabledSeries: config.bot.enabledSeries,
        enabledStations: config.bot.enabledStations,
        exitEdgeThreshold: config.bot.exitEdgeThreshold,
        stopLossPct: config.bot.stopLossPct,
        stopLossMinEdge: config.bot.stopLossMinEdge,
        exitTimeDaysBeforeClose: config.bot.exitTimeDaysBeforeClose,
        exitTimeMinEdge: config.bot.exitTimeMinEdge,
        minContractPrice: config.bot.minContractPrice,
        exitCooldownTicks: config.bot.exitCooldownTicks,
        maxExposurePerTicker: config.bot.maxExposurePerTicker,
        minBalanceFloor: config.bot.minBalanceFloor,
        seedCapital: config.bot.seedCapital,
        profitReservePct: config.bot.profitReservePct,
        sniperHorizonHours: config.bot.sniperHorizonHours,
      },
      calibration: config.calibration,
      log: config.log,
    };
  });
