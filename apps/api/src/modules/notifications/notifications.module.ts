import { Module } from '@nestjs/common';

/**
 * Notifications — push delivery and digest scheduling.
 *
 * Delivery only: content is produced by `intelligence`. Splitting them keeps
 * "what is worth telling the user" separate from "how it reaches their phone".
 *
 * Implementations land in M4.
 */
@Module({})
export class NotificationsModule {}
