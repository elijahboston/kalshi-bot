# Adaptive-threshold persistence (2026-05-29)

## Why

The [2026-05-26 audit](./execution-unblock-2026-05-26.md) flagged `adaptive_thresholds` as "empty since launch." After investigating: the **table** is empty but the **logic** has been running all along.

- `getEffectiveThreshold()` ([`app/signals/services/adaptive-threshold.ts`](../../app/signals/services/adaptive-threshold.ts)) computes a per-(series, bucket) threshold on-the-fly from the `calibration` table for every signal evaluation. When a bucket is miscalibrated beyond `maxCalibrationError`, the threshold is bumped by `(1 + calibrationError)`; when well-calibrated, it's tightened to `× 0.9`.
- The `adaptive_thresholds` *table* is only written by the manual CLI `retrain` command. Nothing in the runtime loop persists.

So the gate has been adapting per-tick; we just couldn't see what bar each signal had to clear. The runtime decision was correct; observability was missing.

## Change — periodic writer in reconciliation

[`app/signals/services/adaptive-threshold.ts`](../../app/signals/services/adaptive-threshold.ts) — two new exports:

```ts
export function computeBucketThreshold(
  inBucketActuals: number[],
  bucketMid: number,
  baseThreshold: number,
  maxCalibrationError: number,
): { threshold: number; calibrationError: number; sampleSize: number } | null;

export async function persistAdaptiveThresholds(): Promise<number>;
```

- `computeBucketThreshold` is a pure function — same math as the gated block in `getEffectiveThreshold`, factored out so the persister doesn't duplicate logic.
- `persistAdaptiveThresholds` reads the calibration window once, groups by `seriesTicker` (plus a `__global__` aggregate), computes one threshold per (series, bucket), and upserts into `adaptive_thresholds`. Returns the count for logging.

[`app/engine/services/reconciliation.ts`](../../app/engine/services/reconciliation.ts) — called once per tick at the tail of `reconcile()`, right before `snapshotBalance()`. Cheap: one SELECT + ≤ N × 6 upserts per cycle (N = number of distinct series, currently 6).

## What this does NOT change

- The runtime decision is still driven by `getEffectiveThreshold`'s on-the-fly computation. Persistence is observability only — the orchestrator does not read from `adaptive_thresholds`.
- No changes to gate thresholds, calibration window, or sample-size minimums. The same `recordcount ≥ 5` per-bucket floor applies in both the runtime path and the persistence path.

The reason for keeping the runtime path independent: `getEffectiveThreshold` runs synchronously per signal and depends on freshest calibration. Reading from a periodically-updated table would add staleness without saving meaningful CPU.

## Tests

[`app/signals/services/adaptive-threshold.test.ts`](../../app/signals/services/adaptive-threshold.test.ts) — 7 new tests:

`computeBucketThreshold`:
- Returns null below sample-size floor (n=4)
- Well-calibrated bucket (error=0) → threshold × 0.9
- Miscalibrated bucket (error=0.15) → threshold × 1.15

`persistAdaptiveThresholds`:
- Returns 0 on empty calibration table
- Returns 0 when no series clears the 5-record floor
- Writes one row per (series, bucket) with sufficient data; also writes `__global__` rows
- Idempotent: second call upserts, doesn't duplicate

## Verification (target: next reconciliation tick after deploy)

- `SELECT COUNT(*), MIN(updated_at), MAX(updated_at) FROM adaptive_thresholds` — should show non-zero count, recent timestamps.
- `SELECT * FROM adaptive_thresholds WHERE series_ticker = '__global__' ORDER BY bucket_label` — should show the global aggregate per bucket.
- `SELECT series_ticker, bucket_label, ROUND(edge_threshold, 3), ROUND(calibration_error, 3), sample_size FROM adaptive_thresholds ORDER BY series_ticker, bucket_label` — useful for spotting which (series, bucket) combos are deviating from the base threshold.

## Followups (not in this change)

- Surface the table in the web UI / TUI calibration view so we can eyeball per-bucket drift over time.
- Consider deriving the per-station surcharge from observed per-station calibration error, replacing the hand-tuned [station_edge_surcharge](./per-station-surcharge-2026-05-29.md) values once enough per-station data accumulates.
