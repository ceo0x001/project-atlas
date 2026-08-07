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
