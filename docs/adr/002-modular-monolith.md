# ADR-002: Modular monolith on NestJS

**Status:** Accepted · 2026-08-06

## Context

Solo founder building a system that must survive to 10M users without a rewrite.

## Decision

One deployable NestJS application with strictly enforced module boundaries
(bounded contexts per ARCHITECTURE §4), communicating internally through a typed
domain-event bus backed by a transactional outbox. No microservices.

## Rationale

- Microservices solve a team-scaling problem we do not have; they add distributed-
  systems failure modes we cannot afford to debug solo.
- The outbox-backed event seam means any module can be extracted into a worker or
  service later by changing transport, not code structure.
- Stateless app instances + Redis sessions scale horizontally far past v1 needs.

## Consequences

- Module boundary discipline must be enforced mechanically (ESLint import rules /
  Nx module boundaries), not by convention.
- One database transaction can span modules in-process — convenient now; extraction
  later must respect the event seam instead.
