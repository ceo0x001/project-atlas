import { Module } from '@nestjs/common';

/**
 * Memory — structured facts and episodic summaries.
 *
 * Retrieval is structured-first, semantic-second, and results are injected as tool
 * results so that memory obeys the same grounding gate as everything else. The
 * assistant may not state a remembered number it cannot point at.
 *
 * Implementations land in M2.
 */
@Module({})
export class MemoryModule {}
