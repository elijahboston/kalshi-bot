# Polymarket Integration — Scoping Assessment

*2026-06-10. Feasibility/effort assessment, not an implementation guide. Scope per request: estimate the effort and recommend a path; **paper-trade only** (simulate against Polymarket's public market data — no wallet, no real orders).*

## TL;DR

A **paper** Polymarket integration that exercises the **confirmation pathway** is a **~2–3 week, well-bounded** effort. Porting the **weather edge** is effectively a new bot (~70–80% rebuild) **and has almost no markets to trade on Polymarket** — not recommended. The binding constraint is **strategy fit, not API plumbing**.

The paper-only + scoping framing is what makes this tractable:
- **Paper-only removes the two hardest dimensions.** No on-chain wallet, EIP-712 order signing, USDC funding, or relayer (Polymarket's genuinely hard plumbing — it's on-chain on Polygon, not a REST API-key swap like Kalshi), and the U.S.-person regulatory question is moot when we never place a real order. We need only **read access to public market data** + a **simulated fill model the bot already has** (`dry_run` + `balance_history`).
- **So the real question a paper integration answers is narrow:** is there any Polymarket market the bot's models can price, and is Polymarket calibrated enough that the (portable) confirmation pathway profits — the way it does on Kalshi?

## Effort by dimension (paper-only)

| Dimension | Difficulty | Why |
|---|---|---|
| Read-only data adapter (REST + WS) | **Low–moderate** (~1 wk) | Public, unauthenticated. Mirrors `packages/kalshi-client` minus auth + order placement. |
| Schema / domain mapping | **Moderate** | Polymarket binaries ≠ Kalshi bracket partitions; the bracket / event-coherence model doesn't map cleanly. |
| Simulated execution | **Low** | Reuse the existing `dry_run` fill + `balance_history` path. |
| Portable strategy | **Moderate** | Only the **confirmation pathway** (market-following) transfers without a domain model. |
| Real-money trading | **High + regulatory-blocked** | Wallet / EIP-712 / USDC + U.S.-person access. **Out of scope** (paper-only). |

## What transfers vs. what doesn't

**Exchange-agnostic, reusable (~20%):**
- Ensemble bias correction & sigma blending — `app/signals/services/estimator.ts:211–268`
- Normal-CDF math — `estimator.ts:1031–1050`
- Kelly + confidence-scaled %-of-balance sizing — `app/execution/services/execution.ts`
- Calibration/Brier loop and the `dry_run` simulated-fill model — `app/engine/services/reconciliation.ts`
- The **confirmation pathway** (take the ≥conviction side when the market is calibrated) — `app/signals/services/entry-gates.ts` + the orchestrator confirmation block

**Kalshi/weather-specific, does NOT transfer (~80%):**
- Bracket geometry & ticker/series parsing — `app/engine/services/discovery.ts`
- Event-coherent sum-to-1 estimation across a bracket partition
- Settlement → CLI → obs truth chain — `reconciliation.ts:1190–1363`
- Historical hit-rate-by-bracket-center, observation anchoring / post-peak collapse
- HRRR sniper window, station-health gates

None of the weather-specific machinery has a Polymarket analogue: Polymarket markets are independent YES/NO binaries (crypto/politics/sports), resolved by the **UMA oracle**, not mutually-exclusive temperature brackets tiling a continuous variable that settle on the NWS CLI report.

## Recommended phased path (paper-only, decision-gated)

Cheapest informative experiment first; stop at any gate that fails.

**Phase 0 — Market survey (½ day, no code).** Query Polymarket's public Gamma API for active markets. Answer: (a) are there *any* recurring markets a model could price (weather/temperature, or anything with an external-data edge)? (b) liquidity/spread profile? **Gate:** if the confirmation (market-following) pathway is the only viable play, decide whether testing it alone justifies Phases 1–3.

**Phase 1 — Read-only data adapter (~1 wk).** New `packages/polymarket-client/src/{client,feed,types}.ts` mirroring the kalshi-client **read** surface only: markets/metadata (Gamma REST), order books/prices (CLOB REST), live-price WS. **No `auth.ts`, no `createOrder`.** Define an internal `ExchangeReadAdapter` interface; make `KalshiClient`'s read methods conform so consumers depend on the interface, not the concrete client. (Today `KalshiClient`/`KalshiFeed` are instantiated only in `app/engine/services/orchestrator.ts:117–118` and consumed in `execution.ts`, `reconciliation.ts`, `discovery.ts`, `feed.ts` — a small seam.)

**Phase 2 — Schema & discovery mapping (~3–4 days).** A `polymarket-discovery` that maps Polymarket binaries into the existing `markets` table: a binary is a single YES/NO market (price already 0–1 → cents), no bracket partition, so `marketType` is a plain binary and event-coherence is skipped. Add an `exchange` column to `markets`/`orders`/`positions` (default `'kalshi'`) to namespace the two venues.

**Phase 3 — Simulated execution + confirmation-only strategy (~3–4 days).** Route Polymarket signals through the existing `dry_run` path (simulated fills, `balance_history`). Run **only the confirmation pathway** (no weather estimator). Use the calibration the bot already records (Brier, win rate by entry price) to answer: is Polymarket priced efficiently enough that following ≥80¢ conviction profits?

**Phase 4 — Decision gate.** Review paper results via the `wins` command against a Polymarket regime boundary. Real edge → *then* discuss real-money (wallet + regulatory) as a separate decision. No edge → stop at paper, ~2–3 weeks spent learning it cheaply.

## Critical files

- **New:** `packages/polymarket-client/src/{client,feed,types}.ts` (read-only; pattern-mirror `packages/kalshi-client/src/{client,feed,types}.ts`, drop `auth.ts`).
- **New interface:** `ExchangeReadAdapter` (markets/books/prices/WS) implemented by both clients.
- **Modify:** `app/engine/services/discovery.ts` (Polymarket discovery branch); `packages/db/src/schema/*` (+`exchange` column + migration); orchestrator (select/loop adapter by exchange); config (`polymarket` block — read-only base URLs only).
- **Reuse as-is:** `dry_run` execution + `balance_history` (`app/execution/services/execution.ts`, `reconciliation.ts`), confirmation pathway, `wins` command.

## Regulatory note

Polymarket has historically blocked U.S. persons (post-2022 CFTC settlement). As of this writing the status was in flux (they acquired a CFTC-licensed venue, QCEX, signaling possible U.S. re-entry). **Paper-only sidesteps this entirely** — no orders, no wallet. Any real-money step is a separate decision that must first confirm current legality for a U.S. trader.

## Recommended next step

**Phase 0 — the market survey** (read-only `bun` script against the Gamma API). It answers whether anything downstream is worth building before a single line of adapter code is written. Relationship to existing research: the [`market-expansion-research.md`](market-expansion-research.md) conclusion (objective-settlement macro/econ markets fit the pipeline best) applies here too — on Polymarket the bot has *no weather edge*, so any value is in market-following efficiency plays, not the forecasting edge that makes the Kalshi climate bot work.
