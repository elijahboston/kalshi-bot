import { bus } from "@kcb/engine";
import { getSnapshot, getPerformance } from "./api";
import type { SnapshotData, PerformanceData } from "./frontend/lib/types";

const DEBOUNCE_MS = 500;

let snapshotData: SnapshotData | null = null;
let perfData: PerformanceData | null = null;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let perfTimer: ReturnType<typeof setTimeout> | null = null;

function refreshSnapshot(): void {
  snapshotData = getSnapshot();
}

function refreshPerf(): void {
  perfData = getPerformance();
}

function scheduleSnapshotRefresh(): void {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    refreshSnapshot();
  }, DEBOUNCE_MS);
}

function schedulePerfRefresh(): void {
  if (perfTimer) clearTimeout(perfTimer);
  perfTimer = setTimeout(() => {
    perfTimer = null;
    refreshPerf();
  }, DEBOUNCE_MS);
}

export function initCache(): void {
  refreshSnapshot();
  refreshPerf();

  for (const event of ["order:placed", "order:update", "position:update", "balance:update"] as const) {
    bus.on(event, scheduleSnapshotRefresh);
  }

  for (const event of ["market:resolved", "balance:update", "order:placed"] as const) {
    bus.on(event, schedulePerfRefresh);
  }
}

export function getCachedSnapshot(): SnapshotData {
  if (!snapshotData) refreshSnapshot();
  return snapshotData!;
}

export function getCachedPerformance(): PerformanceData {
  if (!perfData) refreshPerf();
  return perfData!;
}
