import { useState, useEffect, useCallback, useRef } from "react";
import { bus, type BotEvents } from "@kcb/engine";

/**
 * Subscribe to a specific bot event and get the latest value.
 * Returns [latestValue, allValues] for flexibility.
 */
export function useBotEvent<K extends keyof BotEvents>(
  event: K,
  maxHistory = 1
): [BotEvents[K] | null, BotEvents[K][]] {
  const [latest, setLatest] = useState<BotEvents[K] | null>(null);
  const [history, setHistory] = useState<BotEvents[K][]>([]);

  useEffect(() => {
    const unsub = bus.on(event, (data) => {
      setLatest(data);
      if (maxHistory > 1) {
        setHistory((prev) => [...prev, data].slice(-maxHistory));
      }
    });
    return unsub;
  }, [event, maxHistory]);

  return [latest, history];
}

/**
 * Subscribe to multiple bot events at once.
 * Useful for dashboard views that need several data streams.
 */
export function useBotEvents<K extends keyof BotEvents>(
  events: K[]
): Record<K, BotEvents[K] | null> {
  const [state, setState] = useState<Record<K, BotEvents[K] | null>>(
    () => Object.fromEntries(events.map((e) => [e, null])) as Record<K, BotEvents[K] | null>
  );

  useEffect(() => {
    const unsubs = events.map((event) =>
      bus.on(event, (data) => {
        setState((prev) => ({ ...prev, [event]: data }));
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [events.join(",")]);

  return state;
}

/**
 * Accumulate log entries with filtering.
 */
export function useLogs(filter?: {
  level?: BotEvents["log"]["level"];
  module?: string;
  maxEntries?: number;
}) {
  const [logs, setLogs] = useState<BotEvents["log"][]>([]);
  const max = filter?.maxEntries ?? 100;

  useEffect(() => {
    const unsub = bus.on("log", (entry) => {
      if (filter?.level && entry.level !== filter.level) return;
      if (filter?.module && entry.module !== filter.module) return;
      setLogs((prev) => [...prev, entry].slice(-max));
    });
    return unsub;
  }, [filter?.level, filter?.module, max]);

  return logs;
}
