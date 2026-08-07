import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { OtpDelivery, OtpSender } from '../domain/otp-sender.port';

/**
 * Phone sign-in turned off (`OTP_SENDER=none`).
 *
 * The correct posture for a single-user deployment (ADR-009). A one-time code exists to
 * authenticate someone you do not know; when the only user is the operator there is nobody to
 * authenticate, and devices are enrolled directly with the `enrol-device` CLI.
 *
 * It **throws** rather than quietly succeeding. A silent no-op would leave someone waiting for a
 * message that was never going to arrive, indistinguishable from a wrong phone number — they
 * would retry forever. This is also why it is production-safe where the log sender is not:
 * removing the flow is not the same as weakening it, because there is no code to leak.
 */
@Injectable()
export class DisabledOtpSender implements OtpSender {
  async send(_delivery: OtpDelivery): Promise<void> {
    await Promise.resolve();

    throw new ServiceUnavailableException(
      'Phone sign-in is not enabled on this deployment (OTP_SENDER=none). ' +
        'Enrol a device with the enrol-device CLI instead.',
    );
  }
}
