import { Module } from '@nestjs/common';
import { IdentityModule } from '@modules/identity';
import { RecurringController } from './api/recurring.controller';
import { RecurringDetectionService } from './application/recurring-detection.service';

/**
 * Intelligence — patterns over the ledger, and the insights drawn from them.
 *
 * The rule this module exists to hold: **nothing here is inferred by a language model.** A rhythm
 * in a list of dates is arithmetic, and keeping it that way is what makes a bill something Atlas can
 * assert rather than merely suggest. The model's role comes later, choosing which of these facts is
 * worth mentioning and how to phrase it — never computing one.
 *
 * Depends on `identity` for the auth guard, which is the same cross-cutting exemption every module
 * with an HTTP surface uses.
 */
@Module({
  imports: [IdentityModule],
  controllers: [RecurringController],
  providers: [RecurringDetectionService],
  exports: [RecurringDetectionService],
})
export class IntelligenceModule {}
