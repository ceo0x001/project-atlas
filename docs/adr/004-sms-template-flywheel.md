# ADR-004: On-device SMS parsing with remotely-updatable templates + LLM flywheel

**Status:** Accepted · 2026-08-06

## Context

SMS alert formats vary per bank and change without notice. Parsing must be
deterministic in production (invariant I2) but adaptable without app releases.

## Decision

- Parsing uses deterministic, versioned templates (per bank sender ID / message shape).
- Templates are **data**, fetched from a backend registry — new formats ship instantly.
- On parse failure of a known bank sender: with one-time explicit consent, the
  redacted raw text is uploaded; a backend workflow has Claude synthesize a candidate
  template; the candidate is validated against held-out samples before publication.

The LLM writes the parser. The parser that runs in production is deterministic.

## Consequences

- Parse success rate per bank/template becomes a first-class product metric.
- We need a template DSL (regex + typed field extraction + unit tests as fixtures).
- Consent UX for raw-text upload must be built in v0.1 (invariant I4).
