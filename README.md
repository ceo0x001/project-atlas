# Atlas

**An AI Financial Operating System.** The first release is a read-only conversational
CFO for Nigeria: talk to Atlas, and it knows every transaction across your accounts,
remembers everything important, answers any question about your money truthfully,
and tells you things before you ask.

- Vision, system design, and risks: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Decision records: [docs/adr/](docs/adr/)

## Ground rules

1. The database is the source of truth. The LLM is never.
2. Financial math is deterministic. Money is integers in minor units — never floats.
3. Raw SMS/email stays on-device by default.
4. Every user-visible claim is explainable back to its source transactions.
5. Anything not in the v0.1 scope (ARCHITECTURE §1) requires an ADR before code.

## Status

Pre-code. Architecture accepted, milestone M0 (skeleton) is next.
