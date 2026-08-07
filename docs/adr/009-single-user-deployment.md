# ADR-009: Atlas v1 is single-user software

- **Status:** Accepted
- **Date:** 2026-08-07
- **Supersedes:** nothing. **Reframes:** the deployment assumptions in ADR-006 and the sign-in
  design.

## Context

The founding brief asked for a design that "would still make sense with 10 million users", and
the architecture was built to that standard: row-level security, per-tenant scoping, a
multi-tenant reconciliation model. What was never established is who the **users of v1** are.

They are one person: the founder, running Atlas over their own finances.

That was not a change of plan. It was an assumption nobody had written down, and it went unnoticed
until the SMS gateway work made it load-bearing. Building phone sign-in led to "production cannot
boot without an SMS sender", which led to "an SMS sender needs an NCC-registered sender ID", which
led to "sender-ID registration needs business registration". At no point in that chain did anyone
ask whether a system with one user needs to send anyone a text message.

It does not.

## Decision

**Atlas v1 is deployed for a single operator. Phone sign-in is disabled by default, and devices
are enrolled locally.**

- `OTP_SENDER=none` is the default, and is **permitted in production**. It disables
  `/v1/auth/*`: the sender throws, so both routes answer 503 with an explanation.
- Devices are enrolled with `node dist/cli/enrol-device.js --phone <number>`, which creates the
  user on first run and prints the token once.
- No SMS gateway, no sender-ID registration, and no business registration are required to build,
  run or deploy Atlas.

`OTP_SENDER=log` remains for exercising the sign-in flow in development, and remains forbidden in
production, because it writes live codes into the log.

## Rationale

**A one-time code authenticates someone you do not know.** When the only user is the operator,
there is nobody to authenticate, and the code is ceremony wrapped around a person who already has
database access. The CLI is not a workaround for the missing gateway — it is the honest mechanism
for the actual situation.

**Disabling is safe where degrading is not.** `none` is production-safe precisely because it
removes the flow rather than weakening it: there is no code generated, so there is no code to
leak. That is a different thing from the log sender, which is why the two are treated differently.

**The enrolment CLI must never gain an HTTP route.** It takes a phone number and mints a
credential with no proof of anything. Its safety comes entirely from being local, which is the
same reason `DeviceEnrolmentService` has never had a controller.

## What this does not change

**The multi-tenant design stays.** Row-level security, tenant scoping, and the per-user data model
are retained in full, and none of it is unpicked. Three reasons:

1. It is built, tested and proven in both directions. Removing it would be work spent creating
   risk.
2. It costs nothing at one user — RLS is a predicate on an indexed column.
3. It is what makes a second user a configuration change rather than a rewrite.

Designing for many users and deploying for one are compatible. What was wrong was letting the
_deployment_ assumption go unexamined while the _design_ assumption was explicit.

## Consequences

- **The SMS gateway leaves the critical path entirely.** It was never a build prerequisite; it was
  a launch prerequisite for a launch that is not the current goal.
- **The sign-in flow is retained rather than deleted** — 27 unit and 22 integration tests still
  cover it, and it is exercised in development with `OTP_SENDER=log`. It is the path a second user
  would arrive through, so deleting it would be throwing away working code to celebrate a scope
  reduction.
- **Reversing this is one enum value and an adapter.** `OtpSender` has a single method. Adding a
  real sender is an afternoon, plus however long NCC registration takes.

## Note on how this was found

The chain from "phone sign-in" to "get business registration" was four inferential steps, each
locally reasonable, and the conclusion was wrong because step one rested on an unstated premise.
Worth remembering: when a requirement grows a tail of prerequisites, the cheapest thing to check
is whether the original requirement applies at all.
