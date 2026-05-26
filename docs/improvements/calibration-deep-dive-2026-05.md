# Calibration deep-dive (2026-05-26): two compounding bugs explain the post-restart NO bleed

## Why this investigation happened

After the May 9 σ-blend shipped, two weeks of post-restart paper data showed the
bot was net positive (+$1.44 / 73 trades) but with a strange confidence
signature:

| Confidence | n | YES-correct % | PnL ($) |
|---|---|---|---|
| ≥ 0.95 | 21 | 38% | **+58.60** |
| 0.90–0.95 | 43 | 30% | **−62.10** |
| 0.85–0.90 | 12 | 33% | −0.30 |

The 0.95+ band wins. The 0.90–0.95 band loses. Higher-confidence ≠ better,
which is the opposite of what the [confidence-tier sizing
fix](./confidence-tier-sizing.md) is supposed to exploit. We were about to ship
confidence-weighted Kelly when the user pushed to first understand the loss
pattern.

## What we found

Every single one of those 73 trades was on a **tight ≤1°F bracket**, and 72 of
73 were **buy_no**. The bot has effectively one strategy: bet NO on narrow
brackets. Two bugs in the estimator make that one strategy systematically
mispriced.

### Bug 1: `getHistoricalHitRate` ignored its bracket arguments

[`estimator.ts:333`](../../app/signals/services/estimator.ts#L333) (pre-fix)
accepted `bracketLow` and `bracketHigh` as parameters but never used them in
the query — it filtered only by `stationId` and `category`. So for any signal
on any bracket, it returned the YES rate across *every bracket at that
station*, dominated by the long tail of far-from-mean brackets that almost
never hit YES (~17% station-wide average).

With `historical_prior_weight = 0.3`, the estimator was then blending every
final probability *toward 17% YES*, regardless of where the bracket actually
sat relative to the climatological mean. The historical prior — added to
*correct* NO overconfidence — was instead *reinforcing* it for the very
brackets where it mattered most.

### Bug 2: counting/CDF blend weighted the wrong direction

[`estimator.ts:212`](../../app/signals/services/estimator.ts#L212) (pre-fix)
used `countingWeight = min(1, ensembleSize / 200)`. With our typical 150-member
multi-ensemble that's **75% counting + 25% CDF**.

For a tight 1°F bracket sitting near the climatological mean, counting is
extremely noisy: only a handful of ensemble members happen to land in any
given 1° slice by chance. The smooth normal CDF integrated over the bracket is
a much better estimate — but the blend crushed it.

Spot-check from a typical loser (KXHIGHMIA-26MAY08-B92.5, settled YES):

```
correctedEnsembleStats.mean: 92.81 (INSIDE bracket 92.5–93.5)
sigmaUsed:                   1.02
cdfProbability:              0.370  ← mathematically correct given the model
countingProbability:         0.06   ← only 9/150 members landed in 1° slice
rawProbability:              0.137  ← blended 75% toward the noisy estimate
historicalHitRate:           0.204  ← bug 1: pulled toward wrong baseline
final predicted P(YES):      0.157
actual outcome:              YES
```

The bot computed the right answer (CDF = 37%) and then threw it away.

### Aggregate evidence

| Mean position | n | final pred | CDF | counting | hist | actual YES |
|---|---|---|---|---|---|---|
| INSIDE bracket | 17 | 14.8% | **26.9%** | 14.2% | 17.1% | **76.5%** |
| within 2°F | 36 | 13.6% | 18.1% | 16.3% | 18.1% | 72.2% |
| far away | 22 | 9.5% | 5.7% | 5.2% | 17.9% | 50.0% |

CDF was always closer to actual than counting. Historical hit rate was stuck
at ~17% no matter where the bracket sat. Both fixes pull the bot in the
correct direction.

## What shipped (2026-05-26)

### Fix 1: bracket-similarity filter in `getHistoricalHitRate`

[`app/signals/services/estimator.ts:333`](../../app/signals/services/estimator.ts#L333)

- Signature changed: `bracketHigh: number | null` (was `number`); call site
  drops the `?? market.bracketLow` fallback that masked the bug.
- Implementation joins `calibration` with `markets` and filters by bracket
  *center proximity* (`±BRACKET_HIST_TOLERANCE_F = 3°F`).
- Tail markets only match other tails (different threshold math); brackets
  only match brackets.
- Empirically this moves the baseline from ~17% (whole station) to ~25–30%
  (bracket-similar) for the trades we examined — still under actuals, but a
  real correction.

### Fix 2: invert CDF/counting blend

[`app/signals/services/estimator.ts:212`](../../app/signals/services/estimator.ts#L212)

```ts
const cdfWeight = isPrecipCategory ? 0 : Math.min(1, correctedValues.length / 200);
const rawProbability = cdfWeight * cdfProb + (1 - cdfWeight) * countingProb;
```

At 150 members: 75% CDF + 25% counting (was 75/25 the other way). Small
ensembles still lean counting where sigma estimates are unreliable. Precip
markets unchanged (still pure counting; precip distributions are zero-inflated
and not Gaussian).

### Tests

[`app/signals/services/estimator.test.ts`](../../app/signals/services/estimator.test.ts) —
all six prior `getHistoricalHitRate` tests updated to seed matching `markets`
rows (the new JOIN requires them). Four new tests cover:

1. Brackets outside the ±3°F window are excluded
2. Brackets *at* the ±3°F edge are included; beyond it are not
3. Tail queries only match other tails by threshold proximity
4. Bracket queries exclude tail-market rows

Full suite: 420 → 424 tests, all passing.

## What this does NOT fix

The aggregate "INSIDE bracket" actual YES rate is 77% — and even pure CDF only
estimates 27%. So the bot is still off by ~50pp even after both fixes. The
remaining gap is **sigma estimate is too tight after the May 9 empirical
blend**, especially when bias-correction sample sizes pin the empirical weight
at 1.0.

Likely next-fix candidates (defer until we have ≥1 week of post-fix data to
measure against):

1. **Clamp `empiricalSigmaWeight` lower than 1.0** (e.g., max 0.7) — keeps
   ensemble spread in the blend permanently as a "you might be wrong" guard.
2. **Raise `historical_prior_weight` from 0.3 → 0.5** now that the historical
   estimate is no longer poisoned by the cross-bracket pooling bug.
3. **Confidence formula overhaul** — currently confidence is essentially
   `1 - sigma/10`, since the other two factors are pinned at 1.0. That made
   the May 23 confidence-tier work less informative than it appeared.

## Why we're holding on the sizing change

[Confidence-tier sizing](./confidence-tier-sizing.md) shipped May 23. The
[confidence-weighted Kelly proposal](./conviction-sizing.md) was queued next.
Both decisions were keyed off "0.95+ wins, 0.90–0.95 loses" — but that
*itself* is contaminated by the bugs above. Once a clean post-fix window
exists (target: 2026-06-02 after ≥5 trading days), re-run the
confidence-bucket analysis and decide between:

- Keeping the tier as-is
- Replacing with confidence-weighted Kelly
- Doing neither (if confidence becomes monotonic and edge-based Kelly is
  enough)

## Verification

- `bun test` — full suite green (424 pass, 0 fail)
- Spot-check a fresh signal after deploy: `json_extract(reasoning, '$.historicalHitRate')` should now vary by bracket-center rather than being constant per-station
- Watch the `pred<10% TRADED` bucket — should drop from current ~30% trades to fewer, with a higher actual YES rate among the survivors (the blend now lifts more of them past the edge gate)
