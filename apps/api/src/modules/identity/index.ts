export type { AuthenticatedRequest } from './api/device-auth.guard';
export { DeviceAuthGuard } from './api/device-auth.guard';
export { DeviceAuthenticator } from './application/device-authenticator';
export {
  DeviceEnrolmentService,
  type EnrolDeviceInput,
  type EnrolledDevice,
} from './application/device-enrolment.service';
export { canIngest, type DevicePrincipal, type DeviceRole } from './domain/device-principal';
export { IdentityModule } from './identity.module';
