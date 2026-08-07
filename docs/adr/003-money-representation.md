# ADR-003: Money as integer minor units + currency code

**Status:** Accepted · 2026-08-06

## Decision

All monetary amounts are `BIGINT` minor units (kobo, cents) paired with an ISO-4217
currency code. A `Money` value object in the shared kernel is the only permitted
way to do arithmetic. Floats on money are banned by lint rule.

NGN and USD are first-class from day 1 (domiciliary accounts are common in the
target market). Cross-currency aggregation happens only at display time, labeled,
using a stored dated rate — never silently.

## Consequences

- No floating-point drift, ever (product invariant I2/I3).
- Display formatting is a presentation concern; the ledger never stores formatted values.
- Adding currencies is data, not schema.
