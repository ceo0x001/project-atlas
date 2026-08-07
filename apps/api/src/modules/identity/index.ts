export type { AuthenticatedRequest } from './api/device-auth.guard';
export { DeviceAuthGuard } from './api/device-auth.guard';
export { DeviceAuthenticator } from './application/device-authenticator';
export {
  DeviceEnrolmentService,
  type EnrolDeviceInput,
  type EnrolledDevice,
} from './application/device-enrolment.service';
export {
  PhoneAuthService,
  type StartSignInInput,
  type VerifySignInInput,
  type VerifySignInOutcome,
} from './application/phone-auth.service';
export { canIngest, type DevicePrincipal, type DeviceRole } from './domain/device-principal';
export { OTP_SENDER, type OtpDelivery, type OtpSender } from './domain/otp-sender.port';
export { IdentityModule } from './identity.module';
