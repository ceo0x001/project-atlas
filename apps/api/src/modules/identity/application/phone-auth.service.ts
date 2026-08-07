import { Inject, Injectable, Logger } from '@nestjs/common';
import { type DeviceId, newId, type UserId } from '@atlas/shared-kernel';
import { PrismaService } from '@shared/prisma/prisma.service';
import { TenantScope } from '@shared/prisma/tenant-scope';
import type { DeviceRole } from '../domain/device-principal';
import { issueDeviceToken } from '../domain/device-token';
import {
  CHALLENGE_RATE_WINDOW_MS,
  generateOtpCode,
  hashOtpCode,
  MAX_CHALLENGES_PER_PHONE,
  MAX_OTP_ATTEMPTS,
  otpExpiresAt,
  unmatchableCodeHash,
  verifyOtp,
  type VerificationResult,
} from '../domain/otp';
import { OTP_SENDER, type OtpSender } from '../domain/otp-sender.port';

/**
 * Phone sign-in, and the device enrolment it authorises.
 *
 * This is the bootstrap of the whole tenancy model: everything else in Atlas derives its
 * user from an authenticated device, and this is where the first one comes from.
 *
 * ## First sign-in is sign-up
 *
 * There is no separate registration step. A phone number that has not been seen creates a
 * user; one that has been seen signs in. Nigeria is phone-first — asking someone to pick a
 * password before they can see whether the product is useful loses them, and a password is
 * another secret to breach for no benefit when the phone is already the identifier.
 *
 * ## What the endpoints must never reveal
 *
 * `start` behaves identically whether or not the number is registered. Branching would turn
 * it into a directory: anyone could learn who uses Atlas by trying numbers, which for a
 * financial product is a real harm to the user, not just an information leak.
 *
 * ## Rate limits live in Postgres, not in memory
 *
 * A per-process counter is worthless behind more than one instance and resets on deploy —
 * which is exactly when an attacker would retry. Counting rows means the limit holds across
 * instances and restarts. IP-level limiting belongs at the edge (a CDN or reverse proxy),
 * where the address is trustworthy and the request can be dropped before it costs anything.
 */

export interface StartSignInInput {
  /** Already normalised to E.164 by the DTO — this service does not re-parse it. */
  readonly phoneE164: string;
}

export interface StartSignInResult {
  readonly challengeId: string;
  readonly expiresAt: Date;
}

export interface VerifySignInInput {
  readonly challengeId: string;
  readonly code: string;
  readonly platform: 'ANDROID' | 'IOS';
  readonly role: DeviceRole;
  // Explicitly `| undefined`: with `exactOptionalPropertyTypes` an optional property and one
  // that may be present-but-undefined are different types, and a validated request body
  // produces the latter.
  readonly model?: string | undefined;
  readonly osVersion?: string | undefined;
  readonly appVersion?: string | undefined;
}

export type VerifySignInOutcome =
  | {
      readonly kind: 'enrolled';
      readonly userId: UserId;
      readonly deviceId: DeviceId;
      /** Plaintext token, returned once and never retrievable again. */
      readonly token: string;
    }
  | { readonly kind: 'rejected'; readonly reason: VerificationResult | 'unknown-challenge' };

@Injectable()
export class PhoneAuthService {
  private readonly logger = new Logger(PhoneAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantScope: TenantScope,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
  ) {}

  /**
   * Starts a sign-in.
   *
   * Throws only when delivery fails. A rate-limited caller still receives a challenge id
   * with no code sent, because refusing visibly would let an attacker probe the limit — and
   * a legitimate user who has hit five attempts in fifteen minutes is better served by the
   * code simply not arriving than by a message explaining the ceiling.
   */
  async start(input: StartSignInInput): Promise<StartSignInResult> {
    const now = new Date();
    const expiresAt = otpExpiresAt(now);
    const challengeId = newId<'FactId'>();

    const recent = await this.prisma.authChallenge.count({
      where: {
        phoneE164: input.phoneE164,
        createdAt: { gte: new Date(now.getTime() - CHALLENGE_RATE_WINDOW_MS) },
      },
    });

    const throttled = recent >= MAX_CHALLENGES_PER_PHONE;
    const code = generateOtpCode();

    await this.prisma.authChallenge.create({
      data: {
        id: challengeId,
        phoneE164: input.phoneE164,
        // A throttled challenge stores a hash no six-digit submission can match, so the row
        // looks ordinary from outside but can never be completed. It must NOT be the hash of
        // another six-digit code: that space is brute-forceable, so the decoy would itself
        // be a usable credential.
        codeHash: throttled ? unmatchableCodeHash() : hashOtpCode(code),
        expiresAt,
      },
    });

    if (throttled) {
      this.logger.warn(`Sign-in throttled for ${redact(input.phoneE164)}: ${recent} recent codes`);
      return { challengeId, expiresAt };
    }

    await this.sender.send({ phoneE164: input.phoneE164, code, expiresAt });

    return { challengeId, expiresAt };
  }

