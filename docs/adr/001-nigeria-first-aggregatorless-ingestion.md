# ADR-001: Nigeria-first, aggregator-less ingestion

**Status:** Accepted · 2026-08-06

## Context

v1 targets Nigeria. Bank data can come from aggregator APIs (Mono/Okra), on-device
SMS/email alert parsing, statement uploads, or manual entry.

## Decision

Skip aggregator APIs in v1. Ingest via (1) on-device SMS/email alert parsing,
(2) voice/manual entry, (3) bank statement upload for backfill.

## Rationale

- Aggregator coverage/reliability in Nigeria is uneven; SMS debit/credit alerts are
  near-universal and near-real-time.
- No per-user aggregator fees — unit economics matter for a Nigerian consumer price point.
- On-device parsing keeps raw financial text off our servers (privacy posture, NDPR).
- No third-party credential-sharing trust barrier at signup.

## Consequences

- Ingestion logic lives substantially on the device → offline-first is load-bearing.
- We own parsing robustness (see ADR-004 template flywheel).
- iOS cannot read SMS → Android-first (ADR-006).
- If banks migrate away from SMS alerts, email forwarding + statements are the hedge
  (Risk R1). Aggregators can be added later as just another observation source —
  the `transaction_observation` model (ARCHITECTURE §5.1) already accommodates it.
