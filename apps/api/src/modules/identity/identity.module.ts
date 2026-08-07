import { Module } from '@nestjs/common';

/**
 * Identity — users, devices, authentication and consent records.
 *
 * Consents are stored as timestamped, scoped records rather than booleans on the
 * user row: NDPR compliance needs an audit trail, and "when did they agree, to
 * what version of what policy" is not answerable from a flag.
 *
 * Implementations land in M1.
 */
@Module({})
export class IdentityModule {}
