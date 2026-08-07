import { Injectable } from '@nestjs/common';
import { type DeviceId, newId, type UserId } from '@atlas/shared-kernel';
import { TenantScope } from '@shared/prisma/tenant-scope';
import type { DeviceRole } from '../domain/device-principal';
import { issueDeviceToken } from '../domain/device-token';

/**
 * Registers a device and issues its bearer token.
 *
 * There is still deliberately **no HTTP endpoint** on this class, and there should not be:
 * it takes a `userId` directly, so exposing it would let anyone mint a credential for any
 * account. Enrolment reachable from the network goes through `PhoneAuthService`, which
 * derives the user from a verified one-time code rather than from the request body.
 *
 * This remains the seam for enrolling a device once identity is already established —
 * adding a second device from an authenticated session, or a test setting up a fixture.
 */

export interface EnrolDeviceInput {
  readonly userId: UserId;
  readonly platform: 'ANDROID' | 'IOS';
  readonly role: DeviceRole;
  readonly model?: string;
  readonly osVersion?: string;
  readonly appVersion?: string;
}

export interface EnrolledDevice {
  readonly deviceId: DeviceId;
  /** Plaintext token — returned once and never retrievable again. */
  readonly token: string;
}

@Injectable()
export class DeviceEnrolmentService {
  constructor(private readonly tenantScope: TenantScope) {}

  async enrol(input: EnrolDeviceInput): Promise<EnrolledDevice> {
    const deviceId = newId<'DeviceId'>();
    const { token, tokenHash } = issueDeviceToken();

    await this.tenantScope.run(input.userId, async (tx) => {
      await tx.device.create({
        data: {
          id: deviceId,
          userId: input.userId,
          platform: input.platform,
          role: input.role,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.osVersion === undefined ? {} : { osVersion: input.osVersion }),
          ...(input.appVersion === undefined ? {} : { appVersion: input.appVersion }),
        },
      });

      await tx.deviceCredential.create({
        data: { tokenHash, deviceId, userId: input.userId },
      });
    });

    return { deviceId, token };
  }

  /** Revokes a credential without unregistering the device, for token rotation. */
  async revokeCredential(userId: UserId, deviceId: DeviceId): Promise<void> {
    await this.tenantScope.run(userId, (tx) =>
      tx.deviceCredential.updateMany({
        where: { deviceId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }
}
