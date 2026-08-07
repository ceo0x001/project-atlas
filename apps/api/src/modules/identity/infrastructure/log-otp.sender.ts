import { Injectable, Logger } from '@nestjs/common';
import type { OtpDelivery, OtpSender } from '../domain/otp-sender.port';

/**
 * Development sender: writes the code to the log instead of sending an SMS.
 *
 * This exists so the sign-in flow is fully exercisable — by tests, by the founder on a
 * laptop — without an SMS account or per-message spend.
 *
 * **It is a security hole by construction**, because it puts live sign-in codes in plain
 * text wherever logs go. `parseEnv` therefore refuses to start in production unless a real
 * sender is configured, and this class shouts on construction so its presence is never a
 * surprise in a deployed log stream.
 */
@Injectable()
export class LogOtpSender implements OtpSender {
  private readonly logger = new Logger(LogOtpSender.name);

  constructor() {
    this.logger.warn(
      'Using the development OTP sender: sign-in codes are written to the log and no SMS is sent',
    );
  }

  async send(delivery: OtpDelivery): Promise<void> {
    // Await nothing, but keep the signature honest: a real sender is asynchronous, and
    // callers must not come to depend on this resolving synchronously.
    await Promise.resolve();

    this.logger.warn(
      `DEV OTP for ${delivery.phoneE164}: ${delivery.code} (expires ${delivery.expiresAt.toISOString()})`,
    );
  }
}
