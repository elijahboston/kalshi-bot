import { getConfig } from "@kcb/config";
import { bus, createLogger } from "../events";

const log = createLogger("loop");

export interface LoopState {
  running: boolean;
  tickCount: number;
  startedAt: number;
  lastTickAt: string;
}

let state: LoopState = {
  running: false,
  tickCount: 0,
  startedAt: 0,
  lastTickAt: "",
};

let loopTimer: ReturnType<typeof setInterval> | null = null;

/** The function that runs each tick. Injected by the orchestrator. */
type TickFn = () => Promise<void>;
let tickFn: TickFn | null = null;
let ticking = false;

export function registerTick(fn: TickFn): void {
  tickFn = fn;
}

async function runTick(): Promise<void> {
  if (!state.running || !tickFn) return;
  if (ticking) {
    log.debug("Skipping tick — previous tick still running");
    return;
  }
  ticking = true;

  const tickStart = Bun.nanoseconds();
  state.tickCount++;
  state.lastTickAt = new Date().toISOString();

  try {
    await tickFn();

    bus.emit("bot:status", {
      running: state.running,
      dryRun: getConfig().bot.dryRun,
      lastTick: state.lastTickAt,
      tickCount: state.tickCount,
      uptime: Date.now() - state.startedAt,
    });
  } catch (err) {
    log.error("Tick failed", err);
    bus.emit("bot:error", {
      module: "loop",
      message: err instanceof Error ? err.message : String(err),
      error: err,
    });
  } finally {
    ticking = false;
  }

  const elapsedMs = (Bun.nanoseconds() - tickStart) / 1_000_000;
  log.debug(`Tick #${state.tickCount} completed in ${elapsedMs.toFixed(2)}ms`);
}

export function startLoop(): void {
  if (state.running) {
    log.warn("Loop already running");
    return;
  }

  const config = getConfig();
  state.running = true;
  state.startedAt = Date.now();

  log.info(`Starting bot loop (interval: ${config.bot.tickIntervalSec}s, dryRun: ${config.bot.dryRun})`);

  // Run first tick immediately
  runTick();

  // Then on interval
  loopTimer = setInterval(runTick, config.bot.tickIntervalSec * 1000);
}

export function stopLoop(): void {
  if (!state.running) {
    log.warn("Loop not running");
    return;
  }

  state.running = false;
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }

  log.info(`Loop stopped after ${state.tickCount} ticks`);

  bus.emit("bot:status", {
    running: false,
    dryRun: getConfig().bot.dryRun,
    lastTick: state.lastTickAt,
    tickCount: state.tickCount,
    uptime: Date.now() - state.startedAt,
  });
}

export function getLoopState(): LoopState {
  return { ...state };
}

/** @internal — reset module state for tests */
export function _resetForTesting(): void {
  stopLoop();
  ticking = false;
  tickFn = null;
  state = { running: false, tickCount: 0, startedAt: 0, lastTickAt: "" };
}
