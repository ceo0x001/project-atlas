# ADR-008: A canonical transaction is a projection of its observations

- **Status:** Proposed
- **Date:** 2026-08-07
- **Context:** M2 reconciliation ([design](../design/m2-reconciliation.md))

## Context

M1 admits observations eagerly: an SMS alert becomes a canonical transaction within
seconds, because the product promise is that Atlas knows about a purchase almost as it
happens. Any design that holds observations in a pending state until a matching window
closes gives up that promise.

The consequence is that when a second source describes an already-booked transaction — a
statement uploaded three weeks later — the canonical transaction **already exists**.
Reconciliation is therefore a merge of admitted transactions, not a gate in front of
admission. On top of that, merges must survive user corrections, remain explainable after
the fact, and be reversible when wrong.

The naive shape is a mutable `transactions` table plus bespoke logic for each concern:
field-by-field conflict resolution on merge, a separate override mechanism so user edits
survive, an audit table written by hand at each mutation site, and a special path for
splitting. Four mechanisms, each able to disagree with the others.

## Decision

**A canonical transaction's fields are a pure, deterministic function of the set of
observations linked to it.** Nothing is authored directly onto a transaction; every field
is projected from its observations by a precedence function.

Corollaries:

1. **Merge** = union two observation sets, re-project. No field-level conflict logic.
2. **Split** = move an observation to a new transaction, re-project both. Exactly the
   inverse of merge, not a separate mechanism.
3. **A user correction is an observation** with `source = USER_STATED`, ranked highest in
   precedence. It cannot be lost by a later merge because it is part of the input.
4. **Provenance is automatic** — the observation link table _is_ the derivation (I6).
5. **Merged-away transactions are superseded, never deleted** — they keep their row and
   gain `supersededByTransactionId`, so ids already cited by insights, memories, and past
   explanations still resolve.

Field precedence is per-field rather than uniform. Most notably `occurredAt` prefers SMS
over statement: alerts are timestamped at the moment of the transaction, while statement
rows are frequently date-only or carry a booking date days later. Preferring the statement
would move transactions across month boundaries and corrupt every monthly total.

## Consequences

### Good

- One mechanism instead of four, and the hard property — determinism — is a property of a
  pure function that can be exhaustively unit tested without a database.
- Reconciliation becomes reviewable: any number can be re-derived from its inputs, so a
  changed total is explainable rather than mysterious.
- Splitting is free rather than an afterthought, which matters because a wrong merge is
  otherwise unrecoverable.

### Costs, accepted

- **Projection must run on every observation attach**, so a transaction's fields are
  written more often than in a mutable design. Bounded: observation sets per transaction
  are small (1–3 in practice).
- **Superseded rows must be excluded from every aggregate**, or every total silently
  doubles. This is the most dangerous consequence of the decision and is why the exclusion
  goes into the single mandatory predicate set in the query compiler, with a guard test
  enumerating every emitted query — not into a convention.
- **A re-projection can change a number the user already saw.** Mitigated by an
  append-only `ReconciliationEvent` recording the evidence, so the change can be explained.

### Rejected alternatives

| Alternative                                    | Why rejected                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Defer admission until the match window closes  | Kills the real-time promise that makes the product feel alive. Rejected on product grounds.           |
| Mutable transactions + explicit override table | Four mechanisms that can disagree; user corrections survive only if every merge site remembers them.  |
| Delete the absorbed transaction                | Breaks every insight, memory, and explanation citing its id, and destroys the audit trail for review. |
| LLM-assisted matching for ambiguous cases      | Violates "financial calculations must always be deterministic." A merge decides what money exists.    |

## Note on bias

Matching is deliberately biased toward **under-merging**. An under-merge shows the user a
visible duplicate they can correct; an over-merge silently removes real spending from their
totals with no way to notice. The costs are asymmetric, so every ambiguous case resolves to
leaving transactions separate, and only reference or balance corroboration earns an
automatic merge.
