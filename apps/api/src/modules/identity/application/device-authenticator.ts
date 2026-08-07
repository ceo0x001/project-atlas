import { Injectable } from '@nestjs/common';
import type { DeviceId, UserId } from '@atlas/shared-kernel';
import { PrismaService } from '@shared/prisma/prisma.service';
import { TenantScope } from '@shared/prisma/tenant-scope';
import type { DevicePrincipal, DeviceRole } from '../domain/device-principal';
import { hashDeviceToken } from '../domain/device-token';

/**
 * Resolves a bearer token to the device and user it belongs to.
 *
 * Deliberately two queries, in this order:
 *
 *   1. **Unscoped** lookup of `device_credentials`, the one table exempt from
 *      row-level security. It cannot be tenant-scoped because it is what determines
 *      the tenant — scoping it would require the answer it exists to produce.
 *
 *   2. **Tenant-scoped** lookup of the device itself, now that the user is known.
 *
 * The split is not incidental. An earlier version resolved both in one query by
 * joining `devices` from the credential row, which silently returned `null` for the
 * join: `devices` *is* under RLS, and no `atlas.user_id` had been set yet. The
 * invariant worth preserving is that the credential lookup is the only unscoped read
 * in the system, and everything after it — including reading the device — obeys
 * tenant isolation like any other query.
 */
@Injectable()
export class DeviceAuthenticator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantScope: TenantScope,
  ) {}

  async authenticate(token: string): Promise<DevicePrincipal | null> {
    const tokenHash = hashDeviceToken(token);

    const credential = await this.prisma.deviceCredential.findUnique({
      where: { tokenHash },
      select: { userId: true, deviceId: true, revokedAt: true },
    });

    if (!credential || credential.revokedAt !== null) return null;

    const userId = credential.userId as UserId;

    // A credential and its device can be revoked independently: rotating a token
    // should not require re-enrolling the device, and retiring a device should
    // invalidate every token it ever held.
    const device = await this.tenantScope.run(userId, (tx) =>
      tx.device.findUnique({
        where: { id: credential.deviceId },
        select: { role: true, revokedAt: true },
      }),
    );

    if (!device || device.revokedAt !== null) return null;

    // Fire-and-forget: a failed heartbeat must never fail an authenticated request.
    void this.prisma.deviceCredential
      .update({ where: { tokenHash }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return {
      userId,
      deviceId: credential.deviceId as DeviceId,
      role: device.role as DeviceRole,
    };
  }
}
