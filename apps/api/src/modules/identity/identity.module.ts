import { Module } from '@nestjs/common';
import { AuthController } from './api/auth.controller';
import { DeviceAuthGuard } from './api/device-auth.guard';
import { DeviceAuthenticator } from './application/device-authenticator';
import { DeviceEnrolmentService } from './application/device-enrolment.service';
import { PhoneAuthService } from './application/phone-auth.service';
import { ENV, type Env } from '@config/env';
import { OTP_SENDER, type OtpSender } from './domain/otp-sender.port';
import { DisabledOtpSender } from './infrastructure/disabled-otp.sender';
import { LogOtpSender } from './infrastructure/log-otp.sender';

/**
 * Identity — users, devices, authentication and consent records.
 *
 * Consents are stored as timestamped, scoped records rather than booleans on the
 * user row: NDPR compliance needs an audit trail, and "when did they agree, to
 * what version of what policy" is not answerable from a flag.
 *
 * Sign-in is phone-first: a one-time code proves the number, and that proof authorises
 * enrolling the device that asked. First sign-in creates the user, because Nigeria is
 * phone-first and a password would be another secret to breach for no benefit when the
 * phone is already the identifier.
 *
 * The OTP sender is bound through a port, and which implementation is bound is a deployment
 * decision rather than a code one. `none` — the default, and correct for a single-user
 * deployment (ADR-009) — disables phone sign-in altogether and is safe in production because
 * there is no code to leak. `log` prints the code and `parseEnv` refuses to start in production
 * while it is selected. A real SMS sender is only needed once there are users other than the
 * operator.
 */
@Module({
  controllers: [AuthController],
  providers: [
    DeviceAuthenticator,
    DeviceEnrolmentService,
    DeviceAuthGuard,
    PhoneAuthService,
    {
      provide: OTP_SENDER,
      inject: [ENV],
      useFactory: (env: Env): OtpSender =>
        env.OTP_SENDER === 'log' ? new LogOtpSender() : new DisabledOtpSender(),
    },
  ],
  exports: [DeviceAuthenticator, DeviceEnrolmentService, DeviceAuthGuard, PhoneAuthService],
})
export class IdentityModule {}
