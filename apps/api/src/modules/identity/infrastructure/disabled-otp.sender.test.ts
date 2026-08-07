import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DisabledOtpSender } from './disabled-otp.sender';

const DELIVERY = {
  phoneE164: '+2348012345678',
  code: '123456',
  expiresAt: new Date('2026-08-07T10:10:00.000Z'),
};

describe('DisabledOtpSender', () => {
  /**
   * The default posture on a single-user deployment (ADR-009). It must refuse loudly: a silent
   * no-op would leave someone waiting for a message that was never going to arrive, which is
   * indistinguishable from a wrong phone number and invites retrying forever.
   */
  it('refuses to send rather than quietly succeeding', async () => {
    await expect(new DisabledOtpSender().send(DELIVERY)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('says how to enrol a device instead', async () => {
    let message = '';

    try {
      await new DisabledOtpSender().send(DELIVERY);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('OTP_SENDER=none');
    expect(message).toContain('enrol-device');
  });

  /** The code must not reach a log or an error message on its way out. */
  it('does not repeat the code back in its refusal', async () => {
    let message = '';

    try {
      await new DisabledOtpSender().send(DELIVERY);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain('123456');
    expect(message).not.toContain(DELIVERY.phoneE164);
  });
});
