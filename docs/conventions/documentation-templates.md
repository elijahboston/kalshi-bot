# Documentation Templates

**Type:** Conventions Reference
**Last updated:** 2026-06-10

This document defines the templates we use for technical documentation across the Moonbase repository. Each template has a specific purpose — pick the one that matches what we're trying to communicate, and stick to its shape so readers know where to look.

All docs are written in first-person plural ("we", "our") from the team's perspective. Keep prose tight: a reader skimming for one fact should find it without reading the surrounding paragraphs.

## Where Docs Live

```
docs/
  architecture/   # How systems are built and why (architecture.md, backend-deployment.md, ...)
  operations/     # How to run and operate systems (infra-ops.md, runbooks)
  features/       # Per-feature specs and design docs
  decisions/      # ADRs — architecture decision records
  lessons/        # Postmortems and lessons learned
  conventions/    # Coding standards, naming, patterns
```

Modules and packages may also keep a local `README.md` for things only relevant to that workspace.

## Choosing a Template

| If we're writing about... | Use |
|---------------------------|-----|
| A new feature we plan to build | [Feature Spec](#feature-spec) |
| How a system is structured today | [Architecture Overview](#architecture-overview) |
| A single significant decision and its alternatives | [Architecture Decision Record](#architecture-decision-record-adr) |
| How to do something operationally | [Runbook](#runbook) |
| What went wrong and what we learned | [Postmortem / Lessons Learned](#postmortem--lessons-learned) |
| House rules for code and naming | [Conventions](#conventions) |
| A proposal we want feedback on before committing | [RFC / Proposal](#rfc--proposal) |
| The purpose and usage of a package | [Package README](#package-readme) |

---

## Feature Spec

**Purpose.** Describe a feature we intend to build in enough detail that another engineer could implement it without follow-up questions. Lives in `docs/features/<feature-name>.md`.

**When to write.** Before any non-trivial feature with multiple moving parts, cross-cutting concerns, or user-visible behavior. Small bug fixes and isolated changes don't need one.

**Template.**

```markdown
# Feature: <Name>

**Status:** Draft | In Review | Approved | Implemented | Deprecated
**Owner:** <name>
**Last updated:** YYYY-MM-DD

## Summary

One paragraph. What are we building and for whom? A reader should know after this section whether they care about the rest of the doc.

## Motivation

Why does this need to exist now? What problem does it solve, and what happens if we don't build it? Link to supporting evidence (tickets, user reports, metrics) where relevant.

## Goals

- Concrete, testable outcomes this feature achieves.

## Non-Goals

- Things we are explicitly *not* doing. This is as important as the goals list — it scopes the work.

## User Stories / UX

How does a user encounter this feature? Walk through the primary flows. Include wireframes, screenshots, or links to Figma if available.

## Technical Design

How are we building it? Cover:

- Data model changes (new tables, columns, migrations)
- API surface (new endpoints, request/response shapes, auth requirements)
- Frontend components and routes affected
- External services or third-party integrations
- Background jobs, scheduled tasks, or async flows

Diagrams welcome. Mermaid is fine for sequence and flow diagrams.

## Alternatives Considered

What other approaches did we look at, and why didn't we pick them? Even a one-line "considered X, rejected because Y" is valuable for future readers.

## Rollout

How does this ship? Feature flag? Migration strategy? Backfill needed? Any coordination required with other teams?

## Open Questions

Things we haven't decided yet. Resolve before moving from Draft to Approved.

## References

- Linked tickets, PRs, related docs.
```

---

## Architecture Overview

**Purpose.** Describe how a system is structured *as it exists today*, the trade-offs that shaped it, and where the seams are. Lives in `docs/architecture/<system>.md`.

**When to write.** When a system reaches a stable shape worth documenting, or when onboarding new engineers reveals that the design isn't legible from the code alone. Treat these as living docs — update them when the architecture changes.

**Template.**

```markdown
# <System> Architecture

One-paragraph summary of what this system does and where it sits in our stack.

## Goals & Constraints

What this system is optimized for, and the constraints it operates under (latency targets, cost ceilings, compliance requirements, team size).

## High-Level Diagram

A picture of the major components and how they connect. Keep it simple — boxes and arrows beat ASCII art with twelve layers.

## Components

For each major component:

### <Component Name>

- **Responsibility:** What it owns.
- **Tech:** Languages, frameworks, services used.
- **Inputs / Outputs:** Where data comes from and goes.
- **Notable behavior:** Anything surprising — retries, caching, batching, fan-out.

## Data Flow

Walk through the most important request or data path end-to-end. A new engineer should be able to trace a real example through the system.

## Trade-offs & Rationale

The choices that aren't obvious from the code: why we picked X over Y, what we gave up, what we'd revisit if constraints changed. This is the section future-us will thank past-us for writing.

## Operational Notes

Pointers to the runbooks, dashboards, and alerts that cover this system. Don't duplicate them — link them.

## Known Limitations

What this system doesn't do well, and what we'd need to change to fix that.
```

---

## Architecture Decision Record (ADR)

**Purpose.** Capture a single significant decision, the context that forced it, and the alternatives we rejected. ADRs are append-only history — once accepted, we don't rewrite them; we supersede them with a new ADR. Lives in `docs/decisions/NNNN-<slug>.md` with a monotonically increasing number.

**When to write.** Any time we make a choice that future engineers will wonder about: framework selection, data model trade-offs, deviation from a standard pattern, deprecation of an approach.

**Template.**

```markdown
# ADR <NNNN>: <Title>

**Status:** Proposed | Accepted | Superseded by ADR-<NNNN> | Deprecated
**Date:** YYYY-MM-DD
**Deciders:** <names>

## Context

What forced this decision? What is the problem, the constraint, or the situation that means we have to choose? Stick to facts — save the recommendation for later.

## Decision

What we decided. One or two sentences, stated plainly.

## Alternatives Considered

For each option we seriously evaluated:

- **<Option>** — short description, pros, cons, why we didn't pick it.

## Consequences

What follows from this decision — both the good and the costs we now have to live with. Include forced future work ("we will need to migrate X by Y") and things this closes off.

## References

Links to relevant tickets, PRs, prior ADRs, external sources.
```

---

## Runbook

**Purpose.** Tell an on-call engineer exactly what to do when something happens. Lives in `docs/operations/<topic>.md`. Optimized for reading at 3 a.m. under stress.

**When to write.** For any operational task that's repeated, error-prone, or rare enough that we'll forget the steps. If we've ever had to ask "how do we do X again?" — write the runbook.

**Template.**

```markdown
# Runbook: <Task or Incident Type>

**When to use:** One sentence that lets the reader confirm this is the right runbook.
**Severity / Urgency:** What kind of situation this addresses.
**Last verified:** YYYY-MM-DD by <name>

## Prerequisites

- AWS access, VPN, tools, credentials, role assumptions.
- Anything that must already be true before the procedure works.

## Procedure

1. Numbered, copy-pasteable steps.
2. Include exact commands in fenced blocks. No placeholders without an example value.
3. After each step that produces output, note what success looks like.

```bash
example command --with-real-flags
```

## Verification

How do we know the task worked? Specific checks: a metric back to baseline, an endpoint returning 200, a row appearing in a table.

## Rollback

What to do if the procedure makes things worse. If rollback isn't possible, say so explicitly.

## Common Failure Modes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| ... | ... | ... |

## Related

- Dashboards, alerts, related runbooks.
```

---

## Postmortem / Lessons Learned

**Purpose.** Capture what happened during an incident or a project that went sideways, and what we'll do differently. Blameless — focus on systems and decisions, not individuals. Lives in `docs/lessons/YYYY-MM-DD-<slug>.md`.

**When to write.** After every user-impacting incident, after major project misses, and any time the team says "we should remember this for next time."

**Template.**

```markdown
# Postmortem: <Short Title>

**Date of incident:** YYYY-MM-DD
**Authors:** <names>
**Status:** Draft | Reviewed | Closed

## Summary

A few sentences a stakeholder can read and understand: what happened, who was affected, for how long, and what we did.

## Impact

- Users affected (count, segment).
- Duration.
- Data loss, financial impact, SLA breach, reputational impact.

## Timeline

All times in UTC. Include detection, response actions, escalations, mitigations, and resolution.

| Time (UTC) | Event |
|------------|-------|
| 14:02 | Deploy of commit `abc123` to prod. |
| 14:07 | Alert fires on `api-5xx-rate`. |
| ... | ... |

## Root Cause

What actually caused this? Go past the surface ("we pushed a bad config") to the underlying conditions ("our config validator didn't check for empty strings, and the deploy pipeline didn't require staging soak time"). Multiple contributing causes are fine — usually expected.

## What Went Well

The parts of detection, response, and recovery that worked. Worth naming so we keep doing them.

## What Went Poorly

Honest assessment of gaps. Systems, tooling, process — not people.

## Action Items

Concrete follow-ups with owners and target dates. Each item should be a ticket we can link to.

| Action | Owner | Due | Ticket |
|--------|-------|-----|--------|
| ... | ... | ... | ... |

## Lessons

The takeaways future-us will want even after the action items ship. The deeper "huh, we didn't realize..." insights.
```

---

## Conventions

**Purpose.** Document the house rules that aren't enforceable by linters but matter for consistency. Lives in `docs/conventions/<topic>.md` (e.g. `naming.md`, `api-design.md`, `testing.md`).

**When to write.** Once a pattern has been chosen deliberately and we want every new contributor to follow it without rediscovering the rationale. If a rule can be enforced by Biome or TypeScript, prefer that over a doc.

**Template.**

```markdown
# Conventions: <Topic>

## Principles

The handful of beliefs that drive the specific rules below. If a future situation isn't covered by a rule, the principles should be enough to decide.

## Rules

For each rule:

### <Rule name>

**Rule.** State it imperatively: "Do X." or "Never Y."

**Why.** The reason — usually a past pain point, a constraint, or an explicit trade-off we've made.

**Example.**

```ts
// ✅ Good
...

// ❌ Bad
...
```

**Exceptions.** When the rule doesn't apply, and what to do instead.

## Anti-patterns

A short list of things we've actively decided against, with one-line reasoning. Saves new contributors from rediscovering rejected paths.

## Open Questions

Things we haven't standardized yet. Listing them invites discussion rather than letting different parts of the codebase drift.
```

---

## RFC / Proposal

**Purpose.** Float an idea and gather feedback *before* committing to build it. Sits between an ADR and a feature spec — used when we're not yet sure we want to do the thing, or when we need cross-team buy-in.

**When to write.** Significant changes to shared infrastructure, public APIs, or cross-team workflows. Anything where "let's just build it and see" would be too expensive to undo.

**Template.**

```markdown
# RFC: <Title>

**Author:** <name>
**Status:** Draft | Under Discussion | Accepted | Rejected | Withdrawn
**Target decision date:** YYYY-MM-DD

## Summary

One paragraph: what we want to do and why we're asking.

## Motivation

The problem, in detail. Include data, user feedback, or specific incidents.

## Proposal

The thing we want to do. Concrete enough that reviewers can poke holes in it.

## Alternatives

Options we considered and why this one is better. Include "do nothing" as an option when it's a real choice.

## Drawbacks

The costs and risks of the proposal. Skip the temptation to make this list short — a credible RFC names its weaknesses.

## Unresolved Questions

Things we want feedback on specifically. Phrase as questions, not statements.

## Decision Log

Once decided, summarize the resolution and link to any follow-up ADRs or specs. The RFC itself doesn't become the system-of-record — it captures the conversation that led to one.
```

---

## Package README

**Purpose.** Orient a reader who lands in a workspace package. Lives at the package root as `README.md`.

**When to write.** For every workspace package under `app/` or `infra/` that has any non-trivial purpose. Keep it short — link to deeper docs in `/docs` rather than duplicating them.

**Template.**

```markdown
# @scope/<package-name>

One-line description.

## Purpose

Two or three sentences: what this package owns and who depends on it.

## Usage

Minimal example showing the most common import and call site.

```ts
import { thing } from "@scope/package";

thing(...);
```

## Public API

The exported surface, briefly. Don't restate every type — point at the entry file.

## Development

- How to run tests for just this package.
- Any package-specific scripts.

## See Also

- Links to related architecture docs, ADRs, or specs.
```

---

## Style Notes

A few rules that apply to every template:

- **Lead with the conclusion.** The first sentence of every section should let a reader decide whether they need to read further.
- **Date everything.** "Last updated" lines and explicit dates beat relative phrases like "recently" — docs outlive their authors' memory.
- **Link, don't duplicate.** When a fact lives somewhere authoritative (a runbook, a dashboard, a piece of code), link to it. Duplicates drift.
- **Show real examples.** Prefer concrete commands, code, and outputs over abstract descriptions. Replace placeholders with realistic values.
- **Prune.** A doc with stale sections is worse than a short doc. When we change a system, change its docs in the same PR.
