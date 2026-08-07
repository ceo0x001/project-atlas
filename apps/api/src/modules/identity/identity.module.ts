import { Module } from '@nestjs/common';
import { AuthController } from './api/auth.controller';
import { DeviceAuthGuard } from './api/device-auth.guard';
import { DeviceAuthenticator } from './application/device-authenticator';
import { DeviceEnrolmentService } from './application/device-enrolment.service';
import { PhoneAuthService } from './application/phone-auth.service';
import { OTP_SENDER } from './domain/otp-sender.port';
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
 * The OTP sender is bound through a port so the flow could be built and tested before an
 * SMS gateway is chosen and paid for. Only a development implementation exists, and
 * `parseEnv` refuses to start in production while it is selected.
 */
@Module({
  controllers: [AuthController],
  providers: [
    DeviceAuthenticator,
    DeviceEnrolmentService,
    DeviceAuthGuard,
    PhoneAuthService,
    { provide: OTP_SENDER, useClass: LogOtpSender },
  ],
  exports: [DeviceAuthenticator, DeviceEnrolmentService, DeviceAuthGuard, PhoneAuthService],
})
export class IdentityModule {}
