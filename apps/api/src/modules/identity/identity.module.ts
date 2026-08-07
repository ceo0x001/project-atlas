import { Module } from '@nestjs/common';
import { DeviceAuthGuard } from './api/device-auth.guard';
import { DeviceAuthenticator } from './application/device-authenticator';
import { DeviceEnrolmentService } from './application/device-enrolment.service';

/**
 * Identity — users, devices, authentication and consent records.
 *
 * Consents are stored as timestamped, scoped records rather than booleans on the
 * user row: NDPR compliance needs an audit trail, and "when did they agree, to
 * what version of what policy" is not answerable from a flag.
 *
 * User authentication (passkeys plus OTP fallback) is still outstanding; what exists
 * today is device authentication, which is what the sync endpoint needs.
 */
@Module({
  providers: [DeviceAuthenticator, DeviceEnrolmentService, DeviceAuthGuard],
  exports: [DeviceAuthenticator, DeviceEnrolmentService, DeviceAuthGuard],
})
export class IdentityModule {}
