# ADR-005: LLM grounding — numbers only from tools

**Status:** Accepted · 2026-08-06

## Context

Product invariant I1: the LLM is never the source of truth. One hallucinated balance
destroys trust permanently in a finance product.

## Decision

1. The model can only access data through typed tools; tools return the only numbers
   it may state.
2. A post-generation validator checks every numeric/monetary claim in a response
   against the turn's tool results. Mismatch → one regeneration → else degrade to a
   canvas-only answer ("here's the data") rather than speak an unverified number.
3. The canvas (`render_canvas` tool) renders charts/lists directly from raw query
   results — numbers on screen structurally bypass the LLM.

## Consequences

- Slight latency cost for validation (runs on the buffered final text in parallel
  with TTS of earlier sentences; the gate can truncate audio mid-answer in the rare
  failure case).
- Grounding-gate failure rate is a tracked SLO; rising rate = prompt regression.
