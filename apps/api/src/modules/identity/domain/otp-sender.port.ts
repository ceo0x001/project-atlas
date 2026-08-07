/**
 * Port for delivering a one-time code.
 *
 * A port rather than a direct provider call, for a reason that is commercial as much as
 * architectural: choosing and paying for a Nigerian SMS gateway (Termii, Africa's Talking,
 * or a bank-grade aggregator) is a founder decision with real per-message cost. Making
 * delivery pluggable means everything upstream and downstream of it can be built, tested and
 * reviewed before that decision is made, instead of the whole sign-in flow waiting on an
 * account signup.
 *
 * The dangerous consequence is a development sender reaching production and writing live
 * sign-in codes into a log aggregator. That is prevented in `parseEnv`, which refuses to
 * boot in production unless a real sender is configured — a check rather than a convention,
 * because "remember not to deploy with the dev sender" is not a security control.
 */

export interface OtpDelivery {
  readonly phoneE164: string;
  readonly code: string;
  /** How long the recipient has, so the message can say so. */
  readonly expiresAt: Date;
}

export interface OtpSender {
  /**
   * Delivers the code, or throws.
   *
   * A throw fails the sign-in attempt loudly rather than leaving the user waiting for a
   * message that was never sent — a silent failure here is indistinguishable to the user
   * from a wrong phone number, and they would retry forever.
   */
  send(delivery: OtpDelivery): Promise<void>;
}

export const OTP_SENDER = Symbol.for('atlas.OtpSender');
