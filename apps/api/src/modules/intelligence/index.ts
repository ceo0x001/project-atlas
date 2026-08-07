/**
 * Public surface of the intelligence context.
 */
export {
  RecurringDetectionService,
  type ShortfallProjection,
  type UpcomingObligation,
} from './application/recurring-detection.service';
export {
  type Cadence,
  detectRecurringSeries,
  type RecurringCandidate,
  type RecurringInput,
  type SeriesKind,
} from './domain/recurring/detect-recurring';
export { IntelligenceModule } from './intelligence.module';