  /**
   * Verifies a code and enrols the device that submitted it.
   *
   * The attempt is counted **before** the code is compared. Counting afterwards would let a
   * crash — or a client that hangs up mid-request — buy free guesses, which is precisely how
   * an attempt cap gets defeated in practice.
   */
  async verify(input: VerifySignInInput): Promise<VerifySignInOutcome> {
    const now = new Date();

    const challenge = await this.prisma.authChallenge.findUnique({
      where: { id: input.challengeId },
    });

    // Unknown and dead challenges are reported the same way to the caller, so a probe
    // cannot distinguish "never existed" from "already used".
    if (!challenge) return { kind: 'rejected', reason: 'unknown-challenge' };

    const claimed = await this.prisma.authChallenge.updateMany({
      where: { id: input.challengeId, attempts: { lt: MAX_OTP_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });

    if (claimed.count === 0) return { kind: 'rejected', reason: 'too-many-attempts' };

    const result = verifyOtp(
      {
        codeHash: challenge.codeHash,
        // The attempt just recorded is included, so the cap is evaluated against reality.
        attempts: challenge.attempts + 1,
        consumedAt: challenge.consumedAt,
        expiresAt: challenge.expiresAt,
      },
      input.code,
      now,
    );

    if (result !== 'ok') return { kind: 'rejected', reason: result };

    // Single use, enforced by the database rather than by this code path: only the update
    // that finds `consumedAt` still null wins, so two requests racing a correct code cannot
    // both enrol a device.
    const consumed = await this.prisma.authChallenge.updateMany({
      where: { id: input.challengeId, consumedAt: null },
      data: { consumedAt: now },
    });

    if (consumed.count === 0) return { kind: 'rejected', reason: 'already-used' };

    const userId = await this.resolveUser(challenge.phoneE164);
    const enrolled = await this.enrolDevice(userId, input);

    this.logger.log(`Enrolled device ${enrolled.deviceId} for ${redact(challenge.phoneE164)}`);

    return { kind: 'enrolled', userId, deviceId: enrolled.deviceId, token: enrolled.token };
  }

  /**
   * Finds the user behind a verified phone number, creating one on first sign-in.
   *
   * The lookup goes through `phone_identities` rather than `users`, and that indirection is
   * load-bearing rather than incidental. `users` is under row-level security keyed on
   * `id = atlas.user_id`, so reading it *by phone* — which is all we know at this point —
   * matches zero rows however the query is written. Reading `users` here would silently find
   * nothing and then try to create a duplicate, failing on the unique constraint and locking
   * an existing user out of their own account.
   *
   * `phone_identities` carries the same deliberate RLS exemption as `device_credentials`: it
   * is consulted to discover who is calling, so gating it by the answer would be circular.
   */
  private async resolveUser(phoneE164: string): Promise<UserId> {
    const existing = await this.prisma.phoneIdentity.findUnique({
      where: { phoneE164 },
      select: { userId: true },
    });

    if (existing) return existing.userId as UserId;

    const userId = newId<'UserId'>();

    // Created inside its own tenant scope, so the RLS write policy on `users` is satisfied
    // by the row being the tenant it belongs to rather than by bypassing the policy.
    await this.tenantScope.run(userId, (tx) => tx.user.create({ data: { id: userId, phoneE164 } }));

    // Written after the user exists, so the mapping can never point at a row that is not
    // there. A crash between the two leaves a user with no mapping, which the next sign-in
    // surfaces as a unique-constraint failure on `users` — loud and recoverable — rather than
    // as a mapping into nothing.
    await this.prisma.phoneIdentity.create({ data: { phoneE164, userId } });

    return userId;
  }

  private async enrolDevice(
    userId: UserId,
    input: VerifySignInInput,
  ): Promise<{ deviceId: DeviceId; token: string }> {
    const deviceId = newId<'DeviceId'>();
    const { token, tokenHash } = issueDeviceToken();

    await this.tenantScope.run(userId, async (tx) => {
      await tx.device.create({
        data: {
          id: deviceId,
          userId,
          platform: input.platform,
          role: input.role,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.osVersion === undefined ? {} : { osVersion: input.osVersion }),
          ...(input.appVersion === undefined ? {} : { appVersion: input.appVersion }),
        },
      });

      await tx.deviceCredential.create({ data: { tokenHash, deviceId, userId } });
    });

    return { deviceId, token };
  }
}

/**
 * Keeps whole phone numbers out of logs.
 *
 * A log line is not the place for an identifier that maps to a person's finances, and log
 * streams reach further than the database does.
 */
function redact(phoneE164: string): string {
  return `${phoneE164.slice(0, 7)}****${phoneE164.slice(-2)}`;
}
