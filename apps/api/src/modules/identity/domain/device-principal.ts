import type { DeviceId, UserId } from '@atlas/shared-kernel';

/**
 * The authenticated caller of a device-facing endpoint.
 *
 * `role` matters beyond bookkeeping: only an Android ingestion node can legitimately
 * submit SMS-sourced observations (ADR-006), so the sync endpoint checks it rather
 * than trusting the payload's claim about where data came from.
 */
export type DeviceRole = 'CLIENT' | 'INGESTION_NODE' | 'CLIENT_AND_INGESTION_NODE';

export interface DevicePrincipal {
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly role: DeviceRole;
}

export function canIngest(role: DeviceRole): boolean {
  return role === 'INGESTION_NODE' || role === 'CLIENT_AND_INGESTION_NODE';
}
