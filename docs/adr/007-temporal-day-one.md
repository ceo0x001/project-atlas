# ADR-007: Temporal for durable workflows from day 1

**Status:** Accepted · 2026-08-06

## Context

Statement imports, reconciliation, template synthesis, per-user proactive schedules,
and right-to-erasure are all multi-step, failure-prone, long-running processes.

## Decision

Run Temporal from day 1 (self-hosted single-node Docker in v0.1; Temporal Cloud when
reliability is worth more than the invoice). All multi-step background processes are
Temporal workflows; ad-hoc queues/crons are not permitted for anything with more
than one step or a retry requirement.

## Rationale

Retrofitting durability onto a pile of BullMQ jobs is the expensive path. Temporal's
determinism constraints also force clean activity separation early.

## Consequences

- One more piece of infrastructure to run in v0.1 (accepted, it's a single container
  locally and in early prod).
- Workflow code must follow determinism rules — covered by the
  `workflow-orchestration-patterns` conventions when we implement.

---

## Amendment 1 — narrowed scope (2026-08-07)

**The "day one" framing was premature, and this ADR's own rule was too broad.**

Two of the five processes cited above turned out not to need Temporal at all, and the
decision as written — "ad-hoc queues/crons are not permitted for anything with more than
one step or a retry requirement" — would have made both worse:

**Reconciliation (M2)** needs no workflow. The reactive path runs inside the admission
transaction that already exists; the late-arrival path is triggered by a statement import
completing, which is an event rather than a clock; and gap detection is a pure function over
balance readings the ledger already holds, so it is computed on demand and cannot go stale.
A workflow here would add durability to something already durable.

**The outbox relay** is actively a poor fit, not merely unnecessary:

- **The outbox table already is the durable state.** A workflow would be a second durable
  store for the same fact, able to disagree with the row it describes. Reconciling two
  sources of truth about one event is worse than having one.
- **The volume is wrong.** A relay is high-frequency infrastructure. One workflow per event
  means workflow history, timers and task-queue traffic per SMS alert — which does not
  survive the scale this project is designed for.
- **The canonical solution is boring and sufficient.** `SELECT … FOR UPDATE SKIP LOCKED`
  with a visibility lease is proven, horizontally safe, and adds no dependency. It is
  implemented in `shared/events/outbox-relay.service.ts`.

### Amended decision

Temporal is for processes that are **genuinely long-running, multi-step, and involve
external I/O or a human** — statement import (download → parse → validate against the
statement's own opening/closing balance → admit, with human-in-loop on rejection), template
synthesis, per-user proactive schedules, and right-to-erasure. It is **not** the default for
anything merely periodic or retrying.

The replaced rule is too blunt to be useful. Retry alone does not justify a workflow: a
durable table plus a lease gives at-least-once delivery with far less machinery. The test is
whether the _process_ has state worth checkpointing, not whether a step can fail.

Temporal has therefore **not been stood up yet**, and the original claim that it runs from
day one is no longer accurate. It arrives with statement import, which is the first process
that actually earns it.

### Why record this rather than quietly diverge

An ADR that the code contradicts is worse than no ADR: it teaches the wrong thing
confidently. The reasoning above is also the reasoning a future contributor needs in order
to decide correctly the next time something periodic shows up — and the answer is not
always "no Temporal", it is "does this process have checkpointable state".
