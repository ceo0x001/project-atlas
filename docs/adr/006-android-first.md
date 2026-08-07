# ADR-006: Android-first — separating the ingestion node from the client

**Status:** Accepted · 2026-08-06 (amended same day, see Amendment 1)

## Context

Primary ingestion is on-device SMS parsing (ADR-001). iOS provides no API to read
SMS: `ILMessageFilterExtension` only sees messages from _unknown_ senders for spam
classification, cannot retain their content, and bank alerts arrive from known
senders — so it does not apply. There is no iOS path to SMS ingestion.

Android holds ~80%+ of the Nigerian smartphone market.

## Decision

Atlas distinguishes two roles, which may run on different devices:

| Role               | Responsibility                                     | Platform                     |
| ------------------ | -------------------------------------------------- | ---------------------------- |
| **Ingestion node** | SMS listener + template parser; emits observations | Android only (OS limitation) |
| **Client**         | Conversation, voice, canvas, insights, memory      | Platform-agnostic (Flutter)  |

v0.1 ships an Android app that is both, built in Flutter so the iOS client is a
port rather than a rewrite. The iOS client lands after milestone M3 and supports
everything except the SMS listener (email forwarding, statement upload, manual and
voice entry).

## Rationale

- **Time to value decides this.** With SMS, first run is: grant permission → Atlas
  reads the existing inbox → it already knows months of the user's financial history.
  Without SMS, onboarding is "enable email alerts at your bank and wait until
  tomorrow." The instant-history moment is the core of the product experience.
- iOS-first was considered and rejected: iPhone users in Nigeria are the affluent
  segment (favourable for risk R4, willingness-to-pay), but that does not compensate
  for losing instant history and ~80% of the market.

## Consequences

- One platform to QA for v0.1; faster solo iteration.
- The SMS listener sits behind a platform-channel interface, so the shared Dart
  codebase stays platform-agnostic.
- Google Play SMS-permission policy is a compliance work item. Atlas's SMS read is
  core functionality (financial alert processing), an allowed category, but the
  declaration and review process must be planned for M5, not discovered at launch.
- The sync layer (ARCHITECTURE §9) already treats raw observations as
  device-authoritative and derived data as server-authoritative, so a user's Android
  ingestion node and their iOS client can be different devices at no extra cost.
  Dual-phone setups are common in the target market; this may become a user-facing
  capability rather than only a development affordance.

## Amendment 1 (2026-08-06) — founder dogfooding

The founder's personal device is an iPhone. A solo founder who cannot run the
product daily will build the wrong product, so this is treated as a build-blocking
concern rather than a convenience.

1. **A mid-range Android development device is required from M1** — Tecno, Infinix,
   or Samsung A-series class, not a flagship. Beyond enabling SMS ingestion, it is
   the performance reference: target users run ~4GB-RAM devices on intermittent 4G,
   and voice latency, cold start, sync-under-packet-loss, and SMS-listener battery
   drain are not observable on a current flagship.
2. **The iOS client is scheduled after M3.** The founder then uses iOS as the daily
   client with the Android device acting as ingestion node — which dogfoods the
   multi-device path before it is offered to users.
