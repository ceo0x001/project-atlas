import { Body, Controller, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { ZodValidationPipe } from '@shared/validation/zod-validation.pipe';
import { PhoneAuthService } from '../application/phone-auth.service';
import {
  type StartSignInRequest,
  startSignInSchema,
  type VerifySignInRequest,
  verifySignInSchema,
} from './auth.dto';

/**
 * Phone sign-in.
 *
 * The only unauthenticated surface in the application, and the one that mints credentials —
 * so what it *declines* to say matters as much as what it does.
 *
 * `start` always answers the same way. It does not reveal whether a number is registered,
 * whether a code was actually sent, or whether the caller has been throttled. For a
 * financial product that is a user-safety property, not merely good hygiene: a branching
 * response would let anyone confirm that a given person banks with Atlas.
 *
 * `verify` collapses every rejection into one 401 with no detail. Distinguishing "wrong
 * code" from "expired" from "already used" would tell an attacker which of the three limits
 * protecting a six-digit secret they had run into, and therefore which to work around.
 *
 * On a single-user deployment (`OTP_SENDER=none`, the default — ADR-009) this whole surface is
 * inert: the sender throws, so both routes answer 503 with an explanation. That is deliberately
 * a clear refusal rather than a 404 — six months from now the person confused by it will be the
 * operator, and "this is disabled, use the CLI" is worth more than a hidden route.
 */
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: PhoneAuthService) {}

  @Post('start')
  @HttpCode(200)
  async start(
    @Body(new ZodValidationPipe(startSignInSchema)) body: StartSignInRequest,
  ): Promise<{ challengeId: string; expiresAt: Date }> {
    const result = await this.auth.start({ phoneE164: body.phone });

    return { challengeId: result.challengeId, expiresAt: result.expiresAt };
  }

  /**
   * Verifies a code and returns the device token.
   *
   * The token appears in this response and nowhere else, ever — only its hash is stored. A
   * client that loses it must sign in again, which is the correct trade: a retrievable
   * credential is one a support process can be talked into handing over.
   */
  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body(new ZodValidationPipe(verifySignInSchema)) body: VerifySignInRequest,
  ): Promise<{
    userId: string;
    deviceId: string;
    token: string;
  }> {
    const outcome = await this.auth.verify(body);

    if (outcome.kind === 'rejected') {
      // Deliberately uniform. The specific reason is logged server-side, where it helps an
      // operator, rather than returned to a caller who may be probing.
      throw new UnauthorizedException('Invalid or expired code');
    }

    return { userId: outcome.userId, deviceId: outcome.deviceId, token: outcome.token };
  }
}
